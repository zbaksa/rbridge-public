"""Owned additions and descriptor-held pointer exchange during maintained pause.

No start action, environment sourcing, blanket file replacement or EXIT recovery.
Unknown reload/rename/fsync outcomes retain their intent and private evidence.
"""
from dataclasses import dataclass,field,replace
from datetime import datetime,timezone
from pathlib import Path
from types import MappingProxyType
import ctypes
import hashlib
import os
import re
import secrets
import shlex
import stat
import weakref
from .artifact import _identity
from .models import ConfigError,InstallationError,report_sha256
from .protected_copy import ProtectedParent,FilesystemAuthority,PublishedArtifact,verify_published,DIR_FLAGS,FILE_FLAGS
from .pause_backup import PauseLease,capture_snapshot
from .ledger import Ledger,ObservedTransactionState,recovery_decision

_sessions=weakref.WeakSet();_pointers=weakref.WeakSet()
_dynamic={'ControlGroup','MainPID','ActiveState','SubState','InvocationID'}
_binding_keys=('RBRIDGE_MCP_PRINCIPAL_ID','RBRIDGE_INSTANCE_ID','RBRIDGE_RELEASE_SHA','COCWIN_REMOTE_BRIDGE_RELEASE_SHA')

@dataclass(frozen=True)
class FilePin:
    path:str
    sha256:str
    identity:tuple
    mode:int
    uid:int

@dataclass(frozen=True)
class OwnedConfigChange:
    scope:str
    before_sha256:str
    after_sha256:str
    before_pointer_sha256:str
    owned_additions_sha256:str
    files:tuple
    session:object=field(repr=False,compare=False)

@dataclass(frozen=True)
class OwnedPointerChange:
    scope:str
    before_sha256:str
    after_sha256:str
    before_target:str
    after_target:str
    session:object=field(repr=False,compare=False)

@dataclass(frozen=True)
class OwnedChanges:
    config:OwnedConfigChange
    pointer:OwnedPointerChange|None=None

@dataclass(frozen=True)
class RestoreProof:
    scope:str
    status:str
    may_start_old:bool
    config_sha256:str
    pointer_sha256:str

def _qualified(profile,lease,ledger,backend):
    if type(lease) is not PauseLease or type(ledger) is not Ledger or lease.ledger is not ledger or lease.backend is not backend or report_sha256(lease.profile)!=report_sha256(profile):raise ConfigError('CONFIG_CONTEXT_UNQUALIFIED')
    scope=getattr(backend,'scope',None)
    if scope=='QUALIFIED_HOST_PAUSE':
        from .host_backend import QualifiedHostBackend
        if type(backend) is not QualifiedHostBackend or os.getuid()!=0 or os.geteuid()!=0 or profile.binding.uid!=1027:raise ConfigError('CONFIG_HOST_UNQUALIFIED')
        if profile.paths.binding_env!='/etc/rbridge/p2a-binding.env' or profile.paths.binding_dropin!='/etc/systemd/system/rbridge.service.d/60-p2a-binding.conf':raise ConfigError('CONFIG_PATH_NOT_APPROVED')
    elif scope!='FIXTURE_AUTHORITY_ONLY':raise ConfigError('CONFIG_HOST_UNQUALIFIED')
    if lease.scope!=scope:raise ConfigError('CONFIG_HOST_UNQUALIFIED')
    return scope

def _guard(path,scope):
    return ProtectedParent(FilesystemAuthority(os.getuid(),1027,Path(path).parent,'RUNTIME',production=scope=='QUALIFIED_HOST_PAUSE'))

def _read_pin(path,scope,mode=None):
    guard=_guard(path,scope)
    try:
        fd=os.open(Path(path).name,FILE_FLAGS,dir_fd=guard.fd)
        try:
            s=os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_nlink!=1 or s.st_mode&0o6022 or s.st_size>1048576 or (mode is not None and s.st_mode&0o7777!=mode):raise ConfigError('CONFIG_FILE_UNPROTECTED')
            parts=[];size=0
            while True:
                chunk=os.read(fd,65536)
                if not chunk:break
                size+=len(chunk)
                if size>s.st_size:raise ConfigError('CONFIG_FILE_CHANGED')
                parts.append(chunk)
            if size!=s.st_size or _identity(s)!=_identity(os.fstat(fd)) or _identity(s)!=_identity(os.stat(Path(path).name,dir_fd=guard.fd,follow_symlinks=False)):raise ConfigError('CONFIG_FILE_CHANGED')
            guard.check();data=b''.join(parts)
            return FilePin(str(path),hashlib.sha256(data).hexdigest(),tuple(map(str,_identity(s))),s.st_mode&0o7777,s.st_uid)
        finally:os.close(fd)
    finally:guard.close()

def _file_matches(pin,scope):
    if _read_pin(pin.path,scope,pin.mode)!=pin:raise ConfigError('CONFIG_FILE_CHANGED')

def _stable(rows):
    from .host_backend import normalize_exec_start
    result={k:v for k,v in rows.items() if k not in _dynamic};result['ExecStart']=normalize_exec_start(rows['ExecStart']);return result

def _pointer(fd,name,owner):
    s=os.stat(name,dir_fd=fd,follow_symlinks=False)
    if not stat.S_ISLNK(s.st_mode) or s.st_uid!=owner or s.st_nlink!=1:raise ConfigError('POINTER_UNQUALIFIED')
    target=os.readlink(name,dir_fd=fd)
    if _identity(s)!=_identity(os.stat(name,dir_fd=fd,follow_symlinks=False)):raise ConfigError('POINTER_CHANGED')
    digest=report_sha256({'target':target,'identity':list(map(str,_identity(s)))})
    return target,_identity(s),digest

def _same_exchanged(actual,expected):
    # Only our observed exchange may change ctime; pin the fresh complete identity.
    return actual[0]==expected[0] and actual[1][:-1]==expected[1][:-1]

def _write_new(guard,path,data,mode):
    guard.check();name=Path(path).name
    fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=guard.fd)
    try:
        os.fchmod(fd,mode);view=memoryview(data)
        while view:
            n=os.write(fd,view)
            if n<=0:raise ConfigError('CONFIG_WRITE_FAILED')
            view=view[n:]
        os.fsync(fd)
    finally:os.close(fd)
    os.fsync(guard.fd);guard.check()

class _OwnedConfiguration:
    def __init__(self,profile,lease,ledger,backend,scope,resuming=False):
        self.profile=profile;self.lease=lease;self.ledger=ledger;self.backend=backend;self.scope=scope;self.created={};self.removed=set();self.loading=False;self.committed=False;self.restoring=False;self.closed=False
        rows=backend._show(profile.service.unit)
        if resuming:
            paths=shlex.split(rows['DropInPaths']);env=' '.join(e.path+' (ignore_errors=no)' for e in profile.service.environment_files)
            if paths.count(profile.paths.binding_dropin)!=1 or rows['EnvironmentFiles']!=env+' '+profile.paths.binding_env+' (ignore_errors=no)':raise ConfigError('CONFIG_RESUME_OVERLAY_UNQUALIFIED')
            rows={**rows,'DropInPaths':' '.join(shlex.quote(p) for p in paths if p!=profile.paths.binding_dropin),'EnvironmentFiles':env}
            if scope=='QUALIFIED_HOST_PAUSE' and report_sha256(backend._config(rows))!=profile.service.identity_sha256:raise ConfigError('CONFIG_RESUME_BASELINE_CHANGED')
        self.before=MappingProxyType(rows);self.originals=[]
        from .host_backend import PROPERTIES
        if set(self.before)!=set(PROPERTIES) or len(profile.service.environment_files)!=2:raise ConfigError('CONFIG_SERVICE_FIELDS_UNCLASSIFIED')
        if any(v.split('=',1)[0] in _binding_keys for v in shlex.split(self.before.get('UnsetEnvironment',''))):raise ConfigError('CONFIG_BINDING_UNSET')
        paths=shlex.split(self.before['DropInPaths'])
        if len(paths)>32 or len(set(paths))!=len(paths) or len({Path(p).name for p in paths})!=len(paths) or Path(profile.paths.binding_dropin).name in {Path(p).name for p in paths}:raise ConfigError('CONFIG_DROPINS_UNCLASSIFIED')
        env=' '.join(e.path+' (ignore_errors=no)' for e in profile.service.environment_files)
        if self.before['EnvironmentFiles']!=env:raise ConfigError('CONFIG_ENVIRONMENT_ORDER_CHANGED')
        fragment=_read_pin(self.before['FragmentPath'],scope);drops=[_read_pin(path,scope) for path in paths]
        if report_sha256({'fragment':{'path':fragment.path,'sha256':fragment.sha256},'dropins':[{'path':p.path,'sha256':p.sha256} for p in drops]})!=profile.service.dropins_sha256:raise ConfigError('CONFIG_ORIGINAL_DROPINS_CHANGED')
        self.originals=[fragment,*drops]
        for expected in profile.service.environment_files:
            pin=_read_pin(expected.path,scope)
            if pin.sha256!=expected.sha256:raise ConfigError('CONFIG_ORIGINAL_ENVIRONMENT_CHANGED')
            self.originals.append(pin)
        self.after={**self.before,'EnvironmentFiles':env+' '+profile.paths.binding_env+' (ignore_errors=no)','DropInPaths':' '.join(shlex.quote(p) for p in sorted([*paths,profile.paths.binding_dropin],key=lambda p:Path(p).name.encode('utf-8')))}
        self.before_sha256=report_sha256({'rows':_stable(self.before),'files':[vars(p) for p in self.originals]})
        self.guards={}
        try:
            for p in (profile.paths.binding_env,profile.paths.binding_dropin):self.guards[p]=_guard(p,scope)
            for p,g in self.guards.items():
                try:os.stat(Path(p).name,dir_fd=g.fd,follow_symlinks=False)
                except FileNotFoundError:pass
                else:
                    if not resuming:raise ConfigError('CONFIG_UNOWNED_PATH_EXISTS')
        except BaseException:
            self.close();raise
        principal=profile.binding.principal_id;target=profile.binding.target_instance_id;source=profile.runtime.source_sha
        if any(not isinstance(v,str) or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-' for c in v) for v in (principal,target,source)):self.close();raise ConfigError('CONFIG_BINDING_INVALID')
        self.payloads={profile.paths.binding_env:('\n'.join(k+'='+v for k,v in zip(_binding_keys,(principal,target,source,source)))+'\n').encode(),profile.paths.binding_dropin:('[Service]\nEnvironmentFile='+profile.paths.binding_env+'\n').encode()}
        self.modes={profile.paths.binding_env:0o600,profile.paths.binding_dropin:0o644}
        self.owned_additions_sha256=report_sha256([{'path':p,'mode':self.modes[p],'uid':os.getuid(),'sha256':hashlib.sha256(data).hexdigest()} for p,data in self.payloads.items()])
        _sessions.add(self)
    def normalize(self,backend,rows):
        if self not in _sessions or self.closed or backend is not self.backend or getattr(backend,'owned_configuration',None) is not self:raise ConfigError('CONFIG_SESSION_UNQUALIFIED')
        for guard in self.guards.values():guard.check()
        for pin in self.originals:_file_matches(pin,self.scope)
        for p,pin in self.created.items():
            if p in self.removed:
                try:os.stat(Path(p).name,dir_fd=self.guards[p].fd,follow_symlinks=False)
                except FileNotFoundError:continue
                raise ConfigError('CONFIG_FILE_CHANGED')
            _file_matches(pin,self.scope)
        valid_before=_stable(rows)==_stable(self.before);valid_after=_stable(rows)==_stable(self.after)
        if self.committed and not self.restoring:
            if not valid_after:raise ConfigError('CONFIG_EFFECTIVE_SETTINGS_CHANGED')
        elif not valid_before and not ((self.loading or self.restoring) and valid_after):raise ConfigError('CONFIG_EFFECTIVE_SETTINGS_CHANGED')
        return {**rows,**{k:v for k,v in self.before.items() if k not in _dynamic}}
    def observed(self,loaded=True):
        rows=self.backend._show(self.profile.service.unit);self.normalize(self.backend,rows)
        expected=self.before if self.restoring else self.after if loaded else self.before
        if _stable(rows)!=_stable(expected):raise ConfigError('CONFIG_RELOAD_UNCONFIRMED')
        return report_sha256({'rows':_stable(rows),'files':[vars(p) for p in self.originals]+[vars(p) for name,p in self.created.items() if name not in self.removed]})
    def close(self):
        self.closed=True
        for guard in getattr(self,'guards',{}).values():guard.close()
        self.guards={}

def normalize_owned_rows(backend,rows):
    """Qualified backend's logical pause identity remains the preserved baseline.

    The exact observed overlay and every owned/original inode are checked first.
    An arbitrary callback or scope string cannot register an overlay.
    """
    session=getattr(backend,'owned_configuration',None)
    if session is None:return dict(rows)
    if type(session) is not _OwnedConfiguration:raise ConfigError('CONFIG_SESSION_UNQUALIFIED')
    return session.normalize(backend,rows)

def install_configuration(profile,lease,ledger,backend):
    session=None
    try:
        scope=_qualified(profile,lease,ledger,backend);lease.check()
        if getattr(backend,'owned_configuration',None) is not None:raise ConfigError('CONFIG_ALREADY_REGISTERED')
        session=_OwnedConfiguration(profile,lease,ledger,backend,scope)
        guard=_guard(profile.paths.current_link,scope)
        try:before_pointer=_pointer(guard.fd,Path(profile.paths.current_link).name,os.getuid())[2];guard.check()
        finally:guard.close()
        ledger.append('CONFIG_INTENT',{'before_config_sha256':session.before_sha256,'config_sha256':session.before_sha256,'before_pointer_sha256':before_pointer,'pointer_sha256':before_pointer,'owned_additions_sha256':session.owned_additions_sha256,'service_identity_sha256':profile.service.identity_sha256})
        backend.owned_configuration=session
        for p,data in session.payloads.items():
            lease.check();_write_new(session.guards[p],p,data,session.modes[p]);pin=_read_pin(p,scope,session.modes[p])
            if pin.sha256!=hashlib.sha256(data).hexdigest():raise ConfigError('CONFIG_WRITE_CHANGED')
            session.created[p]=pin
        lease.check();session.loading=True;backend.reload_configuration();after=session.observed();session.committed=True;lease.check()
        ledger.append('CONFIG_INSTALLED',{'after_config_sha256':after,'config_sha256':after,'owned_additions_sha256':session.owned_additions_sha256})
        return OwnedConfigChange(scope,session.before_sha256,after,before_pointer,session.owned_additions_sha256,tuple(session.created.values()),session)
    except (OSError,InstallationError,ValueError) as error:
        if session is not None and getattr(backend,'owned_configuration',None) is not session:session.close()
        if isinstance(error,ConfigError):raise
        raise ConfigError('CONFIG_INSTALLATION_UNCERTAIN') from None

def _exchange(fd,left,right):
    libc=ctypes.CDLL(None,use_errno=True)
    try:rename=libc.renameat2
    except AttributeError:raise ConfigError('POINTER_EXCHANGE_UNSUPPORTED') from None
    rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
    if rename(fd,os.fsencode(left),fd,os.fsencode(right),2):raise ConfigError('POINTER_EXCHANGE_FAILED')

class _OwnedPointer:
    def __init__(self,profile,lease,ledger,scope):
        self.profile=profile;self.lease=lease;self.ledger=ledger;self.scope=scope;self.guard=_guard(profile.paths.current_link,scope);self.name=Path(profile.paths.current_link).name;self.backup='.rbridge-pointer-'+ledger.transaction_id+'-'+secrets.token_hex(8);self.restored=False
        try:
            self.before=_pointer(self.guard.fd,self.name,os.getuid());self.held_before=None;self.after=None
            expected=Path(profile.paths.release_parent)/profile.runtime.old_sha
            if self.before[0] not in (str(expected),os.path.relpath(expected,Path(profile.paths.current_link).parent)):raise ConfigError('POINTER_EXPECTED_OLD_CHANGED')
        except BaseException:self.guard.close();raise
        _pointers.add(self)
    def check(self):
        self.guard.check()
        if self not in _pointers or self.after is None or self.restored or _pointer(self.guard.fd,self.name,os.getuid())!=self.after or _pointer(self.guard.fd,self.backup,os.getuid())!=self.held_before:raise ConfigError('POINTER_CAS_DRIFT')

def resume_owned_changes(profile,lease,ledger,backend,witness):
    """Reconstruct only acknowledged, descriptor-verified objects; never infer intent completion."""
    config=None;pointer=None
    try:
        scope=_qualified(profile,lease,ledger,backend);lease.check_exclusion();entries=ledger.read().entries
        if type(witness) is not dict or set(witness)!={'schema','profile_sha256','transaction_id','configuration','pointer'} or witness['schema']!='RBRIDGE_INSTALL_OWNED_EVIDENCE_V1' or witness['profile_sha256']!=report_sha256(profile) or witness['transaction_id']!=ledger.transaction_id:raise ConfigError('CONFIG_RESUME_WITNESS_UNQUALIFIED')
        cfg=witness['configuration'];ptr=witness['pointer'];installed=next((e for e in entries if e.marker=='CONFIG_INSTALLED'),None);intent=next((e for e in entries if e.marker=='CONFIG_INTENT'),None)
        if not installed or not intent or type(cfg) is not dict or set(cfg)!={'before_sha256','after_sha256','before_pointer_sha256','owned_additions_sha256','files'}:raise ConfigError('CONFIG_RESUME_ACKNOWLEDGEMENT_MISSING')
        config=_OwnedConfiguration(profile,lease,ledger,backend,scope,resuming=True)
        if config.before_sha256!=cfg['before_sha256'] or config.before_sha256!=intent.evidence.get('before_config_sha256') or config.owned_additions_sha256!=cfg['owned_additions_sha256'] or config.owned_additions_sha256!=installed.evidence.get('owned_additions_sha256') or cfg['before_pointer_sha256']!=intent.evidence.get('before_pointer_sha256'):raise ConfigError('CONFIG_RESUME_BASELINE_CHANGED')
        if type(cfg['files']) is not list or len(cfg['files'])!=2:raise ConfigError('CONFIG_RESUME_WITNESS_UNQUALIFIED')
        for path,data in config.payloads.items():
            pin=_read_pin(path,scope,config.modes[path]);encoded=vars(pin).copy();encoded['identity']=list(encoded['identity'])
            if pin.sha256!=hashlib.sha256(data).hexdigest() or encoded!=cfg['files'][len(config.created)]:raise ConfigError('CONFIG_RESUME_OWNED_INODE_CHANGED')
            config.created[path]=pin
        config.committed=True;backend.owned_configuration=config
        after=config.observed()
        if after!=cfg['after_sha256'] or after!=installed.evidence.get('after_config_sha256'):raise ConfigError('CONFIG_RESUME_OVERLAY_CHANGED')
        change=OwnedConfigChange(scope,config.before_sha256,after,cfg['before_pointer_sha256'],config.owned_additions_sha256,tuple(config.created.values()),config)
        switched=next((e for e in entries if e.marker=='POINTER_SWITCHED'),None)
        if switched:
            required={'before_sha256','after_sha256','before_target','after_target','held_before','backup_name','before_identity','after_identity'}
            if type(ptr) is not dict or set(ptr)!=required or not re.fullmatch(r'\.rbridge-pointer-'+ledger.transaction_id+r'-[0-9a-f]{16}',ptr['backup_name']):raise ConfigError('POINTER_RESUME_WITNESS_UNQUALIFIED')
            pointer=object.__new__(_OwnedPointer);pointer.profile=profile;pointer.lease=lease;pointer.ledger=ledger;pointer.scope=scope;pointer.guard=_guard(profile.paths.current_link,scope);pointer.name=Path(profile.paths.current_link).name;pointer.backup=ptr['backup_name'];pointer.restored=False
            def identity(value):
                if type(value) is not list or len(value)!=9 or any(type(v) is not str or not re.fullmatch('0|[1-9][0-9]{0,31}',v) for v in value):raise ConfigError('POINTER_RESUME_WITNESS_UNQUALIFIED')
                return tuple(int(v) for v in value)
            pointer.before=(ptr['before_target'],identity(ptr['before_identity']),ptr['before_sha256'])
            pointer.after=(ptr['after_target'],identity(ptr['after_identity']),ptr['after_sha256'])
            held=ptr['held_before']
            if type(held) is not list or len(held)!=3:raise ConfigError('POINTER_RESUME_WITNESS_UNQUALIFIED')
            pointer.held_before=(held[0],identity(held[1]),held[2])
            for value in (pointer.before,pointer.after,pointer.held_before):
                if value[2]!=report_sha256({'target':value[0],'identity':list(map(str,value[1]))}):raise ConfigError('POINTER_RESUME_WITNESS_UNQUALIFIED')
            expected=Path(profile.paths.release_parent)/profile.runtime.old_sha
            if pointer.before[0] not in (str(expected),os.path.relpath(expected,Path(profile.paths.current_link).parent)) or pointer.after[0]!=str(Path(profile.paths.release_parent)/profile.runtime.source_sha) or not _same_exchanged(pointer.held_before,pointer.before) or pointer.before[2]!=next(e for e in entries if e.marker=='POINTER_INTENT').evidence.get('before_pointer_sha256') or pointer.after[2]!=switched.evidence.get('after_pointer_sha256'):raise ConfigError('POINTER_RESUME_WITNESS_UNQUALIFIED')
            _pointers.add(pointer);pointer.check();backend.owned_pointer=pointer
            pointer_change=OwnedPointerChange(scope,pointer.before[2],pointer.after[2],pointer.before[0],pointer.after[0],pointer)
        else:
            if ptr is not None or any(e.marker=='POINTER_INTENT' for e in entries):raise ConfigError('POINTER_RESUME_ACKNOWLEDGEMENT_MISSING')
            guard=_guard(profile.paths.current_link,scope)
            try:
                if _pointer(guard.fd,Path(profile.paths.current_link).name,os.getuid())[2]!=cfg['before_pointer_sha256']:raise ConfigError('POINTER_CAS_DRIFT')
            finally:guard.close()
            pointer_change=None
        lease.check_exclusion();return OwnedChanges(change,pointer_change)
    except BaseException:
        if getattr(backend,'owned_configuration',None) is config:del backend.owned_configuration
        if getattr(backend,'owned_pointer',None) is pointer:del backend.owned_pointer
        if config is not None:config.close()
        if pointer is not None and hasattr(pointer,'guard'):pointer.guard.close()
        raise

def switch_pointer(profile,artifact,lease,ledger):
    session=None
    try:
        backend=lease.backend;scope=_qualified(profile,lease,ledger,backend);lease.check()
        config=getattr(backend,'owned_configuration',None)
        if type(config) is not _OwnedConfiguration or config not in _sessions or config.observed()!=next((e.evidence.get('after_config_sha256') for e in reversed(ledger.read().entries) if e.marker=='CONFIG_INSTALLED'),None):raise ConfigError('CONFIG_INSTALLATION_NOT_ACKNOWLEDGED')
        manifest=getattr(backend,'runtime_manifest',None)
        if type(artifact) is not PublishedArtifact or manifest is None or artifact.path!=Path(profile.paths.release_parent)/profile.runtime.source_sha or artifact.source_sha!=profile.runtime.source_sha or artifact.manifest_sha256!=manifest.sha256 or manifest.source_sha!=profile.runtime.source_sha:raise ConfigError('POINTER_ARTIFACT_UNQUALIFIED')
        if scope=='QUALIFIED_HOST_PAUSE' and (artifact.scope!='ROOT_DESCRIPTOR_PUBLICATION' or manifest.sha256!=profile.runtime.manifest_sha256):raise ConfigError('POINTER_ARTIFACT_UNQUALIFIED')
        authority=FilesystemAuthority(os.getuid(),1027,Path(profile.paths.release_parent),'RUNTIME',scope=='QUALIFIED_HOST_PAUSE',profile.runtime.manifest_sha256,profile.runtime.source_sha,profile.runtime.tree_sha)
        verify_published(artifact.path,manifest,authority)
        session=_OwnedPointer(profile,lease,ledger,scope)
        if getattr(backend,'owned_pointer',None) is not None:session.guard.close();raise ConfigError('POINTER_ALREADY_REGISTERED')
        backend.owned_pointer=session
        ledger.append('POINTER_INTENT',{'before_pointer_sha256':session.before[2],'pointer_sha256':session.before[2],'config_sha256':config.observed(),'owned_additions_sha256':config.owned_additions_sha256})
        os.symlink(str(artifact.path),session.backup,dir_fd=session.guard.fd);os.fsync(session.guard.fd);lease.check();session.guard.check()
        if _pointer(session.guard.fd,session.name,os.getuid())!=session.before:raise ConfigError('POINTER_CAS_DRIFT')
        planned=_pointer(session.guard.fd,session.backup,os.getuid());_exchange(session.guard.fd,session.name,session.backup);os.fsync(session.guard.fd);session.guard.check()
        session.after=_pointer(session.guard.fd,session.name,os.getuid())
        session.held_before=_pointer(session.guard.fd,session.backup,os.getuid())
        if not _same_exchanged(session.after,planned) or not _same_exchanged(session.held_before,session.before):raise ConfigError('POINTER_EXCHANGE_UNCERTAIN')
        session.check();lease.check()
        ledger.append('POINTER_SWITCHED',{'after_pointer_sha256':session.after[2],'pointer_sha256':session.after[2],'owned_additions_sha256':config.owned_additions_sha256})
        return OwnedPointerChange(scope,session.before[2],session.after[2],session.before[0],session.after[0],session)
    except (OSError,InstallationError,ValueError) as error:
        # Keep exchanged original inode and durable intent even on lost ACK.
        if isinstance(error,ConfigError):raise
        raise ConfigError('POINTER_SWITCH_UNCERTAIN') from None

def restore_owned_pre_start(changes,observed,lease,ledger):
    try:
        if type(changes) is not OwnedChanges or type(changes.config) is not OwnedConfigChange or type(observed) is not ObservedTransactionState:raise ConfigError('CONFIG_RESTORE_UNQUALIFIED')
        config=changes.config.session
        if type(config) is not _OwnedConfiguration or config not in _sessions or config.closed or config.lease is not lease or config.ledger is not ledger:raise ConfigError('CONFIG_RESTORE_UNQUALIFIED')
        _qualified(config.profile,lease,ledger,config.backend)
        if any(e.marker=='START_ATTEMPTED' for e in ledger.read().entries):raise ConfigError('CONFIG_RESTORE_START_ATTEMPTED')
        lease.check();snapshot=capture_snapshot(lease)
        if snapshot.reason_codes or snapshot.tree_sha256!=observed.snapshot_sha256 or config.observed()!=changes.config.after_sha256 or observed.config_sha256!=changes.config.after_sha256:raise ConfigError('CONFIG_RESTORE_DRIFT')
        if config.scope=='QUALIFIED_HOST_PAUSE':
            from .readonly_helper import run_paused_gates,validate_gate_bundle
            token={'transaction_id':ledger.transaction_id,'state_root_identity_sha256':report_sha256({k:v for k,v in snapshot.root_metadata.items() if k!='atime_ns'}),'tree_sha256':snapshot.tree_sha256,'entries':len(snapshot.entries),'bytes':snapshot.bytes,'pause_sha256':lease.pause_sha256,'captured_at':datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')}
            manifest=getattr(config.backend,'toolkit_manifest',None)
            if manifest is None:raise ConfigError('CONFIG_RESTORE_FRESH_GATES_REQUIRED')
            proof=run_paused_gates(lease,token,manifest);bundle=validate_gate_bundle(proof['bundle'],token)
            if bundle['status']!='PASS':raise ConfigError('CONFIG_RESTORE_FRESH_GATES_REQUIRED')
            after=capture_snapshot(lease)
            if after.tree_sha256!=snapshot.tree_sha256:raise ConfigError('CONFIG_RESTORE_DRIFT')
            config.backend.restoration_gate_evidence=proof
            observed=replace(observed,fresh_gate_status='PASS',fresh_gate_snapshot_sha256=snapshot.tree_sha256)
        decision=recovery_decision(ledger.read(),observed)
        if decision.action!='RESTORE_OWNED_PRE_START' or not decision.may_start_old:raise ConfigError('CONFIG_RESTORE_FRESH_GATES_REQUIRED')
        if changes.pointer:
            pointer=changes.pointer.session
            if type(changes.pointer) is not OwnedPointerChange or type(pointer) is not _OwnedPointer or pointer.lease is not lease or pointer.ledger is not ledger or observed.pointer_sha256!=changes.pointer.after_sha256:raise ConfigError('POINTER_RESTORE_UNQUALIFIED')
            pointer.check()
        else:
            guard=_guard(config.profile.paths.current_link,config.scope)
            try:
                if _pointer(guard.fd,Path(config.profile.paths.current_link).name,os.getuid())[2]!=changes.config.before_pointer_sha256:raise ConfigError('POINTER_CAS_DRIFT')
            finally:guard.close()
        # Validate all CAS objects before the first restore action.
        for pin in changes.config.files:_file_matches(pin,config.scope)
        lease.check()
        if changes.pointer:
            pointer.check();_exchange(pointer.guard.fd,pointer.name,pointer.backup);os.fsync(pointer.guard.fd);pointer.guard.check()
            restored=_pointer(pointer.guard.fd,pointer.name,os.getuid());held_after=_pointer(pointer.guard.fd,pointer.backup,os.getuid())
            if not _same_exchanged(restored,pointer.held_before) or not _same_exchanged(held_after,pointer.after):raise ConfigError('POINTER_RESTORE_UNCERTAIN')
            pointer.restored=True;pointer_sha=restored[2]
        else:pointer_sha=changes.config.before_pointer_sha256
        config.restoring=True
        for pin in reversed(changes.config.files):
            _file_matches(pin,config.scope);guard=config.guards[pin.path];guard.check();os.unlink(Path(pin.path).name,dir_fd=guard.fd);os.fsync(guard.fd);guard.check();config.removed.add(pin.path)
        config.backend.reload_configuration();config_sha=config.observed();lease.check()
        if config_sha!=changes.config.before_sha256:raise ConfigError('CONFIG_RESTORE_UNCERTAIN')
        ledger.append('ROLLED_BACK',{'config_sha256':config_sha,'pointer_sha256':pointer_sha,'snapshot_sha256':snapshot.tree_sha256,'owned_additions_sha256':changes.config.owned_additions_sha256})
        del config.backend.owned_configuration;config.close()
        return RestoreProof(config.scope,'PASS',True,config_sha,pointer_sha)
    except (OSError,InstallationError,ValueError) as error:
        if isinstance(error,ConfigError):raise
        raise ConfigError('CONFIG_RESTORE_UNCERTAIN') from None
