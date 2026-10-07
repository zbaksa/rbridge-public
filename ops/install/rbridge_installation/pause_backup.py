"""Maintained pause, complete descriptor snapshot, and evidence-preserving backup."""
from dataclasses import dataclass,asdict
from pathlib import Path
from types import MappingProxyType
import fcntl
import hashlib
import json
import os
import secrets
import stat
import time
from .artifact import _identity,open_artifact_root,_relative
from .models import PauseError,report_sha256,encode_report
from .protected_copy import DIR_FLAGS,FILE_FLAGS,_rename_exclusive,ProtectedParent,FilesystemAuthority

@dataclass(frozen=True)
class SnapshotEntry:
    path:str
    kind:str
    dev:str
    ino:str
    uid:int
    gid:int
    mode:int
    nlink:int
    size:int
    mtime_ns:str
    ctime_ns:str
    atime_ns:str
    sha256:str
    target:str

@dataclass(frozen=True)
class SnapshotManifest:
    schema:str
    scope:str
    state_root:str
    root_metadata:MappingProxyType
    entries:tuple
    tree_sha256:str
    bytes:int
    pause_sha256:str
    reason_codes:tuple
    lease:object

@dataclass(frozen=True)
class BackupProof:
    schema:str
    scope:str
    status:str
    directory:str
    tree_sha256:str
    manifest_sha256:str

def _metadata(s):
    return {'dev':str(s.st_dev),'ino':str(s.st_ino),'uid':s.st_uid,'gid':s.st_gid,'mode':s.st_mode&0o7777,'nlink':s.st_nlink,'size':s.st_size,'mtime_ns':str(s.st_mtime_ns),'ctime_ns':str(s.st_ctime_ns),'atime_ns':str(s.st_atime_ns)}

def _fingerprint(root,entries):
    return report_sha256({'root':{k:v for k,v in root.items() if k!='atime_ns'},'entries':[{k:v for k,v in asdict(e).items() if k!='atime_ns'} for e in entries]})

def _observation(value,profile):
    required={'scope','service_identity_sha256','active_state','main_pid','cgroup_pids','unclassified_same_uid','alternate_writers','supervisors','admissions_closed'}
    if type(value)!=dict or set(value)-required-{'stopped_sockets'} or not required<=set(value) or value['service_identity_sha256']!=profile.service.identity_sha256 or value['scope'] not in ('FIXTURE_AUTHORITY_ONLY','QUALIFIED_HOST_PAUSE'):
        raise PauseError('PAUSE_OBSERVATION_INVALID')
    if value['active_state']!='inactive' or type(value['main_pid'])!=int or value['main_pid']!=0 or value['admissions_closed'] is not True:
        raise PauseError('PAUSE_SERVICE_UNSETTLED')
    for key in ('cgroup_pids','unclassified_same_uid','alternate_writers','supervisors'):
        if type(value[key])!=list or value[key]:raise PauseError('PAUSE_WRITER_UNSETTLED')
    sockets=value.get('stopped_sockets',[])
    if type(sockets)!=list or any(p!='execution-v2/core.sock' for p in sockets) or len(sockets)!=len(set(sockets)):raise PauseError('PAUSE_SOCKET_UNCLASSIFIED')
    return {**value,'stopped_sockets':sockets}

def capture_service(profile,backend):
    value=backend.capture_service(profile)
    if type(value)!=dict or set(value)!={'scope','identity_sha256','config_sha256','invocation_sha256'} or value['identity_sha256']!=profile.service.identity_sha256 or value['scope'] not in ('FIXTURE_AUTHORITY_ONLY','QUALIFIED_HOST_PAUSE'):
        raise PauseError('PAUSE_SERVICE_IDENTITY_CHANGED')
    if any(type(value[k])!=str or len(value[k])!=64 or any(c not in '0123456789abcdef' for c in value[k]) for k in ('identity_sha256','config_sha256','invocation_sha256')):raise PauseError('PAUSE_SERVICE_IDENTITY_INVALID')
    return MappingProxyType(value)

class PauseLease:
    def __init__(self,profile,backend,ledger,lock_fd,lock_identity,observation,lock_guard=None):
        self.profile=profile;self.backend=backend;self.ledger=ledger;self.lock_fd=lock_fd;self.lock_identity=lock_identity
        self.observation=observation;self.pause_sha256=report_sha256(observation);self.scope=observation['scope'] if observation else backend.scope;self.closed=False;self.lock_guard=lock_guard
        self.deadline=time.monotonic()+profile.budget.maintenance_ms/1000
        self.stopped_sockets=tuple(observation['stopped_sockets']) if observation else ()
    def check(self):
        self.check_exclusion()
        current=_observation(self.backend.observe_pause(self.profile),self.profile)
        if report_sha256(current)!=self.pause_sha256:raise PauseError('PAUSE_OBSERVATION_CHANGED')
    def check_exclusion(self):
        """Retain maintenance ownership while the authorized candidate is active.

        This is a lock/lease proof, never a stopped-service or writer proof.
        """
        if self.closed or time.monotonic()>=self.deadline:raise PauseError('PAUSE_LEASE_EXPIRED')
        self.check_ownership()
    def check_ownership(self):
        """Prove the retained exclusion for containment, without admitting new work.

        The maintenance deadline limits mutations and start authority. It does
        not close the descriptor or suppress a fixed stop after uncertain start.
        """
        if self.closed:raise PauseError('PAUSE_LEASE_EXPIRED')
        try:
            if self.lock_guard:self.lock_guard.check()
            before=os.fstat(self.lock_fd);named=os.stat(self.profile.paths.lock_path,follow_symlinks=False)
            if _identity(before)!=self.lock_identity or _identity(named)!=self.lock_identity:raise PauseError('PAUSE_LOCK_CHANGED')
            fcntl.flock(self.lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:raise PauseError('PAUSE_LOCK_OR_OBSERVATION_UNAVAILABLE') from None
    def observe_stopped(self):
        """Mint a fresh stop observation; a dead predecessor's flock is not evidence."""
        self.check_exclusion()
        first=_observation(self.backend.observe_pause(self.profile),self.profile)
        second=_observation(self.backend.observe_pause(self.profile),self.profile)
        if first['scope']!=self.scope or first!=second:raise PauseError('PAUSE_OBSERVATION_CHANGED')
        self.observation=first;self.pause_sha256=report_sha256(first);self.stopped_sockets=tuple(first['stopped_sockets']);self.check()
    def close(self):
        if not self.closed:
            self.closed=True;os.close(self.lock_fd)
            if self.lock_guard:self.lock_guard.close()

def reacquire_exclusion(profile,backend,ledger):
    """Acquire a new foreground lock, without asserting the service is stopped."""
    scope=getattr(backend,'scope',None)
    if scope=='QUALIFIED_HOST_PAUSE':
        from .host_backend import QualifiedHostBackend
        if type(backend) is not QualifiedHostBackend or os.getuid()!=0 or os.geteuid()!=0:raise PauseError('PAUSE_BACKEND_UNQUALIFIED')
    elif scope!='FIXTURE_AUTHORITY_ONLY':raise PauseError('PAUSE_BACKEND_UNQUALIFIED')
    path=Path(profile.paths.lock_path);guard=ProtectedParent(FilesystemAuthority(os.getuid(),1027,path.parent,'RUNTIME',scope=='QUALIFIED_HOST_PAUSE'));fd=None
    try:
        guard.check()
        try:fd=os.open(path.name,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=guard.fd);os.fsync(fd);os.fsync(guard.fd)
        except FileExistsError:fd=os.open(path.name,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=guard.fd)
        row=os.fstat(fd)
        if not stat.S_ISREG(row.st_mode) or row.st_uid!=os.getuid() or row.st_nlink!=1 or row.st_mode&0o7777!=0o600:raise PauseError('PAUSE_LOCK_UNPROTECTED')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);lease=PauseLease(profile,backend,ledger,fd,_identity(row),None,guard);lease.check_exclusion()
        if scope=='QUALIFIED_HOST_PAUSE':
            from .maintenance_registry import assert_no_unfinished_transactions
            assert_no_unfinished_transactions(ledger.parent_fd,ledger)
        return lease
    except BaseException:
        if fd is not None:os.close(fd)
        guard.close();raise

def maintain_pause(profile,backend,ledger):
    lease=None;completed=False
    try:
        lease=reacquire_exclusion(profile,backend,ledger);backend.pending_pause=lease;scope=lease.scope
        before=capture_service(profile,backend)
        if before['scope']!=scope:raise PauseError('PAUSE_BACKEND_UNQUALIFIED')
        ledger.append('PAUSE_INTENT',{'service_identity_sha256':before['identity_sha256'],'config_sha256':before['config_sha256'],'invocation_sha256':before['invocation_sha256']})
        backend.stop_unit(profile.service.unit)
        lease.observe_stopped()
        ledger.append('PAUSED',{'pause_sha256':lease.pause_sha256,'service_identity_sha256':before['identity_sha256']})
        completed=True;del backend.pending_pause;return lease
    except OSError:raise PauseError('PAUSE_HOST_OR_LOCK_UNAVAILABLE') from None
    finally:
        # The transaction owns a failed attempt too; no EXIT cleanup releases it.
        if lease is not None and not completed:backend.pending_pause=lease

def _inventory(root,uid,gid,budget,stopped_sockets):
    fd=open_artifact_root(root);entries=[];total=0;reasons=set();access_times={};deadline=time.monotonic()+budget.scan_ms/1000
    try:
        root_stat=os.fstat(fd);root_metadata=_metadata(root_stat)
        def timely():
            if time.monotonic()>=deadline:raise PauseError('STATE_SCAN_DEADLINE')
        def walk(parent,prefix='',depth=0):
            nonlocal total
            timely();before=os.fstat(parent)
            if depth>budget.state_depth:raise PauseError('STATE_DEPTH_LIMIT')
            names=sorted(os.listdir(parent),key=lambda n:n.encode('utf-8',errors='strict'))
            for name in names:
                timely();path=prefix+name;_relative(path)
                if len(entries)>=budget.state_entries:raise PauseError('STATE_ENTRY_LIMIT')
                s=os.stat(name,dir_fd=parent,follow_symlinks=False);meta=_metadata(s);kind='OTHER';digest='';target=''
                if s.st_uid!=uid or s.st_gid!=gid or (not stat.S_ISLNK(s.st_mode) and s.st_mode&0o6022):reasons.add('STATE_OWNERSHIP_OR_MODE')
                if stat.S_ISDIR(s.st_mode):
                    kind='DIRECTORY';child=os.open(name,DIR_FLAGS,dir_fd=parent)
                    try:
                        if _identity(s)!=_identity(os.fstat(child)):raise PauseError('STATE_CHANGED')
                        entries.append(SnapshotEntry(path,kind,**meta,sha256='',target=''));walk(child,path+'/',depth+1)
                    finally:os.close(child)
                elif stat.S_ISREG(s.st_mode):
                    kind='FILE'
                    meta['atime_ns']=access_times.setdefault((s.st_dev,s.st_ino),meta['atime_ns'])
                    if s.st_size>budget.state_bytes-total:raise PauseError('STATE_BYTE_LIMIT')
                    child=os.open(name,FILE_FLAGS,dir_fd=parent)
                    try:
                        if _identity(s)!=_identity(os.fstat(child)):raise PauseError('STATE_CHANGED')
                        count=0;hasher=hashlib.sha256()
                        while True:
                            timely();chunk=os.read(child,1048576)
                            if not chunk:break
                            count+=len(chunk)
                            if count>s.st_size:raise PauseError('STATE_CHANGED')
                            hasher.update(chunk)
                        if count!=s.st_size or _identity(s)!=_identity(os.fstat(child)):raise PauseError('STATE_CHANGED')
                        digest=hasher.hexdigest();total+=count
                    finally:os.close(child)
                elif stat.S_ISLNK(s.st_mode):kind='SYMLINK';target=os.readlink(name,dir_fd=parent);reasons.add('STATE_SYMLINK_UNCLASSIFIED')
                elif stat.S_ISSOCK(s.st_mode):
                    kind='SOCKET'
                    if path not in stopped_sockets:reasons.add('STATE_SOCKET_UNCLASSIFIED')
                elif stat.S_ISFIFO(s.st_mode):kind='FIFO';reasons.add('STATE_SPECIAL_OBJECT')
                else:reasons.add('STATE_SPECIAL_OBJECT')
                if kind!='DIRECTORY':entries.append(SnapshotEntry(path,kind,**meta,sha256=digest,target=target))
                if _identity(s)!=_identity(os.stat(name,dir_fd=parent,follow_symlinks=False)):raise PauseError('STATE_CHANGED')
            if names!=sorted(os.listdir(parent),key=lambda n:n.encode()) or _identity(before)!=_identity(os.fstat(parent)):raise PauseError('STATE_CHANGED')
        if root_stat.st_uid!=uid or root_stat.st_gid!=gid or root_stat.st_mode&0o7777!=0o700:reasons.add('STATE_ROOT_UNPROTECTED')
        walk(fd)
        if _identity(root_stat)!=_identity(os.fstat(fd)) or _identity(root_stat)!=_identity(Path(root).lstat()):raise PauseError('STATE_CHANGED')
        groups={}
        ordered=tuple(sorted(entries,key=lambda e:e.path.encode()))
        for e in ordered:
            if e.kind=='FILE':groups.setdefault((e.dev,e.ino),[]).append(e)
        for members in groups.values():
            if any(e.nlink!=len(members) for e in members):reasons.add('STATE_EXTERNAL_HARDLINK')
            if len({(e.sha256,e.mode,e.uid,e.gid,e.size) for e in members})!=1:raise PauseError('STATE_HARDLINK_CHANGED')
        return root_metadata,ordered,total,tuple(sorted(reasons))
    except (OSError,UnicodeError):raise PauseError('STATE_INVENTORY_UNAVAILABLE') from None
    finally:os.close(fd)

def capture_snapshot(lease:PauseLease)->SnapshotManifest:
    lease.check();p=lease.profile
    root,entries,total,reasons=_inventory(Path(p.paths.state_root),p.binding.uid,p.binding.gid,p.budget,lease.stopped_sockets)
    lease.check()
    return SnapshotManifest('RBRIDGE_INSTALL_SNAPSHOT_V1',lease.scope,p.paths.state_root,MappingProxyType(root),entries,_fingerprint(root,entries),total,lease.pause_sha256,reasons,lease)

def _snapshot_report(snapshot):
    return {'schema':snapshot.schema,'scope':snapshot.scope,'state_root':snapshot.state_root,'root_metadata':dict(snapshot.root_metadata),'entries':[asdict(e) for e in snapshot.entries],'tree_sha256':snapshot.tree_sha256,'bytes':snapshot.bytes,'pause_sha256':snapshot.pause_sha256,'reason_codes':list(snapshot.reason_codes)}

def backup_snapshot(snapshot:SnapshotManifest,parent_fd:int)->BackupProof:
    lease=snapshot.lease;lease.check();current=capture_snapshot(lease)
    if current.tree_sha256!=snapshot.tree_sha256 or current.pause_sha256!=snapshot.pause_sha256:raise PauseError('BACKUP_SNAPSHOT_CHANGED')
    if snapshot.reason_codes:raise PauseError('BACKUP_UNSAFE_OBJECT')
    owner=os.getuid();row=os.fstat(parent_fd)
    if not stat.S_ISDIR(row.st_mode) or row.st_uid!=owner or row.st_mode&0o7777!=0o700:raise PauseError('BACKUP_PARENT_UNPROTECTED')
    guard=None
    if snapshot.scope=='QUALIFIED_HOST_PAUSE':
        try:guard=ProtectedParent(FilesystemAuthority(0,1027,Path(os.readlink('/proc/self/fd/'+str(parent_fd))),'RUNTIME'),parent_fd)
        except OSError:raise PauseError('BACKUP_PARENT_UNPROTECTED') from None
    temporary='.backup-'+secrets.token_hex(16);directory='backup-'+lease.ledger.transaction_id
    base=None;source=None;targets={};sources={};groups={};renamed=False
    try:
        os.mkdir(temporary,0o700,dir_fd=parent_fd);base=os.open(temporary,DIR_FLAGS,dir_fd=parent_fd)
        os.mkdir('tree',0o700,dir_fd=base);targets['']=os.open('tree',DIR_FLAGS,dir_fd=base)
        source=open_artifact_root(Path(snapshot.state_root));sources['']=source
        for e in snapshot.entries:
            lease.check()
            parent,name=e.path.rsplit('/',1) if '/' in e.path else ('',e.path);src=sources[parent];dst=targets[parent]
            observed=os.stat(name,dir_fd=src,follow_symlinks=False)
            expected={k:v for k,v in asdict(e).items() if k in _metadata(observed) and k!='atime_ns'}
            if expected!={k:v for k,v in _metadata(observed).items() if k!='atime_ns'}:raise PauseError('BACKUP_SNAPSHOT_CHANGED')
            if e.kind=='DIRECTORY':
                sources[e.path]=os.open(name,DIR_FLAGS,dir_fd=src);os.mkdir(name,0o700,dir_fd=dst);targets[e.path]=os.open(name,DIR_FLAGS,dir_fd=dst)
            elif e.kind=='FILE':
                group=(e.dev,e.ino)
                if group in groups:
                    first_parent,first_name=groups[group];os.link(first_name,name,src_dir_fd=targets[first_parent],dst_dir_fd=dst,follow_symlinks=False)
                else:
                    inp=os.open(name,FILE_FLAGS,dir_fd=src);out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dst)
                    try:
                        before=os.fstat(inp)
                        if _identity(before)!=_identity(observed):raise PauseError('BACKUP_SNAPSHOT_CHANGED')
                        digest=hashlib.sha256();count=0
                        while True:
                            lease.check();chunk=os.read(inp,1048576)
                            if not chunk:break
                            count+=len(chunk)
                            if count>e.size:raise PauseError('BACKUP_SNAPSHOT_CHANGED')
                            digest.update(chunk);view=memoryview(chunk)
                            while view:
                                n=os.write(out,view)
                                if n<=0:raise PauseError('BACKUP_WRITE_FAILED')
                                view=view[n:]
                        if count!=e.size or digest.hexdigest()!=e.sha256 or _identity(before)!=_identity(os.fstat(inp)):raise PauseError('BACKUP_SNAPSHOT_CHANGED')
                        os.fsync(out)
                    finally:os.close(inp);os.close(out)
                    groups[group]=(parent,name)
            elif e.kind!='SOCKET':raise PauseError('BACKUP_UNSAFE_OBJECT')
            # Stopped sockets remain metadata only; never copy/open an endpoint.
        report=_snapshot_report(snapshot);raw=encode_report(report);digest=hashlib.sha256(raw).hexdigest()
        handle=os.open('manifest.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=base)
        try:
            view=memoryview(raw)
            while view:
                n=os.write(handle,view)
                if n<=0:raise PauseError('BACKUP_WRITE_FAILED')
                view=view[n:]
            os.fsync(handle)
        finally:os.close(handle)
        _verify_backup(targets[''],snapshot)
        _verify_backup_manifest(base,raw)
        _restore_backup_times(snapshot,targets)
        if capture_snapshot(lease).tree_sha256!=snapshot.tree_sha256:raise PauseError('BACKUP_SNAPSHOT_CHANGED')
        os.fsync(base)
        if guard:guard.check()
        _rename_exclusive(parent_fd,temporary,directory);renamed=True;os.fsync(parent_fd)
        if guard:guard.check()
        # A rename acknowledgement cannot substitute independent named readback.
        named=os.stat(directory,dir_fd=parent_fd,follow_symlinks=False)
        held=os.fstat(base)
        if (named.st_dev,named.st_ino)!=(held.st_dev,held.st_ino) or held.st_uid!=owner or held.st_mode&0o7777!=0o700:
            raise PauseError('BACKUP_DIRECTORY_CHANGED')
        tree=os.stat('tree',dir_fd=base,follow_symlinks=False);held_tree=os.fstat(targets[''])
        if (tree.st_dev,tree.st_ino)!=(held_tree.st_dev,held_tree.st_ino) or set(os.listdir(base))!={'tree','manifest.json'}:
            raise PauseError('BACKUP_DIRECTORY_CHANGED')
        _verify_backup(targets[''],snapshot)
        _restore_backup_times(snapshot,targets)
        _verify_backup_manifest(base,raw)
        proof=BackupProof('RBRIDGE_INSTALL_BACKUP_V1',snapshot.scope,'PASS',directory,snapshot.tree_sha256,digest)
        lease.ledger.append('BACKUP_COMPLETE',{'backup_sha256':report_sha256(asdict(proof)),'snapshot_sha256':snapshot.tree_sha256,'pause_sha256':snapshot.pause_sha256})
        return proof
    except OSError:raise PauseError('BACKUP_PUBLICATION_UNCERTAIN' if renamed else 'BACKUP_IO_FAILED') from None
    finally:
        for fd in list(targets.values())+list(sources.values()):os.close(fd)
        if base is not None:os.close(base)
        if guard:guard.close()
        # Retain any protected partial backup as evidence. Never restore/delete state.

def _restore_backup_times(snapshot,targets):
    # Restore only backup times after every independent verification read,
    # taking one captured access value for each original hardlink group.
    for e in reversed(snapshot.entries):
        if e.kind=='SOCKET':continue
        parent,name=e.path.rsplit('/',1) if '/' in e.path else ('',e.path)
        if e.kind=='DIRECTORY':
            held=os.fstat(targets[e.path]);named=os.stat(name,dir_fd=targets[parent],follow_symlinks=False)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise PauseError('BACKUP_DIRECTORY_CHANGED')
        os.utime(name,ns=(int(e.atime_ns),int(e.mtime_ns)),dir_fd=targets[parent],follow_symlinks=False)
        if e.kind=='FILE':
            handle=os.open(name,FILE_FLAGS,dir_fd=targets[parent])
            try:os.fsync(handle)
            finally:os.close(handle)
    os.utime(targets[''],ns=(int(snapshot.root_metadata['atime_ns']),int(snapshot.root_metadata['mtime_ns'])))
    for fd in targets.values():os.fsync(fd)

def _verify_backup_manifest(base,expected):
    if len(expected)>67108864:raise PauseError('BACKUP_MANIFEST_BYTE_LIMIT')
    handle=os.open('manifest.json',FILE_FLAGS,dir_fd=base)
    try:
        before=os.fstat(handle)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or before.st_nlink!=1
                or before.st_mode&0o7777!=0o600 or before.st_size!=len(expected)):
            raise PauseError('BACKUP_MANIFEST_MISMATCH')
        actual=bytearray()
        while len(actual)<=len(expected):
            part=os.read(handle,min(1048576,len(expected)+1-len(actual)))
            if not part:break
            actual.extend(part)
        if (actual!=expected or _identity(before)!=_identity(os.fstat(handle))
                or _identity(before)!=_identity(os.stat('manifest.json',dir_fd=base,follow_symlinks=False))):
            raise PauseError('BACKUP_MANIFEST_MISMATCH')
    finally:os.close(handle)

def _verify_backup(root_fd,snapshot):
    expected={e.path:e for e in snapshot.entries if e.kind!='SOCKET'};seen=set();groups={}
    def walk(fd,prefix=''):
        directory_before=os.fstat(fd);names=os.listdir(fd)
        for name in names:
            snapshot.lease.check();path=prefix+name;e=expected.get(path)
            if e is None or path in seen:raise PauseError('BACKUP_UNEXPECTED_OBJECT')
            seen.add(path);s=os.stat(name,dir_fd=fd,follow_symlinks=False)
            if s.st_uid!=os.getuid() or s.st_mode&0o7777!=(0o700 if e.kind=='DIRECTORY' else 0o600):raise PauseError('BACKUP_METADATA_MISMATCH')
            if e.kind=='DIRECTORY':
                if not stat.S_ISDIR(s.st_mode):raise PauseError('BACKUP_METADATA_MISMATCH')
                child=os.open(name,DIR_FLAGS,dir_fd=fd)
                try:
                    if _identity(s)!=_identity(os.fstat(child)):raise PauseError('BACKUP_DIRECTORY_CHANGED')
                    walk(child,path+'/')
                    if _identity(s)!=_identity(os.fstat(child)) or _identity(s)!=_identity(os.stat(name,dir_fd=fd,follow_symlinks=False)):
                        raise PauseError('BACKUP_DIRECTORY_CHANGED')
                finally:os.close(child)
            elif e.kind=='FILE':
                if not stat.S_ISREG(s.st_mode) or s.st_size!=e.size or s.st_nlink!=e.nlink:raise PauseError('BACKUP_METADATA_MISMATCH')
                group=(e.dev,e.ino);actual=(s.st_dev,s.st_ino)
                if group in groups and groups[group]!=actual:raise PauseError('BACKUP_HARDLINK_MISMATCH')
                groups[group]=actual;child=os.open(name,FILE_FLAGS,dir_fd=fd)
                try:
                    if _identity(s)!=_identity(os.fstat(child)):raise PauseError('BACKUP_FILE_CHANGED')
                    hasher=hashlib.sha256();count=0
                    while True:
                        snapshot.lease.check();chunk=os.read(child,1048576)
                        if not chunk:break
                        count+=len(chunk)
                        if count>e.size:raise PauseError('BACKUP_BYTE_MISMATCH')
                        hasher.update(chunk)
                    if count!=e.size or hasher.hexdigest()!=e.sha256:raise PauseError('BACKUP_BYTE_MISMATCH')
                    if _identity(s)!=_identity(os.fstat(child)) or _identity(s)!=_identity(os.stat(name,dir_fd=fd,follow_symlinks=False)):
                        raise PauseError('BACKUP_FILE_CHANGED')
                finally:os.close(child)
            else:raise PauseError('BACKUP_UNSAFE_OBJECT')
        if sorted(names)!=sorted(os.listdir(fd)) or _identity(directory_before)!=_identity(os.fstat(fd)):
            raise PauseError('BACKUP_DIRECTORY_CHANGED')
        return
    walk(root_fd)
    if seen!=set(expected):raise PauseError('BACKUP_MISSING_OBJECT')
