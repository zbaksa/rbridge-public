"""Copy manifest bytes through descriptors, publish without replacement or execution."""
from dataclasses import dataclass
from pathlib import Path
import ctypes
import errno
import hashlib
import os
import secrets
import stat
import time
from .artifact import ArtifactManifest,ArtifactProof,_identity,_relative,validate_manifest
from .models import ArtifactError,CopyError

DIR_FLAGS=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
FILE_FLAGS=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC

@dataclass(frozen=True)
class FilesystemAuthority:
    root_uid:int
    runtime_uid:int
    parent_path:Path
    role:str
    production:bool=True
    manifest_sha256:str=''
    source_sha:str=''
    tree_sha:str=''

def _approved(manifest,authority):
    if authority.production and (authority.manifest_sha256!=manifest.sha256 or authority.source_sha!=manifest.source_sha or authority.tree_sha!=manifest.tree_sha):
        raise CopyError('COPY_APPROVED_MANIFEST_REQUIRED')

@dataclass(frozen=True)
class PublishedArtifact:
    path:Path
    manifest_sha256:str
    source_sha:str
    scope:str

def _same(a,b):
    return (a.st_dev,a.st_ino,a.st_mode,a.st_uid,a.st_gid)==(b.st_dev,b.st_ino,b.st_mode,b.st_uid,b.st_gid)

class ProtectedParent:
    """Retain every ancestor FD and verify names still refer to the pinned inode."""
    def __init__(self,authority,parent_fd=None):
        self.authority=authority;self.handles=[];self.links=[]
        if authority.role not in ('RUNTIME','TOOLKIT') or os.geteuid()!=authority.root_uid: raise CopyError('COPY_AUTHORITY_INVALID')
        if authority.production and (os.getuid()!=0 or os.geteuid()!=0 or authority.root_uid!=0 or authority.runtime_uid!=1027): raise CopyError('COPY_ROOT_REQUIRED')
        path=os.fspath(authority.parent_path)
        if not path.startswith('/') or path=='/': raise CopyError('COPY_PARENT_INVALID')
        parts=_relative(path[1:])
        try:
            fd=os.open('/',DIR_FLAGS);self.handles.append(fd)
            for i,part in enumerate(parts):
                before=os.stat(part,dir_fd=fd,follow_symlinks=False)
                if authority.production or i==len(parts)-1:
                    if not stat.S_ISDIR(before.st_mode) or before.st_uid!=authority.root_uid or before.st_mode&0o6022: raise CopyError('COPY_PARENT_UNPROTECTED')
                child=os.open(part,DIR_FLAGS,dir_fd=fd);self.handles.append(child)
                if not _same(before,os.fstat(child)): raise CopyError('COPY_PARENT_CHANGED')
                self.links.append((fd,part,child,before));fd=child
            self.fd=fd
            if parent_fd is not None and not _same(os.fstat(fd),os.fstat(parent_fd)): raise CopyError('COPY_PARENT_CHANGED')
        except BaseException:
            self.close();raise
    def check(self):
        for parent,name,child,before in self.links:
            if not _same(before,os.fstat(child)) or not _same(before,os.stat(name,dir_fd=parent,follow_symlinks=False)): raise CopyError('COPY_PARENT_CHANGED')
    def close(self):
        for fd in reversed(self.handles):os.close(fd)
        self.handles=[]

def _rename_exclusive(parent_fd,old,new):
    # Linux atomic NOREPLACE, with no check-then-overwrite fallback.
    libc=ctypes.CDLL(None,use_errno=True)
    try: call=libc.renameat2
    except AttributeError: raise CopyError('COPY_RENAME_UNSUPPORTED') from None
    call.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    call.restype=ctypes.c_int
    if call(parent_fd,os.fsencode(old),parent_fd,os.fsencode(new),1):
        code=ctypes.get_errno()
        if code==errno.EEXIST: raise CopyError('COPY_DESTINATION_EXISTS')
        raise OSError(code,'COPY_RENAME_FAILED')

def _remove_private(parent_fd,name):
    """Delete only the unpublished directory we created; never follow a link."""
    fd=os.open(name,DIR_FLAGS,dir_fd=parent_fd)
    try:
        for child in os.listdir(fd):
            row=os.stat(child,dir_fd=fd,follow_symlinks=False)
            if stat.S_ISDIR(row.st_mode):_remove_private(fd,child)
            else:os.unlink(child,dir_fd=fd)
    finally:os.close(fd)
    os.rmdir(name,dir_fd=parent_fd)

def publish_artifact(stage_fd:int,parent_fd:int,manifest:ArtifactManifest,authority:FilesystemAuthority)->PublishedArtifact:
    guard=None;temp_fd=None;temporary=None;renamed=False
    try:
        validate_manifest(manifest)
        _approved(manifest,authority)
        if manifest.kind!=authority.role: raise CopyError('COPY_ROLE_MISMATCH')
        guard=ProtectedParent(authority,parent_fd)
        stage=os.fstat(stage_fd)
        if not stat.S_ISDIR(stage.st_mode) or stage.st_uid!=authority.runtime_uid or stage.st_mode&0o6022: raise CopyError('COPY_STAGE_INVALID')
        destination=manifest.source_sha if manifest.kind=='RUNTIME' else 'toolkit-'+manifest.source_sha
        try:os.stat(destination,dir_fd=parent_fd,follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise CopyError('COPY_DESTINATION_EXISTS')
        temporary='.rbridge-copy-'+secrets.token_hex(16)
        os.mkdir(temporary,0o700,dir_fd=parent_fd)
        temp_fd=os.open(temporary,DIR_FLAGS,dir_fd=parent_fd)
        created=os.fstat(temp_fd)
        if created.st_uid!=authority.root_uid or created.st_dev!=os.fstat(parent_fd).st_dev: raise CopyError('COPY_TEMPORARY_INVALID')
        children={};deadline=time.monotonic()+600
        for e in manifest.entries:
            parent=e.path.rpartition('/')[0];children.setdefault(parent,[]).append(e)
        def copy_dir(src,dst,prefix=''):
            before=os.fstat(src)
            expected=children.get(prefix,[])
            names=sorted(os.listdir(src),key=lambda n:n.encode())
            if names!=sorted((e.path.split('/')[-1] for e in expected),key=lambda n:n.encode()): raise CopyError('COPY_UNMANIFESTED_OBJECT')
            for entry in expected:
                if time.monotonic()>=deadline: raise CopyError('COPY_DEADLINE')
                name=entry.path.split('/')[-1];row=os.stat(name,dir_fd=src,follow_symlinks=False)
                if row.st_uid!=authority.runtime_uid or (not stat.S_ISLNK(row.st_mode) and row.st_mode&0o6022): raise CopyError('COPY_STAGE_INVALID')
                if entry.kind=='DIRECTORY':
                    if not stat.S_ISDIR(row.st_mode): raise CopyError('COPY_TYPE_MISMATCH')
                    source=os.open(name,DIR_FLAGS,dir_fd=src)
                    try:
                        if _identity(row)!=_identity(os.fstat(source)): raise CopyError('COPY_SOURCE_CHANGED')
                        os.mkdir(name,0o700,dir_fd=dst);target=os.open(name,DIR_FLAGS,dir_fd=dst)
                        try:copy_dir(source,target,entry.path);os.fchmod(target,entry.mode);os.fsync(target)
                        finally:os.close(target)
                    finally:os.close(source)
                elif entry.kind=='FILE':
                    if not stat.S_ISREG(row.st_mode) or row.st_nlink!=1 or row.st_size!=entry.size: raise CopyError('COPY_FILE_INVALID')
                    source=os.open(name,FILE_FLAGS,dir_fd=src)
                    try:
                        if _identity(row)!=_identity(os.fstat(source)): raise CopyError('COPY_SOURCE_CHANGED')
                        target=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=dst)
                        try:
                            count=0;digest=hashlib.sha256()
                            while True:
                                if time.monotonic()>=deadline: raise CopyError('COPY_DEADLINE')
                                chunk=os.read(source,1048576)
                                if not chunk:break
                                count+=len(chunk)
                                if count>entry.size: raise CopyError('COPY_SOURCE_CHANGED')
                                digest.update(chunk);view=memoryview(chunk)
                                while view:
                                    written=os.write(target,view)
                                    if written<=0: raise CopyError('COPY_WRITE_FAILED')
                                    view=view[written:]
                            if count!=entry.size or digest.hexdigest()!=entry.sha256 or _identity(row)!=_identity(os.fstat(source)): raise CopyError('COPY_SOURCE_CHANGED')
                            os.fchmod(target,entry.mode);os.fsync(target)
                        finally:os.close(target)
                    finally:os.close(source)
                else:
                    if not stat.S_ISLNK(row.st_mode) or row.st_nlink!=1 or os.readlink(name,dir_fd=src)!=entry.target: raise CopyError('COPY_LINK_INVALID')
                    os.symlink(entry.target,name,dir_fd=dst)
                if _identity(row)!=_identity(os.stat(name,dir_fd=src,follow_symlinks=False)): raise CopyError('COPY_SOURCE_CHANGED')
            if _identity(before)!=_identity(os.fstat(src)) or names!=sorted(os.listdir(src),key=lambda n:n.encode()): raise CopyError('COPY_SOURCE_CHANGED')
            os.fsync(dst)
        copy_dir(stage_fd,temp_fd)
        if _identity(stage)!=_identity(os.fstat(stage_fd)): raise CopyError('COPY_SOURCE_CHANGED')
        # Read copied bytes again, through this FD, before making the release visible.
        _verify_tree(temp_fd,manifest,authority.root_uid,root_private=True)
        os.fchmod(temp_fd,0o755);os.fsync(temp_fd);guard.check()
        _rename_exclusive(parent_fd,temporary,destination);renamed=True;os.fsync(parent_fd);guard.check()
        return PublishedArtifact(authority.parent_path/destination,manifest.sha256,manifest.source_sha,'ROOT_DESCRIPTOR_PUBLICATION' if authority.production else 'FIXTURE_AUTHORITY_ONLY')
    except (OSError,ArtifactError,CopyError,UnicodeError) as error:
        if not renamed and isinstance(error,CopyError):raise
        raise CopyError('COPY_PUBLICATION_UNCERTAIN' if renamed else 'COPY_IO_OR_MANIFEST_FAILED') from error
    finally:
        if temp_fd is not None:os.close(temp_fd)
        if temporary is not None and not renamed:
            try:_remove_private(parent_fd,temporary)
            except OSError:pass  # Private unexecuted debris is safe; never remove a release.
        if guard is not None:guard.close()

def _verify_tree(root_fd,manifest,uid,root_private=False):
    entries={e.path:e for e in manifest.entries};seen=set();root=os.fstat(root_fd)
    if root.st_uid!=uid or root.st_mode&0o7777!=(0o700 if root_private else 0o755): raise CopyError('COPY_PUBLISHED_MODE_INVALID')
    deadline=time.monotonic()+600
    def walk(fd,prefix=''):
        before=os.fstat(fd)
        for name in os.listdir(fd):
            if time.monotonic()>=deadline: raise CopyError('COPY_DEADLINE')
            path=prefix+name;entry=entries.get(path)
            if entry is None or path in seen: raise CopyError('COPY_UNMANIFESTED_OBJECT')
            seen.add(path);row=os.stat(name,dir_fd=fd,follow_symlinks=False)
            if row.st_uid!=uid: raise CopyError('COPY_PUBLISHED_OWNER_INVALID')
            if entry.kind=='DIRECTORY':
                if not stat.S_ISDIR(row.st_mode) or row.st_mode&0o7777!=entry.mode: raise CopyError('COPY_PUBLISHED_MODE_INVALID')
                child=os.open(name,DIR_FLAGS,dir_fd=fd)
                try:
                    if _identity(row)!=_identity(os.fstat(child)): raise CopyError('COPY_SOURCE_CHANGED')
                    walk(child,path+'/')
                finally:os.close(child)
            elif entry.kind=='FILE':
                if not stat.S_ISREG(row.st_mode) or row.st_nlink!=1 or row.st_size!=entry.size or row.st_mode&0o7777!=entry.mode: raise CopyError('COPY_FILE_INVALID')
                child=os.open(name,FILE_FLAGS,dir_fd=fd)
                try:
                    if _identity(row)!=_identity(os.fstat(child)): raise CopyError('COPY_SOURCE_CHANGED')
                    count=0;digest=hashlib.sha256()
                    while True:
                        if time.monotonic()>=deadline: raise CopyError('COPY_DEADLINE')
                        chunk=os.read(child,1048576)
                        if not chunk:break
                        count+=len(chunk)
                        if count>entry.size: raise CopyError('COPY_SOURCE_CHANGED')
                        digest.update(chunk)
                    if count!=entry.size or digest.hexdigest()!=entry.sha256 or _identity(row)!=_identity(os.fstat(child)): raise CopyError('COPY_SOURCE_CHANGED')
                finally:os.close(child)
            elif not stat.S_ISLNK(row.st_mode) or row.st_nlink!=1 or os.readlink(name,dir_fd=fd)!=entry.target: raise CopyError('COPY_LINK_INVALID')
            if _identity(row)!=_identity(os.stat(name,dir_fd=fd,follow_symlinks=False)): raise CopyError('COPY_SOURCE_CHANGED')
        if _identity(before)!=_identity(os.fstat(fd)): raise CopyError('COPY_SOURCE_CHANGED')
    walk(root_fd)
    if seen!=set(entries): raise CopyError('COPY_MISSING_OBJECT')

def verify_published(path:Path,manifest:ArtifactManifest,authority:FilesystemAuthority)->ArtifactProof:
    validate_manifest(manifest);_approved(manifest,authority);guard=ProtectedParent(authority)
    try:
        expected=manifest.source_sha if manifest.kind=='RUNTIME' else 'toolkit-'+manifest.source_sha
        if path!=authority.parent_path/expected or manifest.kind!=authority.role: raise CopyError('COPY_ROLE_MISMATCH')
        fd=os.open(expected,DIR_FLAGS,dir_fd=guard.fd)
        try:_verify_tree(fd,manifest,authority.root_uid)
        finally:os.close(fd)
        guard.check()
        return ArtifactProof(manifest.sha256,manifest.sha256,manifest.source_sha,manifest.node_sha256,'PASS')
    except (OSError,ArtifactError):raise CopyError('COPY_VERIFICATION_FAILED') from None
    finally:guard.close()
