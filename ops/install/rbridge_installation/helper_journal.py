"""Create-only helper intent history survives death of its foreground launcher.

No reader repairs missing files or turns serialized settlement into permission.
Production entries originate only in a qualified Root launch. Cold settlement
also requires fresh kernel absence; Source filesystem fixtures are separate.
"""
import fcntl
import hashlib
import os
from pathlib import Path
import re
import secrets
import selectors
import time
from .artifact import _identity
from .ledger import _private,_strict_json,_write_exclusive
from .models import InstallationError,encode_report,report_sha256
from .protected_copy import DIR_FLAGS,FILE_FLAGS,FilesystemAuthority,ProtectedParent,_same


class HelperJournalError(InstallationError):pass

_active_journals={}


def _fail(reason):raise HelperJournalError(reason)


def _digest(value):return type(value) is str and re.fullmatch('[0-9a-f]{64}',value)


def _token(value):
    if (type(value) is not dict or set(value)!={'pid','ppid','session','start_ticks'}
            or any(type(value[k]) is not int or value[k]<2 for k in ('pid','ppid','session'))
            or value['session']!=value['pid'] or type(value['start_ticks']) is not str
            or not re.fullmatch('[1-9][0-9]*',value['start_ticks'])):_fail('HELPER_JOURNAL_IDENTITY_INVALID')


def _members(rows,parent):
    if type(rows) is not list or not 1<=len(rows)<=8:_fail('HELPER_JOURNAL_IDENTITY_INVALID')
    seen=set()
    for row in rows:
        if (type(row) is not dict or set(row)!={'pid','start_ticks'} or type(row['pid']) is not int
                or row['pid']<2 or row['pid'] in seen or type(row['start_ticks']) is not str
                or not re.fullmatch('[1-9][0-9]*',row['start_ticks'])
                or int(row['start_ticks'])<int(parent['start_ticks'])):_fail('HELPER_JOURNAL_IDENTITY_INVALID')
        seen.add(row['pid'])
    if rows!=sorted(rows,key=lambda r:r['pid']) or {'pid':parent['pid'],'start_ticks':parent['start_ticks']} not in rows:
        _fail('HELPER_JOURNAL_IDENTITY_INVALID')


def _boot_id():
    from .host_backend import _assert_kernel_namespace,_kernel_bytes
    _assert_kernel_namespace();raw=_kernel_bytes('/proc/sys/kernel/random/boot_id',128)
    if not re.fullmatch(rb'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\n',raw):_fail('HELPER_JOURNAL_KERNEL_UNKNOWN')
    return raw[:-1].decode('ascii')


def _read(fd,name,owner):
    handle=os.open(name,FILE_FLAGS,dir_fd=fd)
    try:
        before=os.fstat(handle);_private(before,owner)
        if before.st_size>262144:_fail('HELPER_JOURNAL_BYTE_LIMIT')
        raw=bytearray()
        while len(raw)<=before.st_size:
            chunk=os.read(handle,min(65536,before.st_size+1-len(raw)))
            if not chunk:break
            raw.extend(chunk)
        if (len(raw)!=before.st_size or _identity(before)!=_identity(os.fstat(handle))
                or _identity(before)!=_identity(os.stat(name,dir_fd=fd,follow_symlinks=False))):
            _fail('HELPER_JOURNAL_CHANGED')
        return bytes(raw),before
    finally:os.close(handle)


def _record(raw,keys,previous,ident,origin):
    value=_strict_json(raw)
    if (type(value) is not dict or set(value)!=keys|{'schema','journal_id','origin_scope','previous_sha256','sha256'}
            or value['schema']!='RBRIDGE_OWNED_HELPER_JOURNAL_V1' or value['journal_id']!=ident
            or value['origin_scope']!=origin or value['previous_sha256']!=previous
            or not _digest(value['sha256']) or encode_report(value)!=raw
            or report_sha256({k:v for k,v in value.items() if k!='sha256'})!=value['sha256']):
        _fail('HELPER_JOURNAL_CHAIN_INVALID')
    return value


def inspect_helper_journal(parent_fd,name,production=True):
    """Read a complete unlocked record. This alone grants no kernel authority."""
    owner=0 if production else os.getuid();fd=None;lock=None
    if type(name) is not str or not re.fullmatch('helper-[0-9a-f]{32}',name):_fail('HELPER_JOURNAL_NAME_INVALID')
    try:
        if production:
            from .host_backend import _assert_kernel_namespace
            if os.getuid()!=0 or os.geteuid()!=0:_fail('HELPER_JOURNAL_ROOT_REQUIRED')
            _assert_kernel_namespace()
        before=os.stat(name,dir_fd=parent_fd,follow_symlinks=False);_private(before,owner,True)
        fd=os.open(name,DIR_FLAGS,dir_fd=parent_fd)
        if _identity(before)!=_identity(os.fstat(fd)):_fail('HELPER_JOURNAL_CHANGED')
        names=sorted(os.listdir(fd))
        if names!=['intent.json','journal.lock','running.json','settled.json']:_fail('HELPER_JOURNAL_UNSETTLED')
        lock=os.open('journal.lock',FILE_FLAGS,dir_fd=fd);_private(os.fstat(lock),owner)
        lock_identity=os.fstat(lock)
        if lock_identity.st_size!=0:_fail('HELPER_JOURNAL_UNSETTLED')
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:_fail('HELPER_JOURNAL_UNSETTLED')
        raw,_=_read(fd,'intent.json',owner);byte_count=len(raw)
        origin='ROOT_FIXED_PROCESS_OBSERVATION' if production else 'FIXTURE_AUTHORITY_ONLY'
        intent=_record(raw,{'phase','boot_id','launch'},'0'*64,name[7:],origin)
        if (intent['phase']!='INTENT' or type(intent['boot_id']) is not str
                or not re.fullmatch('[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}',intent['boot_id'])):
            _fail('HELPER_JOURNAL_CHAIN_INVALID')
        _launch(intent['launch'])
        raw,_=_read(fd,'running.json',owner);byte_count+=len(raw)
        running=_record(raw,{'phase','process'},intent['sha256'],name[7:],origin)
        if running['phase']!='RUNNING':_fail('HELPER_JOURNAL_CHAIN_INVALID')
        _token(running['process'])
        raw,_=_read(fd,'settled.json',owner);byte_count+=len(raw)
        settled=_record(raw,{'phase','observed','settlement'},running['sha256'],name[7:],origin)
        if settled['phase']!='SETTLED' or settled['settlement']!='PIDFDS_READY_AND_SESSION_TWICE_EMPTY':
            _fail('HELPER_JOURNAL_CHAIN_INVALID')
        _members(settled['observed'],running['process'])
        if (names!=sorted(os.listdir(fd)) or _identity(before)!=_identity(os.fstat(fd))
                or _identity(before)!=_identity(os.stat(name,dir_fd=parent_fd,follow_symlinks=False))
                or _identity(lock_identity)!=_identity(os.stat('journal.lock',dir_fd=fd,follow_symlinks=False))):
            _fail('HELPER_JOURNAL_CHANGED')
        return {'name':name,'sha256':settled['sha256'],'origin_scope':origin,
            'boot_id':intent['boot_id'],'process':running['process'],'observed':settled['observed'],'record_bytes':byte_count}
    except (OSError,TypeError,KeyError,ValueError,UnicodeError):_fail('HELPER_JOURNAL_UNSETTLED')
    finally:
        if lock is not None:os.close(lock)
        if fd is not None:os.close(fd)


def _launch(value):
    if (type(value) is not dict or set(value)!={'argv','executable_sha256','input_sha256','child_specs_sha256'}
            or type(value['argv']) is not list or not value['argv'] or len(value['argv'])>128
            or any(type(v) is not str or '\0' in v or len(v)>65536 for v in value['argv'])
            or not value['argv'][0].startswith('/')
            or any(not _digest(value[k]) for k in value if k!='argv')
            or len(encode_report(value))>131072):_fail('HELPER_JOURNAL_LAUNCH_INVALID')


def assert_helper_kernel_absence(records):
    """Two complete actual kernel censuses; no supplied ACK or helper name kill."""
    if not records:return
    from .owned_process import _stat
    boot=_boot_id();sessions={r['process']['session'] for r in records if r['boot_id']==boot}
    identities={row['pid']:row['start_ticks'] for r in records if r['boot_id']==boot for row in r['observed']}
    deadline=time.monotonic()+30
    for _ in range(2):
        names=os.listdir('/proc')
        if len(names)>131072:_fail('HELPER_JOURNAL_KERNEL_UNKNOWN')
        for name in names:
            if not name.isascii() or not name.isdecimal() or int(name)<2:continue
            if time.monotonic()>=deadline:_fail('HELPER_JOURNAL_KERNEL_UNKNOWN')
            try:token=_stat(int(name))
            except FileNotFoundError:continue
            except (OSError,ValueError):_fail('HELPER_JOURNAL_KERNEL_UNKNOWN')
            if token['state']!='Z' and (token['session'] in sessions or identities.get(token['pid'])==token['start_ticks']):
                _fail('HELPER_JOURNAL_UNSETTLED')
        if _boot_id()!=boot:_fail('HELPER_JOURNAL_KERNEL_UNKNOWN')


class _HelperJournal:
    def __init__(self,parent_fd,ident,launch,production=False,guard=None):
        self.parent=os.dup(parent_fd);self.ident=ident;self.name='helper-'+ident
        self.owner=0 if production else os.getuid();self.production=production;self.guard=guard
        self.fd=None;self.lock=None;self.closed=False;self.poisoned=False;self.pins={};self.previous='0'*64;self.running=None
        try:
            if not re.fullmatch('[0-9a-f]{32}',ident):_fail('HELPER_JOURNAL_NAME_INVALID')
            _launch(launch);_private(os.fstat(self.parent),self.owner,True)
            if production:
                if type(guard) is not ProtectedParent or not guard.authority.production:_fail('HELPER_JOURNAL_ROOT_REQUIRED')
                guard.check();boot=_boot_id()
            else:boot='11111111-1111-1111-1111-111111111111'
            os.mkdir(self.name,0o700,dir_fd=self.parent);os.fsync(self.parent)
            self.fd=os.open(self.name,DIR_FLAGS,dir_fd=self.parent);self.directory=os.fstat(self.fd);_private(self.directory,self.owner,True)
            self.lock=os.open('journal.lock',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=self.fd)
            _private(os.fstat(self.lock),self.owner);fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            os.fsync(self.lock);self.pins['journal.lock']=os.fstat(self.lock)
            self._append('intent.json',{'phase':'INTENT','boot_id':boot,'launch':launch})
        except BaseException:
            # The caller still owns its ancestor guard until creation succeeds.
            self.guard=None;self.close();_fail('HELPER_JOURNAL_CREATION_UNCERTAIN')

    def _check(self):
        if self.closed or self.poisoned:_fail('HELPER_JOURNAL_UNSETTLED')
        if self.guard:self.guard.check()
        if (not _same(self.directory,os.fstat(self.fd)) or not _same(self.directory,os.stat(self.name,dir_fd=self.parent,follow_symlinks=False))
                or set(os.listdir(self.fd))!=set(self.pins)):_fail('HELPER_JOURNAL_CHANGED')
        for name,row in self.pins.items():
            if _identity(row)!=_identity(os.stat(name,dir_fd=self.fd,follow_symlinks=False)):_fail('HELPER_JOURNAL_CHANGED')

    def _append(self,name,body):
        self._check()
        value={'schema':'RBRIDGE_OWNED_HELPER_JOURNAL_V1','journal_id':self.ident,
            'origin_scope':'ROOT_FIXED_PROCESS_OBSERVATION' if self.production else 'FIXTURE_AUTHORITY_ONLY',
            'previous_sha256':self.previous,**body};value['sha256']=report_sha256(value);raw=encode_report(value)
        if len(raw)>262144:_fail('HELPER_JOURNAL_BYTE_LIMIT')
        try:
            _write_exclusive(self.fd,name,raw,self.owner);os.fsync(self.fd);os.fsync(self.parent)
            actual,row=_read(self.fd,name,self.owner)
            if actual!=raw:_fail('HELPER_JOURNAL_CHANGED')
            self.pins[name]=row;self.previous=value['sha256'];self._check()
        except BaseException:self.poisoned=True;raise

    def _running(self,token,observation=None):
        _token(token)
        if self.running is not None:_fail('HELPER_JOURNAL_SEQUENCE_INVALID')
        if self.production:
            from .owned_process import _stat
            _boot_id();actual=_stat(token['pid'])
            if {k:actual[k] for k in token}!=token or token['ppid']!=os.getpid():_fail('HELPER_JOURNAL_IDENTITY_INVALID')
            if not callable(observation):_fail('HELPER_JOURNAL_IDENTITY_INVALID')
            observation()
        self._append('running.json',{'phase':'RUNNING','process':token});self.running=dict(token)
        if self.production:_active_journals[self.name]=(self,os.getpid(),_boot_id(),observation)

    def _settled(self,rows,handles=None):
        if self.running is None:_fail('HELPER_JOURNAL_SEQUENCE_INVALID')
        _members(rows,self.running)
        if self.production:
            if type(handles) is not dict or set(handles)!={r['pid'] for r in rows}:_fail('HELPER_JOURNAL_IDENTITY_INVALID')
            poll=selectors.DefaultSelector()
            try:
                for handle in handles.values():poll.register(handle,selectors.EVENT_READ)
                if len(poll.select(0))!=len(handles):_fail('HELPER_JOURNAL_UNSETTLED')
            finally:poll.close()
            from .owned_process import _session_rows
            _boot_id();deadline=time.monotonic()+5
            if _session_rows(self.running['pid'],deadline) or _session_rows(self.running['pid'],deadline):
                _fail('HELPER_JOURNAL_UNSETTLED')
        self._append('settled.json',{'phase':'SETTLED','observed':rows,'settlement':'PIDFDS_READY_AND_SESSION_TWICE_EMPTY'})

    def close(self):
        if self.closed:return
        self.closed=True
        active=_active_journals.get(self.name)
        if active is not None and active[0] is self:_active_journals.pop(self.name)
        for fd in (self.lock,self.fd,self.parent):
            if fd is not None:os.close(fd)
        if self.guard:self.guard.close()


def _open_fixture_helper_journal(parent_fd,ident,launch):
    return _HelperJournal(parent_fd,ident,launch)


def _current_root_helper(parent_fd,name):
    """Only our live foreground Root producer can nest a fixed observation.

    This exception never applies to cold inventory or Source fixtures. The
    original producer freshly examines its complete held process family.
    """
    active=_active_journals.get(name)
    if active is None:return False
    journal,pid,boot,observation=active
    if (type(journal) is not _HelperJournal or not journal.production or pid!=os.getpid()
            or boot!=_boot_id() or journal.closed or journal.running is None
            or not _same(os.fstat(parent_fd),os.fstat(journal.parent))):_fail('HELPER_JOURNAL_UNSETTLED')
    journal._check();observation();journal._check();return True


def begin_root_helper(pin,args,input_bytes,child_specs):
    """Serialize only journal creation. Unfinished predecessors block Popen."""
    from .host_backend import _assert_kernel_namespace
    if os.getuid()!=0 or os.geteuid()!=0:_fail('HELPER_JOURNAL_ROOT_REQUIRED')
    _assert_kernel_namespace()
    guard=ProtectedParent(FilesystemAuthority(0,1027,Path('/var/lib/rbridge-maintenance'),'RUNTIME'))
    journal=None;locked=False
    try:
        _private(os.fstat(guard.fd),0,True)
        fcntl.flock(guard.fd,fcntl.LOCK_EX|fcntl.LOCK_NB);locked=True;guard.check()
        names=sorted(os.listdir(guard.fd))
        if len(names)>16384:_fail('HELPER_JOURNAL_ENTRY_LIMIT')
        records=[inspect_helper_journal(guard.fd,n) for n in names
            if n.startswith('helper-') and not _current_root_helper(guard.fd,n)]
        if sum(r['record_bytes'] for r in records)>67108864:_fail('HELPER_JOURNAL_BYTE_LIMIT')
        assert_helper_kernel_absence(records)
        if names!=sorted(os.listdir(guard.fd)):_fail('HELPER_JOURNAL_CHANGED')
        launch={'argv':[pin.path,*args],'executable_sha256':pin.sha256,
            'input_sha256':hashlib.sha256(input_bytes).hexdigest(),'child_specs_sha256':report_sha256(child_specs)}
        journal=_HelperJournal(guard.fd,secrets.token_hex(16),launch,True,guard)
        return journal
    except (OSError,TypeError,ValueError,UnicodeError):_fail('HELPER_JOURNAL_UNSETTLED')
    finally:
        if locked:fcntl.flock(guard.fd,fcntl.LOCK_UN)
        if journal is None:guard.close()
