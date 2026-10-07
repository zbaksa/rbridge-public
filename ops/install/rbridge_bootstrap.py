#!/usr/bin/python3
"""Standalone stdlib bootstrap predicates and protected create-only publication.

Byte comparison is never execution authority. Production command rendering is
delegated to the concrete qualification bundle after its origin is revalidated.
This file imports no toolkit, runtime-owned module or external dependency while
verifying an artifact or copying its bytes.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys


class BootstrapError(ValueError):pass


def _fail(reason):raise BootstrapError(reason)


def _json(raw,limit=65536):
    if type(raw) is not bytes or not 0<len(raw)<=limit:_fail('BOOTSTRAP_CAPTURE_BYTE_LIMIT')
    def pairs(rows):
        out={}
        for k,v in rows:
            if k in out:_fail('BOOTSTRAP_DUPLICATE_KEY')
            out[k]=v
        return out
    try:return json.loads(raw.decode('utf-8',errors='strict'),object_pairs_hook=pairs,
        parse_constant=lambda _:(_ for _ in ()).throw(BootstrapError('BOOTSTRAP_NUMBER_INVALID')))
    except (UnicodeError,ValueError,RecursionError):_fail('BOOTSTRAP_JSON_INVALID')


def _hash(value,length=64):return type(value) is str and re.fullmatch('[0-9a-f]{'+str(length)+'}',value) is not None


def verify_bootstrap_artifact(payload,manifest,authenticated_capture,binding):
    """Compare complete data; origin belongs to the qualified retrieval driver.

    Even a matching fixture labelled authenticated cannot obtain may_execute.
    The exact expected manifest/binding must come from the reviewed owner bundle.
    """
    fields={'schema','source_sha','tree_sha','payload_bytes','payload_sha256',
        'toolkit_manifest_sha256','python_closure_sha256'}
    if (type(manifest) is not dict or set(manifest)!=fields or manifest['schema']!='RBRIDGE_BOOTSTRAP_MANIFEST_V1'
            or any(not _hash(manifest[k],40) for k in ('source_sha','tree_sha'))
            or any(not _hash(manifest[k]) for k in ('payload_sha256','toolkit_manifest_sha256','python_closure_sha256'))
            or type(manifest['payload_bytes']) is not int or not 1<=manifest['payload_bytes']<=49152
            or type(payload) is not bytes or len(payload)!=manifest['payload_bytes']
            or hashlib.sha256(payload).hexdigest()!=manifest['payload_sha256']):_fail('BOOTSTRAP_PAYLOAD_NOT_PINNED')
    try:payload.decode('utf-8',errors='strict')
    except UnicodeError:_fail('BOOTSTRAP_PAYLOAD_ENCODING_INVALID')
    if (type(binding) is not dict or set(binding)!={'repository','author','issue_number'}
            or type(binding['repository']) is not str or not re.fullmatch('[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}',binding['repository'])
            or type(binding['author']) is not str or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9-]{0,38}',binding['author'])
            or type(binding['issue_number']) is not int or not 1<=binding['issue_number']<=2147483647):_fail('BOOTSTRAP_BINDING_INVALID')
    capture=authenticated_capture
    if (type(capture) is not dict or set(capture)!={'schema','repository','viewer','author','issue_number','is_pull_request','url','body'}
            or capture['schema']!='RBRIDGE_BOOTSTRAP_ARTIFACT_CAPTURE_V1' or capture['repository']!=binding['repository']
            or capture['viewer']!=binding['author'] or capture['author']!=binding['author']
            or type(capture['issue_number']) is not int or capture['issue_number']!=binding['issue_number']
            or capture['is_pull_request'] is not False
            or capture['url']!='https://github.com/'+binding['repository']+'/issues/'+str(binding['issue_number'])
            or type(capture['body']) is not str):_fail('BOOTSTRAP_CAPTURE_IDENTITY_INVALID')
    body=_json(capture['body'].encode('utf-8',errors='strict'))
    if (type(body) is not dict or set(body)!={'schema','manifest','payload_base64'}
            or body['schema']!='RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1'
            or json.dumps(body['manifest'],sort_keys=True,separators=(',',':'))!=json.dumps(manifest,sort_keys=True,separators=(',',':'))
            or type(body['payload_base64']) is not str):_fail('BOOTSTRAP_ARTIFACT_INVALID')
    try:decoded=base64.b64decode(body['payload_base64'],validate=True)
    except (ValueError,TypeError):_fail('BOOTSTRAP_ARTIFACT_INVALID')
    if decoded!=payload or base64.b64encode(decoded).decode()!=body['payload_base64']:_fail('BOOTSTRAP_ARTIFACT_INVALID')
    return {'schema':'RBRIDGE_BOOTSTRAP_BYTE_PROOF_V1','status':'PASS','scope':'ARTIFACT_BYTES_ONLY',
        'may_execute':False,'payload_sha256':manifest['payload_sha256'],'payload_bytes':len(payload),
        'manifest_sha256':hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
        'capture_sha256':hashlib.sha256(json.dumps(capture,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()}


def source_exit_wrapper(argv):
    """Shell-status fixture and common wrapper shape, never an authority token."""
    if type(argv) not in (list,tuple) or not argv or any(type(a) is not str or '\0' in a or '\n' in a for a in argv):
        _fail('BOOTSTRAP_ARGV_INVALID')
    # The final subshell returns the child code without terminating the parent.
    # A caller's errexit/nounset settings must not destroy the interactive shell.
    return ('set +e\nset +u\nset +E\nset +o pipefail\n'+shlex.join(argv)+
        '\nrbridge_bootstrap_outer_exit=$?\nprintf "RBRIDGE_OUTER_EXIT=%s\\n" "$rbridge_bootstrap_outer_exit"\n'+
        '(exit "$rbridge_bootstrap_outer_exit")\n')


def render_owner_command(bundle):
    """Only the concrete private qualification module may supply command pins."""
    try:
        from rbridge_installation.qualification import qualified_owner_command
        command=qualified_owner_command(bundle)
    except (ImportError,AttributeError,ValueError,TypeError):_fail('BOOTSTRAP_QUALIFICATION_BLOCKED')
    return command


def _identity(s):
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)


def _publish(parent,payload,manifest,capture,binding,production,root_fixture=False):
    proof=verify_bootstrap_artifact(payload,manifest,capture,binding)
    path=Path(parent)
    if not path.is_absolute() or any(p in ('','..','.') for p in str(path).split('/')[1:]):_fail('BOOTSTRAP_PARENT_INVALID')
    owner=os.getuid();handles=[];links=[];payload_fd=None;stage_fd=None
    if production:
        if owner!=0 or os.geteuid()!=0 or not sys.flags.isolated:_fail('BOOTSTRAP_ROOT_ISOLATION_REQUIRED')
        if root_fixture:
            if not re.fullmatch('/root/\\.rbridge-bootstrap-fixture-[0-9a-f]{32}',str(path)):_fail('BOOTSTRAP_PARENT_UNQUALIFIED')
        elif str(path)!='/var/lib/rbridge-maintenance':_fail('BOOTSTRAP_PARENT_UNQUALIFIED')
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
    def stable(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid)
    try:
        fd=os.open('/',flags);handles.append(fd)
        for i,part in enumerate(path.parts[1:]):
            before=os.stat(part,dir_fd=fd,follow_symlinks=False)
            expected=0 if production else owner
            # Source temporary ancestors can have the system sticky mode; the
            # named final fixture parent must still be exclusively private.
            final=i==len(path.parts)-2
            if (not stat.S_ISDIR(before.st_mode) or production and (before.st_uid!=expected or before.st_mode&0o6022)
                    or final and (before.st_uid!=owner or before.st_mode&0o7777!=0o700)):_fail('BOOTSTRAP_PARENT_UNQUALIFIED')
            child=os.open(part,flags,dir_fd=fd);handles.append(child)
            if stable(before)!=stable(os.fstat(child)):_fail('BOOTSTRAP_PARENT_CHANGED')
            links.append((fd,part,child,before));fd=child
        def check():
            for ancestor,name,child,before in links:
                if stable(before)!=stable(os.fstat(child)) or stable(before)!=stable(os.stat(name,dir_fd=ancestor,follow_symlinks=False)):
                    _fail('BOOTSTRAP_PARENT_CHANGED')
        check();name='bootstrap-'+manifest['payload_sha256'];os.mkdir(name,0o700,dir_fd=fd);os.fsync(fd)
        stage_fd=os.open(name,flags,dir_fd=fd);stage=os.fstat(stage_fd)
        if stage.st_uid!=owner or stage.st_mode&0o7777!=0o700:_fail('BOOTSTRAP_STAGE_UNQUALIFIED')
        payload_fd=os.open('payload.py',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=stage_fd)
        data=memoryview(payload)
        while data:
            count=os.write(payload_fd,data)
            if count<=0:_fail('BOOTSTRAP_WRITE_UNCERTAIN')
            data=data[count:]
        os.fchmod(payload_fd,0o400);os.fsync(payload_fd);before=os.fstat(payload_fd)
        os.fsync(stage_fd);check()
        os.lseek(payload_fd,0,os.SEEK_SET);readback=bytearray()
        while len(readback)<=len(payload):
            part=os.read(payload_fd,len(payload)+1-len(readback))
            if not part:break
            readback.extend(part)
        if (readback!=payload or before.st_uid!=owner or before.st_nlink!=1 or before.st_mode&0o7777!=0o400
                or _identity(before)!=_identity(os.fstat(payload_fd))
                or _identity(before)!=_identity(os.stat('payload.py',dir_fd=stage_fd,follow_symlinks=False))
                or stable(stage)!=stable(os.stat(name,dir_fd=fd,follow_symlinks=False))
                or os.listdir(stage_fd)!=['payload.py']):_fail('BOOTSTRAP_READBACK_UNCERTAIN')
        check()
        return {**proof,'path':str(path/name/'payload.py'),
            'scope':'ROOT_PROTECTED_BYTES_ONLY' if production else 'FIXTURE_AUTHORITY_ONLY','may_execute':False,
            'identity':list(map(str,_identity(before)))}
    except OSError:_fail('BOOTSTRAP_PUBLICATION_UNCERTAIN')
    finally:
        if payload_fd is not None:os.close(payload_fd)
        if stage_fd is not None:os.close(stage_fd)
        for handle in reversed(handles):os.close(handle)


def publish_bootstrap_artifact(parent,payload,manifest,capture,binding):
    return _publish(parent,payload,manifest,capture,binding,True)


def _publish_fixture_bootstrap(parent,payload,manifest,capture,binding):
    return _publish(parent,payload,manifest,capture,binding,False)


def _publish_root_fixture_bootstrap(parent,payload,manifest,capture,binding):
    """Protected byte mechanics only; actual origin belongs to the Root collector."""
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'):
        _fail('BOOTSTRAP_ROOT_FIXTURE_CONTEXT_UNQUALIFIED')
    return _publish(parent,payload,manifest,capture,binding,True,True)


def _validate_fixture_namespace(value):
    """Stdlib pre-import predicate, never a kernel observation or authority."""
    def fail():_fail('BOOTSTRAP_EXECUTION_NAMESPACE_UNQUALIFIED')
    keys={'pid','self_link','self_status','pid1_status','uid_map','gid_map','namespaces','mountinfo'}
    if (type(value) is not dict or set(value)!=keys or type(value['pid']) is not int or not 2<=value['pid']<=2147483647
            or any(type(value[k]) is not str or len(value[k].encode())>1048576 for k in keys-{'pid','namespaces'})
            or value['self_link']!=str(value['pid'])):fail()
    for key,pid in (('self_status',value['pid']),('pid1_status',1)):
        pids=re.findall(r'^Pid:\s*([0-9]+)$',value[key],re.M)
        nested=re.findall(r'^NSpid:\s*([0-9 \t]+)$',value[key],re.M)
        if pids!=[str(pid)] or len(nested)!=1 or nested[0].split()!=[str(pid)]:fail()
    for key in ('uid_map','gid_map'):
        if [row.split() for row in value[key].splitlines() if row.strip()]!=[['0','0','4294967295']]:fail()
    if type(value['namespaces']) is not dict or set(value['namespaces'])!={'pid','mnt','user','cgroup'}:fail()
    for kind,links in value['namespaces'].items():
        if (type(links) is not list or len(links)!=2 or links[0]!=links[1] or type(links[0]) is not str
                or not re.fullmatch(re.escape(kind)+r':\[[1-9][0-9]{0,19}\]',links[0])):fail()
    required={'/proc':'proc','/sys/fs/cgroup':'cgroup2'};found={}
    for row in value['mountinfo'].splitlines():
        fields=row.split()
        if len(fields)<10 or fields.count('-')!=1:fail()
        separator=fields.index('-')
        if separator<6 or len(fields)-separator!=4:fail()
        if fields[4] in required:
            if fields[4] in found or fields[3]!='/' or fields[separator+1]!=required[fields[4]]:fail()
            found[fields[4]]=fields[separator+1]
    if found!=required:fail()


def _fixture_namespace():
    def read(path,limit=65536):
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            raw=bytearray()
            while len(raw)<=limit:
                part=os.read(fd,min(65536,limit+1-len(raw)))
                if not part:break
                raw.extend(part)
            if len(raw)>limit:_fail('BOOTSTRAP_EXECUTION_NAMESPACE_UNQUALIFIED')
            return bytes(raw).decode('utf-8',errors='strict')
        finally:os.close(fd)
    def links():return {k:[os.readlink('/proc/self/ns/'+k),os.readlink('/proc/1/ns/'+k)] for k in ('pid','mnt','user','cgroup')}
    before=links();value={'pid':os.getpid(),'self_link':os.readlink('/proc/self'),
        'self_status':read('/proc/self/status'),'pid1_status':read('/proc/1/status'),
        'uid_map':read('/proc/self/uid_map'),'gid_map':read('/proc/self/gid_map'),
        'namespaces':before,'mountinfo':read('/proc/self/mountinfo',1048576)}
    _validate_fixture_namespace(value)
    if before!=links():_fail('BOOTSTRAP_EXECUTION_NAMESPACE_UNQUALIFIED')
    return value


def _fixture_context():
    path=os.path.abspath(__file__);nonce=os.environ.get('RBRIDGE_BOOTSTRAP_NONCE')
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or not re.fullmatch(r'/root/\.rbridge-bootstrap-fixture-[0-9a-f]{32}/bootstrap-[0-9a-f]{64}/payload\.py',path)
            or sys.argv!=[path,'--qualification-fixture'] or not _hash(nonce)
            or set(os.environ)!={'PATH','HOME','LC_ALL','RBRIDGE_BOOTSTRAP_NONCE'}
            or os.environ['PATH']!='/usr/bin:/bin:/usr/sbin:/sbin' or os.environ['HOME']!='/root' or os.environ['LC_ALL']!='C'):
        _fail('BOOTSTRAP_EXECUTION_CONTEXT_UNQUALIFIED')
    return Path(path),_fixture_namespace()


def _protected_file(path,limit,mode=None):
    """Fixed caller-derived protected paths only; retain every ancestor descriptor."""
    handles=[];links=[];flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC;handle=None
    def stable(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid)
    try:
        fd=os.open('/',flags);handles.append(fd)
        for name in path.parts[1:-1]:
            before=os.stat(name,dir_fd=fd,follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode) or before.st_uid!=0 or before.st_mode&0o6022:_fail('BOOTSTRAP_EXECUTION_PARENT_UNPROTECTED')
            child=os.open(name,flags,dir_fd=fd);handles.append(child)
            if stable(before)!=stable(os.fstat(child)):_fail('BOOTSTRAP_EXECUTION_PARENT_CHANGED')
            links.append((fd,name,child,before));fd=child
        handle=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd);before=os.fstat(handle)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_nlink!=1 or before.st_mode&0o6022
                or not 0<before.st_size<=limit or mode is not None and before.st_mode&0o7777!=mode):_fail('BOOTSTRAP_EXECUTION_FILE_UNPROTECTED')
        raw=bytearray()
        while len(raw)<=before.st_size:
            part=os.read(handle,min(65536,before.st_size+1-len(raw)))
            if not part:break
            raw.extend(part)
        if (len(raw)!=before.st_size or _identity(before)!=_identity(os.fstat(handle))
                or _identity(before)!=_identity(os.stat(path.name,dir_fd=fd,follow_symlinks=False))):_fail('BOOTSTRAP_EXECUTION_FILE_CHANGED')
        for parent,name,child,previous in links:
            if stable(previous)!=stable(os.fstat(child)) or stable(previous)!=stable(os.stat(name,dir_fd=parent,follow_symlinks=False)):
                _fail('BOOTSTRAP_EXECUTION_PARENT_CHANGED')
        return bytes(raw),list(map(str,_identity(before)))
    finally:
        if handle is not None:os.close(handle)
        for fd in reversed(handles):os.close(fd)


def _bounded_input():
    import selectors
    import time
    selector=selectors.DefaultSelector();raw=bytearray();deadline=time.monotonic()+15
    try:
        selector.register(sys.stdin.buffer,selectors.EVENT_READ)
        while True:
            remaining=deadline-time.monotonic()
            if remaining<=0 or not selector.select(remaining):_fail('BOOTSTRAP_EXECUTION_INPUT_DEADLINE')
            part=os.read(sys.stdin.fileno(),65536)
            if not part:break
            raw.extend(part)
            if len(raw)>67108864:_fail('BOOTSTRAP_EXECUTION_INPUT_BYTE_LIMIT')
    finally:selector.close()
    value=_json(bytes(raw),67108864)
    if type(value) is not dict:_fail('BOOTSTRAP_EXECUTION_INPUT_INVALID')
    return value


def _fixture_input():
    value=_bounded_input()
    if type(value) is not dict or set(value)!={'profile','qualification'}:_fail('BOOTSTRAP_EXECUTION_INPUT_INVALID')
    return value


def _fixture_toolkit(value,payload):
    import importlib.util
    profile=value['profile'];pin=profile['toolkit'];parent='/usr/local/libexec/rbridge/releases'
    if (profile['paths']['release_parent']!=parent or not _hash(pin['source_sha'],40)
            or not _hash(pin['tree_sha'],40) or not _hash(pin['manifest_sha256'])):_fail('BOOTSTRAP_EXECUTION_TOOLKIT_UNQUALIFIED')
    root=Path(parent)/('toolkit-'+pin['source_sha']);raw,_=_protected_file(root.with_name(root.name+'.manifest.json'),33554432)
    manifest=_json(raw,33554432)
    required={'schema','kind','source_sha','tree_sha','node_sha256','uid_policy','entries','sha256'}
    if (type(manifest) is not dict or set(manifest)!=required or manifest['schema']!='RBRIDGE_INSTALL_TOOLKIT_V1'
            or manifest['kind']!='TOOLKIT' or manifest['uid_policy']!='ROOT_IMMUTABLE_RUNTIME_READABLE'
            or manifest['sha256']!=pin['manifest_sha256'] or manifest['source_sha']!=pin['source_sha']
            or manifest['tree_sha']!=pin['tree_sha'] or manifest['node_sha256']!=profile['runtime']['node_sha256']
            or type(manifest['entries']) is not list or len(manifest['entries'])>100000
            or hashlib.sha256(json.dumps({k:v for k,v in manifest.items() if k!='sha256'},ensure_ascii=False,sort_keys=True,
                separators=(',',':'),allow_nan=False).encode()).hexdigest()!=manifest['sha256']):_fail('BOOTSTRAP_EXECUTION_TOOLKIT_UNQUALIFIED')
    entries={}
    for row in manifest['entries']:
        if type(row) is not dict or set(row)!={'path','kind','size','mode','sha256','target'} or type(row['path']) is not str or row['path'] in entries:
            _fail('BOOTSTRAP_EXECUTION_TOOLKIT_UNQUALIFIED')
        entries[row['path']]=row
    for relative in ('ops/install/rbridge_bootstrap.py','ops/install/rbridge_install.py'):
        entry=entries[relative];data,_=_protected_file(root/relative,49152 if relative.endswith('rbridge_bootstrap.py') else 1048576)
        if (entry['kind']!='FILE' or type(entry['size']) is not int or len(data)!=entry['size']
                or hashlib.sha256(data).hexdigest()!=entry['sha256'] or relative.endswith('rbridge_bootstrap.py') and data!=payload):
            _fail('BOOTSTRAP_EXECUTION_TOOLKIT_BYTES_CHANGED')
    path=root/'ops/install/rbridge_install.py';spec=importlib.util.spec_from_file_location('_rbridge_protected_install_entry',path)
    if spec is None or spec.loader is None:_fail('BOOTSTRAP_EXECUTION_TOOLKIT_UNQUALIFIED')
    module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module
    # Execute the bytes just checked, rather than a loader-selected cached pyc.
    exec(compile(data,str(path),'exec'),module.__dict__)
    module.import_protected_toolkit(value)
    from rbridge_installation.profile import parse_profile
    from rbridge_installation.qualification import verify_import_closure
    p=parse_profile(profile)
    closure=verify_import_closure(root,p,value['qualification']);pin=value['qualification']['python_closure_sha256']
    if p.paths.ledger_parent!='/var/lib/rbridge-maintenance' or not _hash(pin):_fail('BOOTSTRAP_EXECUTION_TOOLKIT_UNQUALIFIED')
    raw,_=_protected_file(Path(p.paths.ledger_parent)/('python-closure-'+pin+'.json'),67108864)
    python_manifest=_json(raw,67108864)
    from rbridge_installation.models import encode_report
    if encode_report(python_manifest)!=raw:_fail('BOOTSTRAP_EXECUTION_CLOSURE_NOT_CANONICAL')
    return p,closure,python_manifest


def _run_qualification_fixture():
    path,kernel=_fixture_context();payload,identity=_protected_file(path,49152,0o400)
    digest=hashlib.sha256(payload).hexdigest()
    if path.parent.name!='bootstrap-'+digest:_fail('BOOTSTRAP_EXECUTION_PAYLOAD_CHANGED')
    sys.stderr.write(json.dumps({'schema':'RBRIDGE_INSTALL_HELPER_READY_V1','pid':os.getpid(),
        'nonce':os.environ['RBRIDGE_BOOTSTRAP_NONCE']},sort_keys=True,separators=(',',':'))+'\n');sys.stderr.flush()
    value=_fixture_input();p,closure,python_manifest=_fixture_toolkit(value,payload)
    after,observed=_protected_file(path,49152,0o400)
    if after!=payload or observed!=identity:_fail('BOOTSTRAP_EXECUTION_PAYLOAD_CHANGED')
    report={'schema':'RBRIDGE_BOOTSTRAP_EXECUTION_REPORT_V1','status':'PASS','scope':'ROOT_INTERPRETER_READONLY_PROBE',
        'operation':'QUALIFICATION_FIXTURE_ONLY','profile_sha256':closure['profile_sha256'],
        'toolkit_manifest_sha256':p.toolkit.manifest_sha256,'python_closure_sha256':value['qualification']['python_closure_sha256'],
        'payload_sha256':digest,'payload_bytes':len(payload),'payload_path':str(path),'payload_identity':identity,
        'kernel_namespace':kernel,'import_closure':closure,'python_manifest':python_manifest,
        'may_execute':False,'service_action_authorized':False}
    print(json.dumps(report,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False));return 0


def _owner_context():
    """Observe actual Root context before reading input or importing a toolkit."""
    path=os.path.abspath(__file__);argv=sys.argv
    original=re.fullmatch(r'/usr/local/libexec/rbridge/releases/toolkit-[0-9a-f]{40}/ops/install/rbridge_bootstrap\.py',path)
    copied=re.fullmatch(r'/root/\.rbridge-bootstrap-fixture-[0-9a-f]{32}/bootstrap-[0-9a-f]{64}/payload\.py',path)
    retrieve=len(argv)==3 and argv[1]=='--retrieve' and original
    dispatch=len(argv)==4 and argv[1]=='--dispatch' and copied
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/' or not (retrieve or dispatch)
            or argv[0]!=path or argv[2] not in ('prepare','check','apply','resume','status')
            or set(os.environ)!={'PATH','HOME','LC_ALL'} or os.environ['PATH']!='/usr/bin:/bin:/usr/sbin:/sbin'
            or os.environ['HOME']!='/root' or os.environ['LC_ALL']!='C'):_fail('BOOTSTRAP_OWNER_CONTEXT_UNQUALIFIED')
    if dispatch and re.fullmatch(r'/root/\.rbridge-privileged-[0-9a-f]{32}/evidence\.json',argv[3]) is None:
        _fail('BOOTSTRAP_OWNER_INPUT_PATH_UNQUALIFIED')
    _fixture_namespace();return Path(path),argv[1],argv[2]


def _run_owner_command():
    path,mode,operation=_owner_context();payload,identity=_protected_file(path,49152,0o400 if mode=='--dispatch' else None)
    if mode=='--dispatch' and path.parent.name!='bootstrap-'+hashlib.sha256(payload).hexdigest():
        _fail('BOOTSTRAP_OWNER_PAYLOAD_CHANGED')
    if mode=='--retrieve':value=_bounded_input()
    else:
        raw,_input_identity=_protected_file(Path(sys.argv[3]),67108864,0o600)
        value=_json(raw,67108864)
        if json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()!=raw:
            _fail('BOOTSTRAP_OWNER_INPUT_NOT_CANONICAL')
    p,_closure,_python_manifest=_fixture_toolkit(value,payload)
    from rbridge_installation.owner_command import owner_command_recipe,collect_root_owner_command_review,verify_root_owner_command,entry_input
    from rbridge_installation.qualification_custody import open_root_qualification_custody
    from rbridge_installation.bootstrap_collector import collect_root_bootstrap_bytes
    from rbridge_installation.copy_ledger_collector import _FixtureDirectory
    from rbridge_installation.models import encode_report
    owner_command_recipe(p,operation,value)
    request={'python_closure_sha256':value['qualification']['python_closure_sha256']}
    bundle=open_root_qualification_custody(p,value['qualification']['custody'],request)
    bootstrap=collect_root_bootstrap_bytes(p,bundle.runtime_manifest,bundle.toolkit_manifest,
        value['bootstrap']['manifest'],value['bootstrap']['issue_number'],request)
    review=collect_root_owner_command_review(p,bundle,bootstrap,operation,value)
    actual=verify_root_owner_command(p,review,bundle=bundle)
    evidence=actual['evidence']['bootstrap'];remote=base64.b64decode(evidence['payload_base64'],validate=True)
    after,observed=_protected_file(path,49152,0o400 if mode=='--dispatch' else None)
    if after!=payload or observed!=identity or remote!=payload:_fail('BOOTSTRAP_OWNER_PAYLOAD_CHANGED')
    if mode=='--retrieve':
        # A fresh retained private directory avoids adopting any existing copy.
        stage=_FixtureDirectory(p,prefix='.rbridge-bootstrap-fixture-',limit=p.budget.carrier_bytes)
        try:
            capture=evidence['evidence']['capture'];binding={'repository':p.binding.repository,'author':p.binding.author,
                'issue_number':value['bootstrap']['issue_number']}
            published=_publish_root_fixture_bootstrap(stage.path,payload,value['bootstrap']['manifest'],capture,binding)
            stage.check();copy_path=Path(published['path']);copied,copied_identity=_protected_file(copy_path,49152,0o400)
            if copied!=payload or copied_identity!=published['identity']:_fail('BOOTSTRAP_OWNER_COPY_CHANGED')
        finally:stage.close()
        fixture=_FixtureDirectory(p,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
        try:
            fixture.write(encode_report(value));input_path=fixture.path/'evidence.json'
            retained,_retained_identity=_protected_file(input_path,p.budget.carrier_bytes,0o600)
            if retained!=encode_report(value):_fail('BOOTSTRAP_OWNER_INPUT_CHANGED')
        finally:fixture.close()
        # Recheck before replacement. The new interpreter authenticates and
        # reviews again; no former in-memory producer token crosses this exec.
        verify_root_owner_command(p,review,bundle=bundle)
        final,final_identity=_protected_file(copy_path,49152,0o400)
        if final!=payload or final_identity!=copied_identity:_fail('BOOTSTRAP_OWNER_COPY_CHANGED')
        os.execve(p.toolkit.python_path,[p.toolkit.python_path,'-I','-S','-B',str(copy_path),'--dispatch',operation,str(input_path)],
            {'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/root','LC_ALL':'C'})
        _fail('BOOTSTRAP_OWNER_EXEC_UNCERTAIN')
    entry=sys.modules.get('_rbridge_protected_install_entry')
    expected=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)/'ops/install/rbridge_install.py'
    if entry is None or Path(entry.__file__)!=expected:_fail('BOOTSTRAP_OWNER_ENTRY_UNQUALIFIED')
    return entry.dispatch(operation,entry_input(value),reviewed_command=review)


def main():
    if len(sys.argv)>1 and sys.argv[1] in ('--retrieve','--dispatch'):
        try:return _run_owner_command()
        except BootstrapError as error:reason=str(error)
        except (ValueError,TypeError,KeyError,OSError,ImportError,AttributeError,RecursionError):reason='BOOTSTRAP_OWNER_PRECONDITIONS_UNQUALIFIED'
        print(json.dumps({'schema':'RBRIDGE_BOOTSTRAP_ENTRY_V1','status':'BLOCKED','scope':'UNQUALIFIED',
            'may_execute':False,'reason_codes':[reason]},sort_keys=True));return 2
    if len(sys.argv)==2 and sys.argv[1]=='--qualification-fixture':
        try:return _run_qualification_fixture()
        except BootstrapError as error:reason=str(error)
        except (ValueError,TypeError,KeyError,OSError,ImportError,AttributeError,RecursionError):reason='BOOTSTRAP_EXECUTION_PRECONDITIONS_UNQUALIFIED'
        print(json.dumps({'schema':'RBRIDGE_BOOTSTRAP_ENTRY_V1','status':'BLOCKED','scope':'UNQUALIFIED',
            'may_execute':False,'reason_codes':[reason]},sort_keys=True));return 2
    # An unqualified standalone invocation cannot execute a payload or a service
    # action. Actual retrieval/closure qualification precedes command rendering.
    print(json.dumps({'schema':'RBRIDGE_BOOTSTRAP_ENTRY_V1','status':'BLOCKED',
        'scope':'UNQUALIFIED','may_execute':False,'reason_codes':['BOOTSTRAP_QUALIFICATION_REQUIRED']},sort_keys=True))
    return 2


if __name__=='__main__':raise SystemExit(main())
