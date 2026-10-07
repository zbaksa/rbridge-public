#!/usr/bin/python3
"""Fixed protected-toolkit entry point. No source checkout is a root installer.

Preparation never grants switch permission. Unsettled transactions remain in the
foreground for the bounded owner-present window and leave their durable hold on
exit; a flock is never claimed to survive process death.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import stat
import sys
import time

OPERATIONS=('prepare','check','apply','resume','status')

class EntryError(ValueError):pass

def emit(value):
    sys.stdout.write(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n');sys.stdout.flush()

def blocked(reason):
    return {'schema':'RBRIDGE_INSTALL_ENTRY_V1','status':'BLOCKED','scope':'UNQUALIFIED','reason_codes':[reason]}

def read_input():
    selector=selectors.DefaultSelector();raw=bytearray();deadline=time.monotonic()+15
    try:
        selector.register(sys.stdin.buffer,selectors.EVENT_READ)
        while True:
            remaining=deadline-time.monotonic()
            if remaining<=0 or not selector.select(remaining):raise EntryError('INPUT_DEADLINE')
            chunk=os.read(sys.stdin.fileno(),65536)
            if not chunk:break
            raw.extend(chunk)
            if len(raw)>67108864:raise EntryError('INPUT_BYTE_LIMIT')
    finally:selector.close()
    def pairs(rows):
        result={}
        for key,value in rows:
            if key in result:raise EntryError('INPUT_DUPLICATE_KEY')
            result[key]=value
        return result
    try:
        value=json.loads(raw.decode('utf-8',errors='strict'),object_pairs_hook=pairs,parse_constant=lambda _value:(_ for _ in ()).throw(EntryError('INPUT_NUMBER_INVALID')))
        if type(value) is not dict or set(value)-{'profile','qualification','authorization','transaction_id'} or not {'profile','qualification'}<=set(value):raise EntryError('INPUT_FIELDS_INVALID')
        return value
    except (ValueError,UnicodeError,RecursionError):raise EntryError('INPUT_INVALID') from None

def _stable_file(fd,name,limit):
    handle=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
    def identity(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    try:
        before=os.fstat(handle)
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_nlink!=1 or before.st_mode&0o6022 or before.st_size>limit:raise EntryError('TOOLKIT_IMPORT_FILE_UNPROTECTED')
        raw=bytearray()
        while len(raw)<=before.st_size:
            part=os.read(handle,min(65536,before.st_size+1-len(raw)))
            if not part:break
            raw.extend(part)
        if len(raw)!=before.st_size or identity(before)!=identity(os.fstat(handle)) or identity(before)!=identity(os.stat(name,dir_fd=fd,follow_symlinks=False)):raise EntryError('TOOLKIT_IMPORT_FILE_CHANGED')
        return bytes(raw)
    finally:os.close(handle)

def _preflight_imports(path,handles,value):
    """Check protected sidecar and every possible toolkit import before executing it."""
    def pairs(rows):
        result={}
        for key,item in rows:
            if key in result:raise EntryError('TOOLKIT_MANIFEST_INVALID')
            result[key]=item
        return result
    manifest=json.loads(_stable_file(handles[-4],path.parents[2].name+'.manifest.json',33554432),object_pairs_hook=pairs)
    required={'schema','kind','source_sha','tree_sha','node_sha256','uid_policy','entries','sha256'}
    if type(manifest) is not dict or set(manifest)!=required or manifest['schema']!='RBRIDGE_INSTALL_TOOLKIT_V1' or manifest['kind']!='TOOLKIT' or manifest['uid_policy']!='ROOT_IMMUTABLE_RUNTIME_READABLE' or manifest['source_sha']!=path.parents[2].name[8:] or type(manifest['entries']) is not list or len(manifest['entries'])>100000:raise EntryError('TOOLKIT_MANIFEST_INVALID')
    raw=json.dumps({k:v for k,v in manifest.items() if k!='sha256'},ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')
    profile=value['profile']
    if hashlib.sha256(raw).hexdigest()!=manifest['sha256'] or manifest['sha256']!=profile['toolkit']['manifest_sha256'] or manifest['source_sha']!=profile['toolkit']['source_sha'] or manifest['tree_sha']!=profile['toolkit']['tree_sha'] or manifest['node_sha256']!=profile['runtime']['node_sha256']:raise EntryError('TOOLKIT_MANIFEST_NOT_PINNED')
    entries={};prefix='ops/install/rbridge_installation/'
    for entry in manifest['entries']:
        if type(entry) is not dict or set(entry)!={'path','kind','size','mode','sha256','target'} or type(entry['path']) is not str or entry['path'] in entries:raise EntryError('TOOLKIT_MANIFEST_INVALID')
        entries[entry['path']]=entry
    imports=[p for p in entries if p.startswith(prefix) and entries[p]['kind']=='FILE']
    if any(not re.fullmatch(re.escape(prefix)+r'[a-z_][a-z0-9_]*\.py',p) for p in imports) or prefix+'__init__.py' not in imports:raise EntryError('TOOLKIT_IMPORT_SET_INVALID')
    package_fd=os.open('rbridge_installation',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=handles[-1]);docs_fd=None;contract_fd=None
    try:
        package=os.fstat(package_fd)
        if package.st_uid!=0 or package.st_mode&0o6022 or set(os.listdir(package_fd))!={p[len(prefix):] for p in imports}:raise EntryError('TOOLKIT_IMPORT_SET_INVALID')
        for relative in ['ops/install/rbridge_install.py',*imports]:
            entry=entries[relative];fd=handles[-1] if relative.endswith('/rbridge_install.py') else package_fd;data=_stable_file(fd,Path(relative).name,1048576)
            if entry['kind']!='FILE' or len(data)!=entry['size'] or hashlib.sha256(data).hexdigest()!=entry['sha256']:raise EntryError('TOOLKIT_IMPORT_BYTES_CHANGED')
        docs_fd=os.open('docs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=handles[-3]);contract_fd=os.open('contracts',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=docs_fd)
        for fd in (docs_fd,contract_fd):
            row=os.fstat(fd)
            if row.st_uid!=0 or row.st_mode&0o6022:raise EntryError('TOOLKIT_IMPORT_FILE_UNPROTECTED')
        relative='docs/contracts/P2A_INSTALLATION_TOOLKIT_V1.json';entry=entries[relative];data=_stable_file(contract_fd,Path(relative).name,2097152)
        if entry['kind']!='FILE' or len(data)!=entry['size'] or hashlib.sha256(data).hexdigest()!=entry['sha256']:raise EntryError('TOOLKIT_IMPORT_BYTES_CHANGED')
    finally:
        for fd in (package_fd,docs_fd,contract_fd):
            if fd is not None:os.close(fd)

def import_protected_toolkit(value):
    if os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site:raise EntryError('ROOT_ISOLATED_INTERPRETER_REQUIRED')
    path=Path(os.path.abspath(__file__))
    if not re.fullmatch(r'/usr/local/libexec/rbridge/releases/toolkit-[0-9a-f]{40}/ops/install/rbridge_install\.py',str(path)):raise EntryError('PROTECTED_TOOLKIT_ENTRY_REQUIRED')
    handles=[];flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
    try:
        fd=os.open('/',flags);handles.append(fd)
        for part in path.parts[1:-1]:
            before=os.stat(part,dir_fd=fd,follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode) or before.st_uid!=0 or before.st_mode&0o6022:raise EntryError('TOOLKIT_PARENT_UNPROTECTED')
            child=os.open(part,flags,dir_fd=fd);handles.append(child)
            if (before.st_dev,before.st_ino,before.st_mode,before.st_uid,before.st_gid)!=(lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid))(os.fstat(child)):raise EntryError('TOOLKIT_PARENT_CHANGED')
            fd=child
        own=os.stat(path.name,dir_fd=fd,follow_symlinks=False)
        if not stat.S_ISREG(own.st_mode) or own.st_uid!=0 or own.st_nlink!=1 or own.st_mode&0o6022:raise EntryError('TOOLKIT_ENTRY_UNPROTECTED')
        _preflight_imports(path,handles,value)
        package=path.parent/'rbridge_installation'
        spec=importlib.util.spec_from_file_location('rbridge_installation',package/'__init__.py',submodule_search_locations=[str(package)])
        if spec is None or spec.loader is None:raise EntryError('TOOLKIT_IMPORT_UNAVAILABLE')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        from rbridge_installation.qualification import verify_import_closure
        verify_import_closure(path.parents[2],value['profile'],value['qualification'])
    finally:
        for fd in reversed(handles):os.close(fd)

def foreground_hold(prepared,result):
    """No automatic old start or ownership release; deadline leaves a durable block."""
    from rbridge_installation.models import encode_report
    emit(json.loads(encode_report(result)))
    if result.exit_code==0 or prepared.lease is None:return result.exit_code
    next_report=time.monotonic()+30
    while time.monotonic()<prepared.lease.deadline:
        try:prepared.lease.check_exclusion()
        except ValueError:break
        if time.monotonic()>=next_report:
            emit({'schema':'RBRIDGE_INSTALL_FOREGROUND_HOLD_V1','status':'HOLD','phase':result.phase,'transaction_id':prepared.ledger.transaction_id,'old_restart_forbidden':True,'lock_scope':'CURRENT_FOREGROUND_PROCESS_ONLY'});next_report=time.monotonic()+30
        time.sleep(min(1,max(0,prepared.lease.deadline-time.monotonic())))
    emit({'schema':'RBRIDGE_INSTALL_FOREGROUND_HOLD_V1','status':'UNKNOWN','phase':'HOLD_UNSETTLED','transaction_id':prepared.ledger.transaction_id,'old_restart_forbidden':True,'lock_scope':'REQUIRES_FRESH_REACQUISITION_AFTER_EXIT','reason_codes':['FOREGROUND_WINDOW_ENDED']})
    return 2

def dispatch(operation,value):
    from rbridge_installation.profile import parse_profile
    from rbridge_installation.transaction import prepare_installation,QualificationInputs,SwitchAuthorization,apply_installation,resume_installation
    if operation not in OPERATIONS:raise EntryError('OPERATION_NOT_APPROVED')
    qualification=value.get('qualification')
    if (type(qualification) is not dict or set(qualification)!={'python_closure_sha256','custody'}
            or type(qualification['python_closure_sha256']) is not str
            or re.fullmatch('[0-9a-f]{64}',qualification['python_closure_sha256']) is None
            or type(qualification['custody']) is not dict):raise EntryError('QUALIFICATION_CUSTODY_INPUT_REQUIRED')
    auth=None;transaction_id=value.get('transaction_id')
    if operation=='apply':
        auth=value.get('authorization')
        if type(auth) is not dict or set(auth)!=set(SwitchAuthorization.__dataclass_fields__):raise EntryError('SWITCH_AUTHORIZATION_MISSING')
    if operation in ('resume','status') and (type(transaction_id) is not str or not re.fullmatch('[0-9a-f]{32}',transaction_id)):
        raise EntryError('TRANSACTION_ID_INVALID')
    from rbridge_installation.qualification_custody import open_root_qualification_custody
    profile=parse_profile(value['profile'])
    bundle=open_root_qualification_custody(profile,qualification['custody'],
        {'python_closure_sha256':qualification['python_closure_sha256']})
    prepared=prepare_installation(profile,QualificationInputs(bundle))
    if prepared.status!='READY':emit(blocked('PREPARATION_UNQUALIFIED'));return 2
    if operation in ('prepare','check'):
        emit({'schema':'RBRIDGE_INSTALL_PREPARATION_V1','status':'READY','scope':'PREPARATION_ONLY','profile_sha256':prepared.profile_sha256,'runtime_manifest_sha256':prepared.runtime_manifest.sha256,'toolkit_manifest_sha256':prepared.toolkit_manifest_sha256,'readers_sha256':prepared.readers_sha256,'helper_sha256':prepared.helper_sha256,'switch_authorized':False});return 0
    if operation=='apply':
        from rbridge_installation.host_backend import QualifiedHostBackend
        backend=QualifiedHostBackend(profile);result=apply_installation(prepared,SwitchAuthorization(**auth),backend)
        return foreground_hold(prepared,result)
    from rbridge_installation.qualification import open_qualified_resume_ledger
    ledger=open_qualified_resume_ledger(prepared.bundle,transaction_id);prepared.ledger=ledger
    if operation=='status':
        snapshot=ledger.read();emit({'schema':'RBRIDGE_INSTALL_STATUS_V1','status':'OBSERVED','scope':'DURABLE_LEDGER_ONLY','transaction_id':transaction_id,'phase':snapshot.entries[-1].marker if snapshot.entries else 'EMPTY','ledger_sha256':snapshot.sha256,'start_attempted':any(e.marker=='START_ATTEMPTED' for e in snapshot.entries),'live_state':'NOT_OBSERVED'});ledger.close();return 0
    from rbridge_installation.host_backend import QualifiedHostBackend
    backend=QualifiedHostBackend(profile);backend.resume_preparation=prepared;result=resume_installation(profile,ledger,backend)
    return foreground_hold(prepared,result)

def main():
    try:
        if len(sys.argv)!=2 or sys.argv[1] not in OPERATIONS:raise EntryError('OPERATION_NOT_APPROVED')
        value=read_input();import_protected_toolkit(value);return dispatch(sys.argv[1],value)
    except (ValueError,TypeError,KeyError,OSError,ImportError,AttributeError,RecursionError):
        emit(blocked('ENTRY_PRECONDITIONS_UNQUALIFIED'));return 2

if __name__=='__main__':raise SystemExit(main())
