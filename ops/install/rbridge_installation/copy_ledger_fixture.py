"""Fixed isolated copier/ledger exercises; data alone never confers Root origin.

Tiny known material is copied and deliberately damaged only inside an empty
private fixture directory. Two owned children die at fixed durable-ledger
boundaries. Every retained byte is compared independently of a PASS label.
"""
import base64
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import stat
import time
from .artifact import ArtifactEntry,ArtifactManifest,inventory_artifact,validate_manifest
from .ledger import MARKERS,LedgerError,_open_fixture_ledger,_decode,_strict_json,recovery_decision,ObservedTransactionState
from .models import InstallationError,encode_report,report_sha256
from .profile import parse_profile
from .protected_copy import DIR_FLAGS,FilesystemAuthority,publish_artifact,verify_published


class CopyLedgerFixtureError(InstallationError):pass
def _fail(reason):raise CopyLedgerFixtureError(reason)


FILES={
    'package.json':b'{"type":"module","dependencies":{"fixture-dependency":"1.0.0"}}',
    'package-lock.json':b'{}',
    'dist/server/server/remoteBridgeMain.js':b"import 'fixture-dependency';\n",
    'dist/server/server/rbridgeMcpMain.js':b"import 'fixture-dependency';\n",
    'node_modules/fixture-dependency/package.json':b'{"name":"fixture-dependency","version":"1.0.0"}',
    'node_modules/fixture-dependency/index.js':b'export default 1;\n'}
LINK='fixture-dependency/index.js'
TRANSACTIONS=('1'*32,'2'*32)
LIMIT=2097152
DIRECTORIES=frozenset('/'.join(name.split('/')[:i]) for name in FILES for i in range(1,len(name.split('/'))))


def _bytes(raw):return {'base64':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}


def _raw(value):
    if type(value) is not dict or set(value)!={'base64','sha256'} or type(value['base64']) is not str or len(value['base64'])>LIMIT:
        _fail('COPY_LEDGER_FIXTURE_BYTES_INVALID')
    try:raw=base64.b64decode(value['base64'],validate=True)
    except (ValueError,TypeError):_fail('COPY_LEDGER_FIXTURE_BYTES_INVALID')
    if len(raw)>LIMIT or base64.b64encode(raw).decode()!=value['base64'] or hashlib.sha256(raw).hexdigest()!=value['sha256']:
        _fail('COPY_LEDGER_FIXTURE_BYTES_INVALID')
    return raw


def _record(inputs,output):
    a,b=encode_report(inputs).decode(),encode_report(output).decode()
    return {'status':'PASS','input_json':a,'output_json':b,
        'input_sha256':hashlib.sha256(a.encode()).hexdigest(),'output_sha256':hashlib.sha256(b.encode()).hexdigest()}


def _parent(path):
    path=Path(path)
    if not path.is_absolute():_fail('COPY_LEDGER_FIXTURE_PARENT_UNPROTECTED')
    from .artifact import open_artifact_root,_identity
    fd=open_artifact_root(path)
    try:
        row=os.fstat(fd)
        if (not stat.S_ISDIR(row.st_mode) or row.st_uid!=os.getuid() or row.st_mode&0o7777!=0o700
                or _identity(row)!=_identity(path.lstat())):_fail('COPY_LEDGER_FIXTURE_PARENT_UNPROTECTED')
        if os.listdir(fd):_fail('COPY_LEDGER_FIXTURE_PARENT_NOT_EMPTY')
        return fd
    except BaseException:os.close(fd);raise


def _snapshot(path):
    return {name:_bytes((path/name).read_bytes()) for name in sorted(FILES)}


def _copy(path,profile,runtime_uid,production):
    path.mkdir(mode=0o700);stage=path/'stage';stage.mkdir(mode=0o755)
    for name,raw in FILES.items():
        target=stage/name;target.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
        with target.open('xb') as handle:handle.write(raw);handle.flush();os.fsync(handle.fileno())
        target.chmod(0o644)
    (stage/'node_modules/link').symlink_to(LINK)
    if production:
        for directory,dirs,files in os.walk(stage):
            os.chown(directory,runtime_uid,profile.binding.gid,follow_symlinks=False)
            for name in files:os.chown(Path(directory)/name,runtime_uid,profile.binding.gid,follow_symlinks=False)
            for name in dirs:
                if (Path(directory)/name).is_symlink():os.chown(Path(directory)/name,runtime_uid,profile.binding.gid,follow_symlinks=False)
    manifest=inventory_artifact(stage,'RUNTIME',profile)
    inputs={'schema':'RBRIDGE_COPY_FIXTURE_INPUT_V1','profile_sha256':report_sha256(profile),
        'fixture_kind':'TINY_FIXED_MATERIAL_ONLY','files':{name:_bytes(raw) for name,raw in sorted(FILES.items())},
        'manifest':manifest,'runtime_uid':runtime_uid,'production_copy':production}
    parent=path/'releases';rejected=path/'rejected';parent.mkdir(mode=0o700);rejected.mkdir(mode=0o700)
    fds=[]
    try:
        for p in (stage,parent,rejected):fds.append(os.open(p,DIR_FLAGS))
        def authority(p):return FilesystemAuthority(os.getuid(),runtime_uid,p,'RUNTIME',production,
            manifest.sha256,manifest.source_sha,manifest.tree_sha)
        auth=authority(parent);result=publish_artifact(fds[0],fds[1],manifest,auth)
        verified=verify_published(result.path,manifest,auth);before=_snapshot(result.path)
        try:publish_artifact(fds[0],fds[1],manifest,auth)
        except InstallationError as error:collision=error.reason
        else:_fail('COPY_LEDGER_FIXTURE_COLLISION_ACCEPTED')
        after=_snapshot(result.path)
        with (stage/'foreign.txt').open('xb') as handle:handle.write(b'fixed unmanifested fixture\n');handle.flush();os.fsync(handle.fileno())
        if production:os.chown(stage/'foreign.txt',runtime_uid,profile.binding.gid,follow_symlinks=False)
        try:publish_artifact(fds[0],fds[2],manifest,authority(rejected))
        except InstallationError as error:unmanifested=error.reason
        else:_fail('COPY_LEDGER_FIXTURE_UNMANIFESTED_ACCEPTED')
        if (rejected/manifest.source_sha).exists():_fail('COPY_LEDGER_FIXTURE_UNMANIFESTED_PUBLISHED')
        tampered=result.path/'package.json'
        with tampered.open('wb') as handle:handle.write(b'x'*len(FILES['package.json']));handle.flush();os.fsync(handle.fileno())
        try:verify_published(result.path,manifest,auth)
        except InstallationError as error:tamper=error.reason
        else:_fail('COPY_LEDGER_FIXTURE_TAMPER_ACCEPTED')
        output={'publication':{'manifest_sha256':result.manifest_sha256,'source_sha':result.source_sha,'scope':result.scope},
            'verification':asdict(verified),'copied_files':before,'collision_files':after,'confined_link':os.readlink(result.path/'node_modules/link'),
            'collision_reason':collision,'collision_unchanged':before==after,'unmanifested_reason':unmanifested,
            'unmanifested_published':False,'tamper_rejected':True,'tamper_reason':tamper,'tampered_package':_bytes(tampered.read_bytes())}
        return _record(inputs,output)
    finally:
        for fd in reversed(fds):os.close(fd)


def _crash(parent_fd,transaction,evidence,before_replace):
    """Only our fixed fork child can be signalled; no PID is accepted as input."""
    release_r,release_w=os.pipe2(os.O_CLOEXEC)
    try:pid=os.fork()
    except BaseException:os.close(release_r);os.close(release_w);raise
    if pid==0:
        try:
            os.close(release_w)
            command=os.read(release_r,1);os.close(release_r)
            if command!=b'g':os._exit(85)
            from . import ledger as module
            ledger=module._open_fixture_ledger(parent_fd,transaction,mode='existing_only')
            if before_replace:
                original=module._write_exclusive
                def boundary(fd,name,raw,uid):
                    if name.startswith('.ledger-'):os.kill(os.getpid(),signal.SIGKILL)
                    return original(fd,name,raw,uid)
                module._write_exclusive=boundary
            ledger.append('START_ATTEMPTED',evidence)
            os.kill(os.getpid(),signal.SIGKILL)
        except BaseException:os._exit(86)
        os._exit(87)
    os.close(release_r)
    handle=None;reaped=False
    try:
        try:handle=os.pidfd_open(pid,0)
        except OSError:_fail('COPY_LEDGER_FIXTURE_PIDFD_UNAVAILABLE')
        if os.write(release_w,b'g')!=1:_fail('COPY_LEDGER_FIXTURE_CHILD_RELEASE_FAILED')
        os.close(release_w);release_w=None
        poll=select.poll();poll.register(handle,select.POLLIN)
        if not poll.poll(10000):
            signal.pidfd_send_signal(handle,signal.SIGKILL)
            if not poll.poll(1000):_fail('COPY_LEDGER_FIXTURE_CHILD_UNSETTLED')
            _fail('COPY_LEDGER_FIXTURE_CHILD_DEADLINE')
        actual,status=os.waitpid(pid,os.WNOHANG)
        if actual!=pid:_fail('COPY_LEDGER_FIXTURE_CHILD_UNSETTLED')
        reaped=True
        if not os.WIFSIGNALED(status) or os.WTERMSIG(status)!=signal.SIGKILL:_fail('COPY_LEDGER_FIXTURE_CHILD_EXIT_INVALID')
        return {'exit_signal':os.WTERMSIG(status),'owned_pidfd_settled':True}
    finally:
        if release_w is not None:os.close(release_w)
        if handle is not None:
            if not reaped:
                try:signal.pidfd_send_signal(handle,signal.SIGKILL)
                except ProcessLookupError:pass
                poll=select.poll();poll.register(handle,select.POLLIN)
                if poll.poll(1000):os.waitpid(pid,os.WNOHANG)
            os.close(handle)
        elif not reaped:
            # No pidfd means the release pipe was never opened. EOF makes the
            # fixed child exit without touching the ledger; reap it boundedly.
            deadline=time.monotonic()+1
            while time.monotonic()<deadline:
                if os.waitpid(pid,os.WNOHANG)[0]==pid:break
                select.select([],[],[],0.01)
            else:_fail('COPY_LEDGER_FIXTURE_CHILD_UNSETTLED')


def _ledger(path,profile):
    path.mkdir(mode=0o700);parent_fd=os.open(path,DIR_FLAGS)
    digest=report_sha256({'profile_sha256':report_sha256(profile),'fixture':'COPY_LEDGER_FIXED_EVIDENCE'})
    evidence={k:digest for k in ('profile_sha256','config_sha256','pointer_sha256','service_identity_sha256','snapshot_sha256','owned_additions_sha256')}
    inputs={'schema':'RBRIDGE_LEDGER_CRASH_FIXTURE_INPUT_V1','profile_sha256':report_sha256(profile),
        'markers':list(MARKERS[:11]),'evidence':evidence,'transactions':list(TRANSACTIONS),
        'crash_points':['BEFORE_START_LEDGER_REPLACEMENT','AFTER_START_LEDGER_FSYNC']}
    output={}
    try:
        for index,name in enumerate(('pre_start','post_start')):
            tx=TRANSACTIONS[index];ledger=_open_fixture_ledger(parent_fd,tx,mode='create_only')
            try:
                for marker in MARKERS[:10]:ledger.append(marker,evidence)
            finally:ledger.close()
            death=_crash(parent_fd,tx,evidence,index==0)
            raw=(path/tx/'ledger.json').read_bytes()
            row={**death,'transaction_id':tx,'ledger_base64':_bytes(raw)['base64'],'ledger_sha256':hashlib.sha256(raw).hexdigest()}
            ledger=_open_fixture_ledger(parent_fd,tx,mode='existing_only')
            try:
                if index==0:
                    try:ledger.read()
                    except LedgerError as error:row['read_reason']=error.reason
                    else:_fail('COPY_LEDGER_FIXTURE_PENDING_ACCEPTED')
                    row['pending']=_bytes((path/tx/'pending.json').read_bytes())
                else:
                    snapshot=ledger.read()
                    observed=ObservedTransactionState(digest,digest,digest,digest,digest,True,True,'PASS',digest)
                    decision=recovery_decision(snapshot,observed)
                    row.update(action=decision.action,may_start_old=decision.may_start_old,reason_codes=list(decision.reason_codes))
            finally:ledger.close()
            output[name]=row
        return _record(inputs,output)
    finally:os.close(parent_fd)


def _produce(parent,profile,runtime_uid,production_copy,guard=lambda:None):
    p=parse_profile(json.loads(encode_report(profile)));fd=_parent(parent)
    try:
        guard();copy=_copy(Path(parent)/'copy',p,runtime_uid,production_copy);guard()
        crash=_ledger(Path(parent)/'ledger',p);guard()
        report={'schema':'RBRIDGE_ISOLATED_COPY_LEDGER_CASES_V1','scope':'ISOLATED_COPY_LEDGER_SOURCE_DATA_ONLY',
            'profile_sha256':report_sha256(p),'uid':os.getuid(),'euid':os.geteuid(),'runtime_uid':runtime_uid,
            'production_copy':production_copy,'production_changed':False,'cases':{'copy':copy,'ledger_crash':crash}}
        compare_copy_ledger_cases(p,report)
        return report
    finally:os.close(fd)


def produce_copy_ledger_cases(parent,profile):
    """Explicit Source fixture authority; never uses production copier authority."""
    return _produce(parent,profile,os.getuid(),False)


def compare_copy_ledger_cases(profile,value):
    """Complete data predicate, separate from protected Root collector origin."""
    if len(encode_report(value))>LIMIT:_fail('COPY_LEDGER_FIXTURE_EVIDENCE_LIMIT')
    fields={'schema','scope','profile_sha256','uid','euid','runtime_uid','production_copy','production_changed','cases'}
    if (type(value) is not dict or set(value)!=fields or value['schema']!='RBRIDGE_ISOLATED_COPY_LEDGER_CASES_V1'
            or value['scope']!='ISOLATED_COPY_LEDGER_SOURCE_DATA_ONLY' or value['profile_sha256']!=report_sha256(profile)
            or any(type(value[k]) is not int or not 0<=value[k]<=4294967294 for k in ('uid','euid','runtime_uid'))
            or value['uid']!=value['euid'] or type(value['production_copy']) is not bool or value['production_changed'] is not False
            or value['production_copy'] and (value['uid']!=0 or value['euid']!=0 or value['runtime_uid']!=1027)
            or not value['production_copy'] and value['runtime_uid']!=value['uid']
            or type(value['cases']) is not dict or set(value['cases'])!={'copy','ledger_crash'}):_fail('COPY_LEDGER_FIXTURE_REPORT_INVALID')
    records={}
    for name,row in value['cases'].items():
        if (type(row) is not dict or set(row)!={'status','input_json','output_json','input_sha256','output_sha256'} or row['status']!='PASS'
                or any(type(row[k]) is not str or hashlib.sha256(row[k].encode()).hexdigest()!=row[h]
                    for k,h in (('input_json','input_sha256'),('output_json','output_sha256')))):_fail('COPY_LEDGER_FIXTURE_RECORD_INVALID')
        a,b=_strict_json(row['input_json']),_strict_json(row['output_json'])
        if encode_report(a).decode()!=row['input_json'] or encode_report(b).decode()!=row['output_json']:_fail('COPY_LEDGER_FIXTURE_RECORD_INVALID')
        records[name]=(a,b)
    a,b=records['copy'];fixed={name:_bytes(raw) for name,raw in sorted(FILES.items())}
    if (type(a) is not dict or set(a)!={'schema','profile_sha256','fixture_kind','files','manifest','runtime_uid','production_copy'}
            or a['schema']!='RBRIDGE_COPY_FIXTURE_INPUT_V1' or a['profile_sha256']!=report_sha256(profile)
            or a['fixture_kind']!='TINY_FIXED_MATERIAL_ONLY' or a['files']!=fixed or a['runtime_uid']!=value['runtime_uid']
            or a['production_copy'] is not value['production_copy']):_fail('COPY_LEDGER_FIXTURE_COPY_INPUT_INVALID')
    try:manifest=ArtifactManifest(**{**a['manifest'],'entries':tuple(ArtifactEntry(**e) for e in a['manifest']['entries'])});validate_manifest(manifest)
    except (TypeError,KeyError,InstallationError):_fail('COPY_LEDGER_FIXTURE_MANIFEST_INVALID')
    if (manifest.kind!='RUNTIME' or manifest.source_sha!=profile.runtime.source_sha or manifest.tree_sha!=profile.runtime.tree_sha
            or manifest.node_sha256!=profile.runtime.node_sha256
            or {e.path for e in manifest.entries if e.kind=='DIRECTORY'}!=DIRECTORIES
            or any(e.mode!=0o644 for e in manifest.entries if e.kind=='FILE')
            or {e.path:e.sha256 for e in manifest.entries if e.kind=='FILE'}!={name:hashlib.sha256(raw).hexdigest() for name,raw in FILES.items()}
            or [(e.path,e.target) for e in manifest.entries if e.kind=='SYMLINK']!=[('node_modules/link',LINK)]):_fail('COPY_LEDGER_FIXTURE_MANIFEST_CHANGED')
    scope='ROOT_DESCRIPTOR_PUBLICATION' if value['production_copy'] else 'FIXTURE_AUTHORITY_ONLY'
    fields={'publication','verification','copied_files','collision_files','confined_link','collision_reason','collision_unchanged',
        'unmanifested_reason','unmanifested_published','tamper_rejected','tamper_reason','tampered_package'}
    if (type(b) is not dict or set(b)!=fields or b['publication']!={'manifest_sha256':manifest.sha256,'source_sha':manifest.source_sha,'scope':scope}
            or b['verification']!={'manifest_sha256':manifest.sha256,'observed_sha256':manifest.sha256,'source_sha':manifest.source_sha,
                'node_sha256':manifest.node_sha256,'status':'PASS','scope':'BYTES_INVENTORY_ONLY'}
            or b['copied_files']!=fixed or b['collision_files']!=fixed or b['confined_link']!=LINK
            or b['collision_reason']!='COPY_DESTINATION_EXISTS' or b['collision_unchanged'] is not True
            or b['unmanifested_reason']!='COPY_UNMANIFESTED_OBJECT' or b['unmanifested_published'] is not False
            or b['tamper_rejected'] is not True or b['tamper_reason']!='COPY_SOURCE_CHANGED'
            or _raw(b['tampered_package'])!=b'x'*len(FILES['package.json'])):_fail('COPY_LEDGER_FIXTURE_COPY_OUTPUT_INVALID')
    a,b=records['ledger_crash'];digest=report_sha256({'profile_sha256':report_sha256(profile),'fixture':'COPY_LEDGER_FIXED_EVIDENCE'})
    evidence={k:digest for k in ('profile_sha256','config_sha256','pointer_sha256','service_identity_sha256','snapshot_sha256','owned_additions_sha256')}
    if a!={'schema':'RBRIDGE_LEDGER_CRASH_FIXTURE_INPUT_V1','profile_sha256':report_sha256(profile),'markers':list(MARKERS[:11]),
            'evidence':evidence,'transactions':list(TRANSACTIONS),'crash_points':['BEFORE_START_LEDGER_REPLACEMENT','AFTER_START_LEDGER_FSYNC']}:
        _fail('COPY_LEDGER_FIXTURE_LEDGER_INPUT_INVALID')
    if type(b) is not dict or set(b)!={'pre_start','post_start'}:_fail('COPY_LEDGER_FIXTURE_LEDGER_OUTPUT_INVALID')
    for index,name in enumerate(('pre_start','post_start')):
        row=b[name];extra={'read_reason','pending'} if index==0 else {'action','may_start_old','reason_codes'}
        if (type(row) is not dict or set(row)!={'exit_signal','owned_pidfd_settled','transaction_id','ledger_base64','ledger_sha256'}|extra
                or type(row['exit_signal']) is not int or row['exit_signal']!=9 or row['owned_pidfd_settled'] is not True
                or row['transaction_id']!=TRANSACTIONS[index]):_fail('COPY_LEDGER_FIXTURE_LEDGER_OUTPUT_INVALID')
        raw=_raw({'base64':row['ledger_base64'],'sha256':row['ledger_sha256']});data=_decode(raw,TRANSACTIONS[index])
        if ([e['marker'] for e in data['entries']]!=list(MARKERS[:10+index]) or any(e['evidence']!=evidence for e in data['entries'])):
            _fail('COPY_LEDGER_FIXTURE_LEDGER_PREIMAGE_CHANGED')
        if index==0:
            if row['read_reason']!='LEDGER_PENDING_OR_UNKNOWN_OBJECT':_fail('COPY_LEDGER_FIXTURE_PENDING_ACCEPTED')
            pending=_raw(row['pending']);entry=_strict_json(pending)
            if encode_report(entry)!=pending or entry.get('marker')!='START_ATTEMPTED' or entry.get('evidence')!=evidence:
                _fail('COPY_LEDGER_FIXTURE_PENDING_CHANGED')
            base={k:v for k,v in data.items() if k!='sha256'};base['entries']=data['entries']+[entry]
            _decode(encode_report({**base,'sha256':report_sha256(base)}),TRANSACTIONS[index])
        elif row['action']!='HOLD_POST_START' or row['may_start_old'] is not False or row['reason_codes']!=['START_ATTEMPTED_PRESERVED']:
            _fail('COPY_LEDGER_FIXTURE_POST_START_RESTORE_ACCEPTED')
    return {'scope':'COPY_LEDGER_DATA_COMPARISON_ONLY','status':'PASS','cases':['copy','ledger_crash'],
        'full_privileged_qualification':'INCOMPLETE','may_execute':False}
