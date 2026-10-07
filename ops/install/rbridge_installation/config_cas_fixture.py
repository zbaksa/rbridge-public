"""Fixed actual filesystem CAS exercises against an explicit fake service.

Original, owned-overlay and ledger bytes stay Source data. This module neither
invokes systemd nor registers privileged origin, workflow adoption or a bundle.
"""
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import shlex
from .artifact import inventory_artifact
from .configuration import install_configuration,switch_pointer,restore_owned_pre_start,OwnedChanges,normalize_owned_rows
from .copy_ledger_fixture import FILES,_parent,_bytes,_raw,_record
from .host_backend import PROPERTIES
from .ledger import _open_fixture_ledger,_decode,_strict_json,ObservedTransactionState,MARKERS
from .models import InstallationError,encode_report,report_sha256,record
from .pause_backup import maintain_pause,capture_snapshot
from .profile import parse_profile
from .protected_copy import DIR_FLAGS,PublishedArtifact


class ConfigCasFixtureError(InstallationError):pass
def _fail(reason):raise ConfigCasFixtureError(reason)
CASES=('success','occupied','drift','post_start')
LIMIT=4194304
HARDENING={'ProtectSystem':'strict','ProtectHome':'read-only','NoNewPrivileges':'yes'}


def _originals(profile):
    return {'env/first':('RBRIDGE_RELEASE_SHA='+profile.runtime.old_sha+'\nFIXTURE_TAG=FIRST\n').encode(),
        'env/second':b'FIXTURE_TAG=SECOND\n','unit':b'[Service]\nEnvironment=FIXTURE_BASE=1\n',
        'dropins/50-cpu.conf':b'[Service]\nCPUQuota=15%\n'}


def _create(path,raw,mode):
    with path.open('xb') as handle:handle.write(raw);handle.flush();os.fsync(handle.fileno())
    path.chmod(mode)


def _preimages(root,profile):return {name:_bytes((root/name).read_bytes()) for name in sorted(_originals(profile))}


class _FakeService:
    scope='FIXTURE_AUTHORITY_ONLY'
    def __init__(self,profile,rows):
        self.profile=profile;self.rows=rows;self.stop_calls=0;self.reloads=0;self.old_start_called=False
    def _show(self,unit):
        if unit!=self.profile.service.unit:_fail('CONFIG_CAS_FIXTURE_UNIT_CHANGED')
        return dict(self.rows)
    def capture_service(self,profile):
        normalize_owned_rows(self,self.rows)
        return {'scope':self.scope,'identity_sha256':profile.service.identity_sha256,
            'config_sha256':profile.service.identity_sha256,'invocation_sha256':'c'*64}
    def stop_unit(self,unit):
        if unit!=self.profile.service.unit:_fail('CONFIG_CAS_FIXTURE_UNIT_CHANGED')
        self.stop_calls+=1
    def observe_pause(self,profile):
        self.capture_service(profile)
        return {'scope':self.scope,'service_identity_sha256':profile.service.identity_sha256,'active_state':'inactive',
            'main_pid':0,'cgroup_pids':[],'unclassified_same_uid':[],'alternate_writers':[],'supervisors':[],'admissions_closed':True}
    def reload_configuration(self):
        self.reloads+=1;session=self.owned_configuration
        if session.loading and not session.restoring:self.rows=dict(session.after)
        else:self.rows=dict(session.before)


def _setup(root,outer,runtime_uid,runtime_gid):
    root.mkdir(mode=0o700)
    for name in ('env','dropins','state','ledger','releases'):(root/name).mkdir(mode=0o700)
    for name,raw in _originals(outer).items():_create(root/name,raw,0o600 if name.startswith('env/') else 0o644)
    env=tuple(record('PathDigest',{'path':str(root/name),'sha256':hashlib.sha256(raw).hexdigest()})
        for name,raw in _originals(outer).items() if name.startswith('env/'))
    files={'fragment':{'path':str(root/'unit'),'sha256':hashlib.sha256(_originals(outer)['unit']).hexdigest()},
        'dropins':[{'path':str(root/'dropins/50-cpu.conf'),'sha256':hashlib.sha256(_originals(outer)['dropins/50-cpu.conf']).hexdigest()}]}
    if runtime_uid!=os.getuid() or runtime_gid!=os.getgid():os.chown(root/'state',runtime_uid,runtime_gid,follow_symlinks=False)
    inner=replace(outer,binding=replace(outer.binding,uid=runtime_uid,gid=runtime_gid),
        paths=replace(outer.paths,binding_env=str(root/'env/binding'),binding_dropin=str(root/'dropins/60-p2a-binding.conf'),
            current_link=str(root/'current'),release_parent=str(root/'releases'),state_root=str(root/'state'),lock_path=str(root/'maintenance.lock')),
        service=replace(outer.service,environment_files=env,dropins_sha256=report_sha256(files)))
    rows={k:'' for k in PROPERTIES}
    rows.update({'FragmentPath':str(root/'unit'),'DropInPaths':str(root/'dropins/50-cpu.conf'),
        'EnvironmentFiles':' '.join(e.path+' (ignore_errors=no)' for e in env),'CPUQuotaPerSecUSec':'150ms',
        'User':outer.binding.account,'Group':outer.binding.account,
        'ExecStart':'{ path='+outer.runtime.node_path+' ; argv[]='+outer.runtime.node_path+' /srv/fixture/current/main.js ; ignore_errors=no ; start_time=[n/a] ; }',
        **HARDENING,'ReadWritePaths':str(root/'state'),'ActiveState':'inactive','SubState':'dead','MainPID':'0'})
    old=root/'releases'/outer.runtime.old_sha;old.mkdir(mode=0o755);old.chmod(0o755);(root/'current').symlink_to(old)
    return inner,_FakeService(inner,rows)


def _artifact(root,profile,host):
    target=root/'releases'/profile.runtime.source_sha;target.mkdir(mode=0o755);target.chmod(0o755)
    for name,raw in FILES.items():
        p=target/name;p.parent.mkdir(mode=0o755,parents=True,exist_ok=True);_create(p,raw,0o644)
    for directory,_,_ in os.walk(target):Path(directory).chmod(0o755)
    host.runtime_manifest=inventory_artifact(target,'RUNTIME',profile)
    return PublishedArtifact(target,host.runtime_manifest.sha256,profile.runtime.source_sha,'FIXTURE_AUTHORITY_ONLY')


def _observed(changes,lease,snapshot):
    return ObservedTransactionState(changes.pointer.after_sha256 if changes.pointer else changes.config.before_pointer_sha256,
        changes.config.after_sha256,lease.profile.service.identity_sha256,capture_snapshot(lease).tree_sha256,
        changes.config.owned_additions_sha256,True,True,'PASS',snapshot.tree_sha256)


def _case(root,outer,name,index,runtime_uid,runtime_gid):
    p,host=_setup(root,outer,runtime_uid,runtime_gid);before=_preimages(root,p);tx=str(index+1)*32
    fd=os.open(root/'ledger',DIR_FLAGS);ledger=None;lease=None
    inputs={'schema':'RBRIDGE_CONFIG_CAS_FIXTURE_INPUT_V1','profile_sha256':report_sha256(outer),'case':name,
        'fixture_path':str(root),'runtime_uid':runtime_uid,'runtime_gid':runtime_gid,'originals':before}
    output={'before_originals':before,'installed_env':None,'installed_dropin':None,'installed_modes':{},
        'environment_order':['env/first','env/second'],'cpu_quota':'150ms','hardening':dict(HARDENING),
        'restore_status':'NOT_ATTEMPTED','may_start_old':False,'refusal_reason':None}
    try:
        ledger=_open_fixture_ledger(fd,tx,mode='create_only');ledger.append('QUALIFIED',{});ledger.append('STAGED',{})
        lease=maintain_pause(p,host,ledger);snapshot=capture_snapshot(lease)
        ledger.append('BACKUP_COMPLETE',{});ledger.append('GATES_PASS',{'snapshot_sha256':snapshot.tree_sha256})
        if name=='occupied':_create(Path(p.paths.binding_env),b'pre-existing fixed binding\n',0o600)
        try:config=install_configuration(p,lease,ledger,host)
        except InstallationError as error:
            if name!='occupied':raise
            output['refusal_reason']=error.reason
        else:
            if name=='occupied':_fail('CONFIG_CAS_FIXTURE_OCCUPIED_OVERWRITTEN')
            output.update(installed_env=_bytes(Path(p.paths.binding_env).read_bytes()),
                installed_dropin=_bytes(Path(p.paths.binding_dropin).read_bytes()),
                installed_modes={'binding':Path(p.paths.binding_env).stat().st_mode&0o7777,'dropin':Path(p.paths.binding_dropin).stat().st_mode&0o7777},
                environment_order=[str(Path(v).relative_to(root)) for v in shlex.split(host.rows['EnvironmentFiles']) if v!='(ignore_errors=no)'],
                cpu_quota=host.rows['CPUQuotaPerSecUSec'],hardening={k:host.rows[k] for k in HARDENING})
            changes=OwnedChanges(config)
            if name=='post_start':
                pointer=switch_pointer(p,_artifact(root,p,host),lease,ledger);changes=OwnedChanges(config,pointer)
                ledger.append('START_ATTEMPTED',{})
            observed=_observed(changes,lease,snapshot)
            if name=='drift':
                with (root/'env/second').open('ab') as handle:handle.write(b'CONCURRENT_EDIT=preserve\n');handle.flush();os.fsync(handle.fileno())
            try:restored=restore_owned_pre_start(changes,observed,lease,ledger)
            except InstallationError as error:
                if name=='success':raise
                output.update(refusal_reason=error.reason,restore_status='REFUSED')
            else:
                if name!='success':_fail('CONFIG_CAS_FIXTURE_UNSAFE_RESTORE_ACCEPTED')
                output.update(restore_status=restored.status,may_start_old=restored.may_start_old)
        output.update(after_originals=_preimages(root,p),old_start_called=host.old_start_called,fake_stop_calls=host.stop_calls,
            fake_reload_calls=host.reloads,binding_remains=Path(p.paths.binding_env).exists(),dropin_remains=Path(p.paths.binding_dropin).exists(),
            retained_binding=_bytes(Path(p.paths.binding_env).read_bytes()) if Path(p.paths.binding_env).exists() else None,
            pointer_target=Path(os.readlink(root/'current')).name,last_marker=ledger.read().entries[-1].marker,
            transaction_id=tx,ledger=_bytes((root/'ledger'/tx/'ledger.json').read_bytes()))
        return _record(inputs,output)
    finally:
        config=getattr(host,'owned_configuration',None)
        if config is not None:config.close()
        pointer=getattr(host,'owned_pointer',None)
        if pointer is not None:pointer.guard.close()
        if lease is not None:lease.close()
        pending=getattr(host,'pending_pause',None)
        if pending is not None:pending.close()
        if ledger is not None:ledger.close()
        os.close(fd)


def _produce(parent,profile,runtime_uid,runtime_gid,guard=lambda:None):
    p=parse_profile(json.loads(encode_report(profile)));fd=_parent(parent)
    try:
        cases={}
        for i,name in enumerate(CASES):
            guard();cases[name]=_case(Path(parent)/name,p,name,i,runtime_uid,runtime_gid);guard()
        result={'schema':'RBRIDGE_ISOLATED_CONFIG_CAS_CASES_V1','scope':'ISOLATED_CONFIG_CAS_SOURCE_DATA_ONLY',
            'profile_sha256':report_sha256(p),'uid':os.getuid(),'euid':os.geteuid(),'gid':os.getgid(),
            'runtime_uid':runtime_uid,'runtime_gid':runtime_gid,
            'service_backend':'FIXED_FAKE_SERVICE_ONLY','production_changed':False,'cases':cases}
        compare_config_cas_cases(p,result);return result
    finally:os.close(fd)


def produce_config_cas_cases(parent,profile):
    """Explicit Source ownership; Root/runtime identity belongs to the collector."""
    return _produce(parent,profile,os.getuid(),os.getgid())


def compare_config_cas_cases(profile,value):
    """Compare complete fixed preimages; never a privileged-origin issuer."""
    if len(encode_report(value))>LIMIT:_fail('CONFIG_CAS_FIXTURE_EVIDENCE_LIMIT')
    fields={'schema','scope','profile_sha256','uid','euid','gid','runtime_uid','runtime_gid','service_backend','production_changed','cases'}
    if (type(value) is not dict or set(value)!=fields or value['schema']!='RBRIDGE_ISOLATED_CONFIG_CAS_CASES_V1'
            or value['scope']!='ISOLATED_CONFIG_CAS_SOURCE_DATA_ONLY' or value['profile_sha256']!=report_sha256(profile)
            or any(type(value[k]) is not int or not 0<=value[k]<=4294967294 for k in ('uid','euid','gid','runtime_uid','runtime_gid')) or value['uid']!=value['euid']
            or value['service_backend']!='FIXED_FAKE_SERVICE_ONLY' or value['production_changed'] is not False
            or type(value['cases']) is not dict or set(value['cases'])!=set(CASES)):_fail('CONFIG_CAS_FIXTURE_REPORT_INVALID')
    originals={k:_bytes(v) for k,v in sorted(_originals(profile).items())};parent=None
    for index,name in enumerate(CASES):
        row=value['cases'][name]
        if (type(row) is not dict or set(row)!={'status','input_json','output_json','input_sha256','output_sha256'} or row['status']!='PASS'
                or any(type(row[k]) is not str or hashlib.sha256(row[k].encode()).hexdigest()!=row[h]
                    for k,h in (('input_json','input_sha256'),('output_json','output_sha256')))):_fail('CONFIG_CAS_FIXTURE_RECORD_INVALID')
        a,b=_strict_json(row['input_json']),_strict_json(row['output_json'])
        if encode_report(a).decode()!=row['input_json'] or encode_report(b).decode()!=row['output_json']:_fail('CONFIG_CAS_FIXTURE_RECORD_INVALID')
        if (type(a) is not dict or set(a)!={'schema','profile_sha256','case','fixture_path','runtime_uid','runtime_gid','originals'}
                or a['schema']!='RBRIDGE_CONFIG_CAS_FIXTURE_INPUT_V1' or a['profile_sha256']!=report_sha256(profile) or a['case']!=name
                or type(a['runtime_uid']) is not int or type(a['runtime_gid']) is not int
                or a['runtime_uid']!=value['runtime_uid'] or a['runtime_gid']!=value['runtime_gid'] or a['originals']!=originals
                or type(a['fixture_path']) is not str or not Path(a['fixture_path']).is_absolute() or Path(a['fixture_path']).name!=name):
            _fail('CONFIG_CAS_FIXTURE_INPUT_INVALID')
        root=Path(a['fixture_path'])
        if parent is None:parent=root.parent
        if root.parent!=parent:_fail('CONFIG_CAS_FIXTURE_ROOT_CHANGED')
        fields={'before_originals','after_originals','installed_env','installed_dropin','installed_modes','environment_order','cpu_quota','hardening',
            'restore_status','may_start_old','refusal_reason','old_start_called','fake_stop_calls','fake_reload_calls','binding_remains','dropin_remains',
            'retained_binding','pointer_target','last_marker','transaction_id','ledger'}
        if (type(b) is not dict or set(b)!=fields or b['before_originals']!=originals or b['cpu_quota']!='150ms' or b['hardening']!=HARDENING
                or b['old_start_called'] is not False or type(b['fake_stop_calls']) is not int or b['fake_stop_calls']!=1):
            _fail('CONFIG_CAS_FIXTURE_OUTPUT_INVALID')
        after=dict(originals)
        if name=='drift':after['env/second']=_bytes(_originals(profile)['env/second']+b'CONCURRENT_EDIT=preserve\n')
        if b['after_originals']!=after:_fail('CONFIG_CAS_FIXTURE_ORIGINAL_BYTES_CHANGED')
        env=('RBRIDGE_MCP_PRINCIPAL_ID='+profile.binding.principal_id+'\nRBRIDGE_INSTANCE_ID='+profile.binding.target_instance_id+
            '\nRBRIDGE_RELEASE_SHA='+profile.runtime.source_sha+'\nCOCWIN_REMOTE_BRIDGE_RELEASE_SHA='+profile.runtime.source_sha+'\n').encode()
        dropin=('[Service]\nEnvironmentFile='+str(root/'env/binding')+'\n').encode()
        occupied=name=='occupied';success=name=='success'
        if (b['installed_env']!=(None if occupied else _bytes(env)) or b['installed_dropin']!=(None if occupied else _bytes(dropin))
                or b['installed_modes']!=({} if occupied else {'binding':0o600,'dropin':0o644})
                or b['environment_order']!=['env/first','env/second']+([] if occupied else ['env/binding'])
                or b['restore_status']!=('PASS' if success else 'NOT_ATTEMPTED' if occupied else 'REFUSED') or b['may_start_old'] is not success
                or b['refusal_reason']!={'success':None,'occupied':'CONFIG_UNOWNED_PATH_EXISTS','drift':'CONFIG_FILE_CHANGED',
                    'post_start':'CONFIG_RESTORE_START_ATTEMPTED'}[name]
                or b['binding_remains'] is not (not success) or b['dropin_remains'] is not (name in ('drift','post_start'))
                or b['retained_binding']!=(None if success else _bytes(b'pre-existing fixed binding\n' if occupied else env))
                or b['pointer_target']!=(profile.runtime.source_sha if name=='post_start' else profile.runtime.old_sha)
                or type(b['fake_reload_calls']) is not int or b['fake_reload_calls']!=(2 if success else 0 if occupied else 1)):
            _fail('CONFIG_CAS_FIXTURE_CAS_VERDICT_CHANGED')
        tx=str(index+1)*32;data=_decode(_raw(b['ledger']),tx)
        markers=list(MARKERS[:6 if occupied else 11 if name=='post_start' else 8])+(['ROLLED_BACK'] if success else [])
        if (b['transaction_id']!=tx or b['last_marker']!=markers[-1] or [e['marker'] for e in data['entries']]!=markers):
            _fail('CONFIG_CAS_FIXTURE_LEDGER_CHANGED')
    return {'scope':'CONFIG_CAS_DATA_COMPARISON_ONLY','status':'PASS','may_execute':False,'physical_root_origin':'UNKNOWN',
        'actual_systemd_actions':'NOT_PERFORMED','full_privileged_qualification':'INCOMPLETE'}
