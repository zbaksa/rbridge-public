"""Complete protected interpreter/stdlib trees; no runtime-owned Python import."""
import hashlib
import os
from pathlib import Path
import re
import stat
import time
from .artifact import _identity
from .models import InstallationError,encode_report,report_sha256
from .protected_copy import DIR_FLAGS,FILE_FLAGS,ProtectedParent,FilesystemAuthority


class PythonClosureError(InstallationError):pass


def _fail(reason):raise PythonClosureError(reason)


def _path(value):
    if (type(value) is not str or not value.startswith('/') or value=='/' or len(value.encode())>4096
            or any(p in ('','.','..') for p in value.split('/')[1:]) or any(c in value for c in '\0\r\n')):
        _fail('PYTHON_CLOSURE_PATH_INVALID')
    return value


def validate_python_closure(manifest,expected_sha256):
    keys={'schema','python_version','interpreter_path','interpreter_sha256','roots','entries','absent_paths','sha256'}
    if (type(manifest) is not dict or set(manifest)!=keys or manifest['schema']!='RBRIDGE_PYTHON_CLOSURE_V1'
            or type(manifest['python_version']) is not str or not re.fullmatch(r'3\.(1[1-9]|[2-9][0-9])\.[0-9]+',manifest['python_version'])
            or type(expected_sha256) is not str or not re.fullmatch('[0-9a-f]{64}',expected_sha256)
            or manifest['sha256']!=expected_sha256 or report_sha256({k:v for k,v in manifest.items() if k!='sha256'})!=expected_sha256
            or type(manifest['roots']) is not list or not 1<=len(manifest['roots'])<=128
            or type(manifest['entries']) is not list or not 1<=len(manifest['entries'])<=100000
            or type(manifest['absent_paths']) is not list or len(manifest['absent_paths'])>128):_fail('PYTHON_CLOSURE_MANIFEST_INVALID')
    roots=[_path(p) for p in manifest['roots']];absent=[_path(p) for p in manifest['absent_paths']]
    if roots!=sorted(set(roots),key=lambda p:p.encode()) or absent!=sorted(set(absent),key=lambda p:p.encode()):
        _fail('PYTHON_CLOSURE_MANIFEST_INVALID')
    if any(a!=b and b.startswith(a+'/') for a in roots for b in roots):_fail('PYTHON_CLOSURE_ROOT_OVERLAP')
    entries={};total=0
    for row in manifest['entries']:
        if type(row) is not dict or set(row)!={'path','kind','mode','size','sha256'}:_fail('PYTHON_CLOSURE_MANIFEST_INVALID')
        path=_path(row['path'])
        if (path in entries or entries and path.encode()<=next(reversed(entries)).encode()
                or not any(path==root or path.startswith(root+'/') for root in roots)
                or type(row['mode']) is not int or row['mode']&0o6022 or not 0<=row['mode']<=0o7777
                or type(row['size']) is not int or not 0<=row['size']<=268435456):_fail('PYTHON_CLOSURE_MANIFEST_INVALID')
        if row['kind']=='DIRECTORY':
            if row['size'] or row['sha256'] or row['mode']&0o111!=0o111:_fail('PYTHON_CLOSURE_MANIFEST_INVALID')
        elif row['kind']=='FILE':
            if type(row['sha256']) is not str or not re.fullmatch('[0-9a-f]{64}',row['sha256']):_fail('PYTHON_CLOSURE_MANIFEST_INVALID')
            total+=row['size']
        else:_fail('PYTHON_CLOSURE_MANIFEST_INVALID')
        if path not in roots and (str(Path(path).parent) not in entries or entries[str(Path(path).parent)]['kind']!='DIRECTORY'):
            _fail('PYTHON_CLOSURE_PARENT_MISSING')
        entries[path]=row
    interpreter=_path(manifest['interpreter_path'])
    if (total>1073741824 or any(root not in entries for root in roots) or interpreter not in entries
            or entries[interpreter]['kind']!='FILE' or entries[interpreter]['sha256']!=manifest['interpreter_sha256']
            or set(absent)&set(entries) or any(any(path==root or path.startswith(root+'/') for root in roots) for path in absent)):
        _fail('PYTHON_CLOSURE_MANIFEST_INVALID')
    return entries


def verify_python_closure_tree(manifest,expected_sha256,production=True):
    """Compare exact complete descriptor inventory; does not issue execution permission."""
    expected=validate_python_closure(manifest,expected_sha256);owner=0 if production else os.getuid()
    if production:
        from .host_backend import _assert_kernel_namespace
        if os.getuid()!=0 or os.geteuid()!=0:_fail('PYTHON_CLOSURE_ROOT_REQUIRED')
        _assert_kernel_namespace()
    deadline=time.monotonic()+600;seen=set();count=0
    def check_time():
        if time.monotonic()>=deadline:_fail('PYTHON_CLOSURE_DEADLINE')
    def verify(parent,name,path):
        nonlocal count
        check_time();count+=1;row=expected.get(path)
        if row is None or path in seen:_fail('PYTHON_CLOSURE_UNEXPECTED_OBJECT')
        seen.add(path);before=os.stat(name,dir_fd=parent,follow_symlinks=False)
        if before.st_uid!=owner or before.st_mode&0o7777!=row['mode']:_fail('PYTHON_CLOSURE_UNPROTECTED')
        directory=row['kind']=='DIRECTORY'
        if not (stat.S_ISDIR(before.st_mode) if directory else stat.S_ISREG(before.st_mode)):_fail('PYTHON_CLOSURE_UNSAFE_OBJECT')
        fd=os.open(name,DIR_FLAGS if directory else FILE_FLAGS,dir_fd=parent)
        try:
            if _identity(before)!=_identity(os.fstat(fd)):_fail('PYTHON_CLOSURE_CHANGED')
            if directory:
                names=sorted(os.listdir(fd),key=lambda n:n.encode('utf-8',errors='strict'))
                if len(names)>100000-count:_fail('PYTHON_CLOSURE_ENTRY_LIMIT')
                for child in names:verify(fd,child,path+'/'+child)
                if names!=sorted(os.listdir(fd),key=lambda n:n.encode()):_fail('PYTHON_CLOSURE_CHANGED')
            else:
                if before.st_nlink!=1 or before.st_size!=row['size']:_fail('PYTHON_CLOSURE_BYTES_CHANGED')
                digest=hashlib.sha256();size=0
                while True:
                    check_time();raw=os.read(fd,1048576)
                    if not raw:break
                    size+=len(raw)
                    if size>row['size']:_fail('PYTHON_CLOSURE_BYTES_CHANGED')
                    digest.update(raw)
                if size!=row['size'] or digest.hexdigest()!=row['sha256']:_fail('PYTHON_CLOSURE_BYTES_CHANGED')
            if _identity(before)!=_identity(os.fstat(fd)) or _identity(before)!=_identity(os.stat(name,dir_fd=parent,follow_symlinks=False)):
                _fail('PYTHON_CLOSURE_CHANGED')
        finally:os.close(fd)
    try:
        for root in manifest['roots']:
            path=Path(root);guard=ProtectedParent(FilesystemAuthority(owner,1027,path.parent,'RUNTIME',production))
            try:guard.check();verify(guard.fd,path.name,root);guard.check()
            finally:guard.close()
        for absent in manifest['absent_paths']:
            path=Path(absent);guard=ProtectedParent(FilesystemAuthority(owner,1027,path.parent,'RUNTIME',production))
            try:
                guard.check()
                try:os.stat(path.name,dir_fd=guard.fd,follow_symlinks=False)
                except FileNotFoundError:pass
                else:_fail('PYTHON_CLOSURE_ABSENCE_CHANGED')
                guard.check()
            finally:guard.close()
        if seen!=set(expected):_fail('PYTHON_CLOSURE_MISSING_OBJECT')
    except (OSError,UnicodeError):_fail('PYTHON_CLOSURE_READ_UNAVAILABLE')
    return {'schema':'RBRIDGE_PYTHON_CLOSURE_BYTES_V1','status':'PASS',
        'scope':'ROOT_PROTECTED_CLOSURE_BYTES_ONLY' if production else 'FIXTURE_AUTHORITY_ONLY',
        'execution_qualified':False,'manifest_sha256':expected_sha256,'files':sum(r['kind']=='FILE' for r in expected.values())}
