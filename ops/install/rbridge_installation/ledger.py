"""Persistent, private intent chain. Reading never repairs or deletes evidence."""
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime,timezone
from pathlib import Path
from types import MappingProxyType
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
from .artifact import _identity
from .models import InstallationError,encode_report,report_sha256
from .protected_copy import ProtectedParent,FilesystemAuthority,DIR_FLAGS,FILE_FLAGS

class LedgerError(InstallationError):pass
MARKERS=('QUALIFIED','STAGED','PAUSE_INTENT','PAUSED','BACKUP_COMPLETE','GATES_PASS','CONFIG_INTENT','CONFIG_INSTALLED','POINTER_INTENT','POINTER_SWITCHED','START_ATTEMPTED','NEW_STARTED','ACCEPTING','ACCEPTED')
TERMINALS=('ROLLED_BACK','ROLLBACK_BLOCKED','ROLLBACK_BLOCKED_START_ATTEMPTED')
DIGEST_KEYS=frozenset(('profile_sha256','runtime_manifest_sha256','toolkit_manifest_sha256','readers_sha256','service_identity_sha256','config_sha256','pointer_sha256','snapshot_sha256','pause_sha256','backup_sha256','gates_sha256','invocation_sha256','owned_additions_sha256','before_config_sha256','after_config_sha256','before_pointer_sha256','after_pointer_sha256'))

@dataclass(frozen=True)
class LedgerEntry:
    sequence:int
    previous_sha256:str
    marker:str
    created_at:str
    evidence:Mapping
    sha256:str

@dataclass(frozen=True)
class LedgerSnapshot:
    transaction_id:str
    entries:tuple
    sha256:str

@dataclass(frozen=True)
class ObservedTransactionState:
    pointer_sha256:str
    config_sha256:str
    service_identity_sha256:str
    snapshot_sha256:str
    owned_additions_sha256:str
    service_settled:bool
    writers_excluded:bool
    fresh_gate_status:str
    fresh_gate_snapshot_sha256:str

@dataclass(frozen=True)
class RecoveryDecision:
    action:str
    may_start_old:bool
    reason_codes:tuple

def _evidence(value):
    if not isinstance(value,Mapping) or len(value)>32 or set(value)-DIGEST_KEYS-{'reason_codes'}:raise LedgerError('LEDGER_EVIDENCE_INVALID')
    out={}
    for key,val in value.items():
        if key in DIGEST_KEYS:
            if type(val)!=str or not re.fullmatch('[0-9a-f]{64}',val):raise LedgerError('LEDGER_EVIDENCE_INVALID')
            out[key]=val
        else:
            if type(val) not in (list,tuple) or len(val)>32 or any(type(v)!=str or not re.fullmatch('[A-Z][A-Z0-9_]{0,95}',v) for v in val):raise LedgerError('LEDGER_EVIDENCE_INVALID')
            out[key]=list(val)
    return out

def _transition(previous,marker,entries):
    if previous in TERMINALS or previous=='ACCEPTED':raise LedgerError('LEDGER_SEQUENCE_INVALID')
    if marker in TERMINALS:
        started=any(e['marker']=='START_ATTEMPTED' for e in entries)
        if not previous or previous in TERMINALS or previous=='ACCEPTED' or (started and marker!='ROLLBACK_BLOCKED_START_ATTEMPTED') or (not started and marker=='ROLLBACK_BLOCKED_START_ATTEMPTED'):raise LedgerError('LEDGER_SEQUENCE_INVALID')
    elif marker not in MARKERS or MARKERS.index(marker)!=(MARKERS.index(previous)+1 if previous in MARKERS else 0):raise LedgerError('LEDGER_SEQUENCE_INVALID')

def _strict_json(raw):
    def pairs(rows):
        out={}
        for key,val in rows:
            if key in out:raise LedgerError('LEDGER_FIELDS_INVALID')
            out[key]=val
        return out
    try:return json.loads(raw,object_pairs_hook=pairs)
    except (ValueError,UnicodeError,RecursionError):raise LedgerError('LEDGER_JSON_INVALID') from None

def _decode(raw,transaction_id):
    data=_strict_json(raw)
    if type(data)!=dict or set(data)!={'schema','transaction_id','entries','sha256'} or data['schema']!='RBRIDGE_INSTALL_LEDGER_V1' or data['transaction_id']!=transaction_id or type(data['entries'])!=list or len(data['entries'])>128:raise LedgerError('LEDGER_FIELDS_INVALID')
    base={k:v for k,v in data.items() if k!='sha256'}
    try:
        if report_sha256(base)!=data['sha256'] or encode_report(data)!=raw:raise LedgerError('LEDGER_DIGEST_INVALID')
    except (ValueError,TypeError):raise LedgerError('LEDGER_DIGEST_INVALID') from None
    previous='0'*64;marker=None;accepted=[]
    for i,e in enumerate(data['entries']):
        if type(e)!=dict or set(e)!={'sequence','previous_sha256','marker','created_at','evidence','sha256'} or type(e['sequence'])!=int or e['sequence']!=i+1 or e['previous_sha256']!=previous or type(e['marker'])!=str:raise LedgerError('LEDGER_SEQUENCE_INVALID')
        if type(e['created_at'])!=str or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z',e['created_at']):raise LedgerError('LEDGER_TIMESTAMP_INVALID')
        try:datetime.fromisoformat(e['created_at'])
        except ValueError:raise LedgerError('LEDGER_TIMESTAMP_INVALID') from None
        _evidence(e['evidence']);_transition(marker,e['marker'],accepted)
        if report_sha256({k:v for k,v in e.items() if k!='sha256'})!=e['sha256']:raise LedgerError('LEDGER_DIGEST_INVALID')
        accepted.append(e);previous=e['sha256'];marker=e['marker']
    return data

def _private(s,uid,directory=False):
    if s.st_uid!=uid or s.st_mode&0o7777!=(0o700 if directory else 0o600) or (not directory and (not stat.S_ISREG(s.st_mode) or s.st_nlink!=1)) or (directory and not stat.S_ISDIR(s.st_mode)):raise LedgerError('LEDGER_OWNERSHIP_INVALID')

def _write_exclusive(fd,name,raw,uid):
    handle=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=fd)
    try:
        _private(os.fstat(handle),uid)
        view=memoryview(raw)
        while view:
            n=os.write(handle,view)
            if n<=0:raise LedgerError('LEDGER_WRITE_FAILED')
            view=view[n:]
        os.fsync(handle)
    finally:os.close(handle)

class Ledger:
    def __init__(self,parent_fd,transaction_id,uid,guard=None):
        self.parent_fd=os.dup(parent_fd);self.transaction_id=transaction_id;self.uid=uid;self.guard=guard
        self.fd=None;self.lock_fd=None;self.closed=False;self.poisoned=False;self.head_identity=None;self.head_digest=None
        if type(transaction_id)!=str or not re.fullmatch('[0-9a-f]{32}',transaction_id):self.close();raise LedgerError('LEDGER_TRANSACTION_INVALID')
        try:
            _private(os.fstat(self.parent_fd),uid,True)
            created=False
            try:os.mkdir(transaction_id,0o700,dir_fd=self.parent_fd);created=True;os.fsync(self.parent_fd)
            except FileExistsError:pass
            self.fd=os.open(transaction_id,DIR_FLAGS,dir_fd=self.parent_fd);self.directory_identity=os.fstat(self.fd);_private(self.directory_identity,uid,True)
            flags=os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC
            if created:
                self.lock_fd=os.open('ledger.lock',flags|os.O_CREAT|os.O_EXCL,0o600,dir_fd=self.fd);os.fsync(self.lock_fd);os.fsync(self.fd)
            else:self.lock_fd=os.open('ledger.lock',flags,dir_fd=self.fd)
            self.lock_identity=os.fstat(self.lock_fd);_private(self.lock_identity,uid)
            try:fcntl.flock(self.lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except OSError:raise LedgerError('LEDGER_ALREADY_OPEN') from None
            if created:
                base={'schema':'RBRIDGE_INSTALL_LEDGER_V1','transaction_id':transaction_id,'entries':[]}
                _write_exclusive(self.fd,'ledger.json',encode_report({**base,'sha256':report_sha256(base)}),uid);os.fsync(self.fd)
            self._check()
        except (OSError,InstallationError):self.close();raise LedgerError('LEDGER_OPEN_FAILED') from None
    def _check(self):
        if self.closed or self.fd is None or self.lock_fd is None:raise LedgerError('LEDGER_CLOSED')
        if self.guard:self.guard.check()
        _private(os.fstat(self.parent_fd),self.uid,True)
        named=os.stat(self.transaction_id,dir_fd=self.parent_fd,follow_symlinks=False);current=os.fstat(self.fd)
        _private(named,self.uid,True);_private(current,self.uid,True)
        if (named.st_dev,named.st_ino)!=(current.st_dev,current.st_ino) or (current.st_dev,current.st_ino)!=(self.directory_identity.st_dev,self.directory_identity.st_ino):raise LedgerError('LEDGER_DIRECTORY_CHANGED')
        lock=os.stat('ledger.lock',dir_fd=self.fd,follow_symlinks=False)
        if _identity(lock)!=_identity(self.lock_identity) or _identity(os.fstat(self.lock_fd))!=_identity(self.lock_identity):raise LedgerError('LEDGER_LOCK_CHANGED')
    def _read(self):
        self._check()
        if self.poisoned:raise LedgerError('LEDGER_FSYNC_UNCERTAIN')
        if set(os.listdir(self.fd))!={'ledger.lock','ledger.json'}:raise LedgerError('LEDGER_PENDING_OR_UNKNOWN_OBJECT')
        handle=os.open('ledger.json',FILE_FLAGS,dir_fd=self.fd)
        try:
            before=os.fstat(handle);_private(before,self.uid)
            if before.st_size>8388608:raise LedgerError('LEDGER_BYTE_LIMIT')
            raw=bytearray()
            while len(raw)<=8388608:
                chunk=os.read(handle,min(1048576,8388609-len(raw)))
                if not chunk:break
                raw.extend(chunk)
            if len(raw)!=before.st_size or _identity(before)!=_identity(os.fstat(handle)) or _identity(before)!=_identity(os.stat('ledger.json',dir_fd=self.fd,follow_symlinks=False)):raise LedgerError('LEDGER_CHANGED')
        finally:os.close(handle)
        digest=hashlib.sha256(raw).hexdigest()
        if self.head_identity is not None and (self.head_identity!=_identity(before) or self.head_digest!=digest):raise LedgerError('LEDGER_CHANGED')
        data=_decode(bytes(raw),self.transaction_id);self.head_identity=_identity(before);self.head_digest=digest;return data
    def read(self):
        try:
            d=self._read()
            entries=tuple(LedgerEntry(**{**e,'evidence':MappingProxyType({k:tuple(v) if type(v)==list else v for k,v in e['evidence'].items()})}) for e in d['entries'])
            return LedgerSnapshot(d['transaction_id'],entries,d['sha256'])
        except OSError:raise LedgerError('LEDGER_READ_FAILED') from None
    def append(self,marker:str,evidence:Mapping):
        temporary=None
        try:
            d=self._read();_transition(d['entries'][-1]['marker'] if d['entries'] else None,marker,d['entries'])
            if len(d['entries'])>=128:raise LedgerError('LEDGER_SEQUENCE_LIMIT')
            entry={'sequence':len(d['entries'])+1,'previous_sha256':d['entries'][-1]['sha256'] if d['entries'] else '0'*64,'marker':marker,'created_at':datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z'),'evidence':_evidence(evidence)}
            entry['sha256']=report_sha256(entry)
            base={'schema':d['schema'],'transaction_id':self.transaction_id,'entries':d['entries']+[entry]}
            raw=encode_report({**base,'sha256':report_sha256(base)})
            if len(raw)>8388608:raise LedgerError('LEDGER_BYTE_LIMIT')
            _write_exclusive(self.fd,'pending.json',encode_report(entry),self.uid);os.fsync(self.fd)
            temporary='.ledger-'+secrets.token_hex(16)+'.tmp';_write_exclusive(self.fd,temporary,raw,self.uid)
            self._check()
            if _identity(os.stat('ledger.json',dir_fd=self.fd,follow_symlinks=False))!=self.head_identity:raise LedgerError('LEDGER_CHANGED')
            os.replace(temporary,'ledger.json',src_dir_fd=self.fd,dst_dir_fd=self.fd);os.fsync(self.fd)
            self.head_identity=_identity(os.stat('ledger.json',dir_fd=self.fd,follow_symlinks=False));self.head_digest=hashlib.sha256(raw).hexdigest()
            os.unlink('pending.json',dir_fd=self.fd);os.fsync(self.fd);self._check()
            return self.read().entries[-1]
        except OSError:self.poisoned=True;raise LedgerError('LEDGER_FSYNC_OR_WRITE_UNCERTAIN') from None
        # Deliberately retain pending/tmp evidence on every failure, including EXIT.
    def close(self):
        if self.closed:return
        self.closed=True
        for fd in (self.lock_fd,self.fd,self.parent_fd):
            if fd is not None:os.close(fd)
        if self.guard:self.guard.close()

def open_ledger(parent_fd:int,transaction_id:str)->Ledger:
    if os.getuid()!=0 or os.geteuid()!=0:raise LedgerError('LEDGER_ROOT_REQUIRED')
    try:
        guard=ProtectedParent(FilesystemAuthority(0,1027,Path('/var/lib/rbridge-maintenance'),'RUNTIME'),parent_fd)
        return Ledger(parent_fd,transaction_id,0,guard)
    except (OSError,InstallationError):raise LedgerError('LEDGER_PARENT_UNPROTECTED') from None

def _open_fixture_ledger(parent_fd:int,transaction_id:str)->Ledger:
    """Explicit test authority; does not qualify a root deployment ledger."""
    return Ledger(parent_fd,transaction_id,os.getuid())

def recovery_decision(ledger:LedgerSnapshot,observed:ObservedTransactionState)->RecoveryDecision:
    # The caller supplies fresh qualified observations; actions still require CAS.
    try:
        entries=[{'sequence':e.sequence,'previous_sha256':e.previous_sha256,'marker':e.marker,'created_at':e.created_at,'evidence':_evidence(e.evidence),'sha256':e.sha256} for e in ledger.entries]
        _decode(encode_report({'schema':'RBRIDGE_INSTALL_LEDGER_V1','transaction_id':ledger.transaction_id,'entries':entries,'sha256':ledger.sha256}),ledger.transaction_id)
    except (InstallationError,ValueError,TypeError,AttributeError):return RecoveryDecision('BLOCKED_DRIFT',False,('LEDGER_CHAIN_INVALID',))
    if any(e.marker=='START_ATTEMPTED' for e in ledger.entries):return RecoveryDecision('HOLD_POST_START',False,('START_ATTEMPTED_PRESERVED',))
    if not ledger.entries:return RecoveryDecision('BLOCKED_DRIFT',False,('LEDGER_QUALIFICATION_MISSING',))
    if observed.service_settled is not True or observed.writers_excluded is not True:return RecoveryDecision('HOLD_UNSETTLED',False,('WRITERS_OR_SERVICE_UNSETTLED',))
    expected={}
    for entry in ledger.entries:
        for key,val in entry.evidence.items():
            if key in DIGEST_KEYS:expected[key]=val
    for key in ('pointer_sha256','config_sha256','service_identity_sha256','snapshot_sha256','owned_additions_sha256'):
        actual=getattr(observed,key)
        candidates={expected.get(key)}
        prefix=key.removesuffix('_sha256')
        if key in ('config_sha256','pointer_sha256'):
            for side in ('before','after'):
                if side+'_'+prefix+'_sha256' in expected:candidates.add(expected[side+'_'+prefix+'_sha256'])
        if type(actual)!=str or not re.fullmatch('[0-9a-f]{64}',actual) or actual not in candidates:return RecoveryDecision('BLOCKED_DRIFT',False,('OBSERVED_IDENTITY_DRIFT',))
    if observed.fresh_gate_status!='PASS' or observed.fresh_gate_snapshot_sha256!=observed.snapshot_sha256:return RecoveryDecision('BLOCKED_DRIFT',False,('FRESH_OFFLINE_COMPATIBILITY_REQUIRED',))
    if ledger.entries[-1].marker in TERMINALS:return RecoveryDecision('BLOCKED_DRIFT',False,('LEDGER_ALREADY_TERMINAL',))
    restoring=any(e.marker in ('CONFIG_INTENT','POINTER_INTENT') for e in ledger.entries)
    return RecoveryDecision('RESTORE_OWNED_PRE_START' if restoring else 'CONTINUE_PRE_START',restoring,())
