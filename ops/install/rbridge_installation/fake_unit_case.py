"""Fixed isolated unit program and full stop-data comparison, without origin."""
from dataclasses import replace
import hashlib
import re
from pathlib import Path
from .host_backend import normalize_exec_start
from .models import InstallationError,encode_report,report_sha256
from .pause_backup import _observation
from .readonly_helper import _json


class FakeUnitCaseError(InstallationError):pass
def _fail(reason):raise FakeUnitCaseError(reason)

PROPERTIES=('Id','LoadState','ActiveState','SubState','MainPID','ControlGroup','FragmentPath','DropInPaths','ExecStart',
    'User','Group','Restart','KillMode','SendSIGKILL','NoNewPrivileges','ProtectSystem','ProtectHome','ReadWritePaths','InvocationID')


def fake_unit_argv(profile,unit,home,nonce,home_identity):
    if (type(unit) is not str or not re.fullmatch('rbridge-install-fixture-[0-9a-f]{32}\\.service',unit)
            or type(home) is not str or not re.fullmatch(re.escape(profile.binding.home)+r'/\.rbridge-artifact-[0-9a-f]{32}',home)
            or type(nonce) is not str or not re.fullmatch('[0-9a-f]{64}',nonce)
            or type(home_identity) is not dict or set(home_identity)!={'dev','ino'}
            or any(type(v) is not str or not re.fullmatch('[1-9][0-9]{0,19}',v) for v in home_identity.values())):
        _fail('FAKE_UNIT_CASE_INPUT_INVALID')
    root=Path(profile.paths.release_parent)/('toolkit-'+profile.toolkit.source_sha)
    argv=[profile.runtime.node_path,str(root/'dist/server/installation/fakeUnitWorker.js'),'--unit-fixture',unit,home,nonce,
        home_identity['dev'],home_identity['ino']]
    if any(not re.fullmatch('[A-Za-z0-9_./-]+',v) for v in argv):_fail('FAKE_UNIT_CASE_INPUT_INVALID')
    return argv


def render_fake_unit(profile,unit,home,nonce,home_identity):
    argv=fake_unit_argv(profile,unit,home,nonce,home_identity)
    return ('[Unit]\nDescription=RBridge isolated installation stop fixture\n[Service]\nType=exec\n'
        'User='+profile.binding.account+'\nGroup='+profile.binding.account+'\nExecStart='+' '.join(argv)+'\n'
        'Restart=no\nTimeoutStopSec=2s\nRuntimeMaxSec=30s\nKillMode=control-group\nSendSIGKILL=yes\n'
        'WorkingDirectory=/\nUMask=0077\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=read-only\n'
        'ReadWritePaths='+home+'\nPrivateTmp=yes\n'
        'Environment=PATH=/usr/bin:/bin HOME='+profile.binding.home+' USER='+profile.binding.account+
        ' LOGNAME='+profile.binding.account+' LC_ALL=C\n'
        'UnsetEnvironment=GH_TOKEN GITHUB_TOKEN GH_HOST GH_CONFIG_DIR NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME\n')


def parse_unit_show(raw):
    if type(raw) is not str or len(raw.encode())>262144 or not raw.endswith('\n'):_fail('FAKE_UNIT_CASE_SHOW_INVALID')
    rows={}
    for line in raw.splitlines():
        key,sep,value=line.partition('=')
        if not sep or key in rows:_fail('FAKE_UNIT_CASE_SHOW_INVALID')
        rows[key]=value
    if set(rows)!=set(PROPERTIES):_fail('FAKE_UNIT_CASE_SHOW_INVALID')
    return rows


def validate_fake_unit_show(profile,unit,file,home,nonce,home_identity,raw,active):
    rows=parse_unit_show(raw);argv=fake_unit_argv(profile,unit,home,nonce,home_identity)
    stable={'Id':unit,'LoadState':'loaded','FragmentPath':file,'DropInPaths':'','User':profile.binding.account,
        'Group':profile.binding.account,'Restart':'no','KillMode':'control-group','SendSIGKILL':'yes','NoNewPrivileges':'yes',
        'ProtectSystem':'strict','ProtectHome':'read-only','ReadWritePaths':home}
    if (any(rows[k]!=v for k,v in stable.items())
            or normalize_exec_start(rows['ExecStart'])!={'path':profile.runtime.node_path,'argv':' '.join(argv),'ignore_errors':'no'}):
        _fail('FAKE_UNIT_CASE_CONFIGURATION_CHANGED')
    if active:
        if (rows['ActiveState']!='active' or rows['SubState']!='running' or not re.fullmatch('[1-9][0-9]*',rows['MainPID'])
                or not 2<=int(rows['MainPID'])<=2147483647 or rows['ControlGroup']!='/system.slice/'+unit
                or not re.fullmatch('[0-9a-f]{32}',rows['InvocationID'])):_fail('FAKE_UNIT_CASE_ACTIVE_UNQUALIFIED')
    elif rows['ActiveState']!='inactive' or rows['SubState']!='dead' or rows['MainPID']!='0' or rows['ControlGroup'] not in ('','/system.slice/'+unit):
        _fail('FAKE_UNIT_CASE_STOP_UNSETTLED')
    return rows


def capture_fake_unit_case(profile,unit,file,home,nonce,home_identity,unit_text,output):
    input_value={'schema':'RBRIDGE_FAKE_UNIT_STOP_INPUT_V1','profile_sha256':report_sha256(profile),'unit':unit,
        'unit_file':file,'fixture_home':home,'nonce':nonce,'home_identity':home_identity,'unit_text':unit_text}
    case={'schema':'RBRIDGE_FAKE_UNIT_STOP_CASE_V1','scope':'ISOLATED_FAKE_UNIT_STOP_DATA_ONLY','status':'PASS',
        'input_json':encode_report(input_value).decode(),'output_json':encode_report(output).decode()}
    case.update(input_sha256=hashlib.sha256(case['input_json'].encode()).hexdigest(),output_sha256=hashlib.sha256(case['output_json'].encode()).hexdigest())
    compare_fake_unit_case(profile,case)
    return case


def compare_fake_unit_case(profile,case):
    if len(encode_report(case))>profile.budget.carrier_bytes:_fail('FAKE_UNIT_CASE_BYTE_LIMIT')
    if (type(case) is not dict or set(case)!={'schema','scope','status','input_json','output_json','input_sha256','output_sha256'}
            or case['schema']!='RBRIDGE_FAKE_UNIT_STOP_CASE_V1' or case['scope']!='ISOLATED_FAKE_UNIT_STOP_DATA_ONLY'
            or case['status']!='PASS'):_fail('FAKE_UNIT_CASE_INVALID')
    values={}
    for raw,digest in [('input_json','input_sha256'),('output_json','output_sha256')]:
        if type(case[raw]) is not str or hashlib.sha256(case[raw].encode()).hexdigest()!=case[digest]:_fail('FAKE_UNIT_CASE_PREIMAGE_CHANGED')
        values[raw]=_json(case[raw].encode(),profile.budget.carrier_bytes)
        if encode_report(values[raw]).decode()!=case[raw]:_fail('FAKE_UNIT_CASE_NONCANONICAL')
    inputs=values['input_json'];out=values['output_json']
    if (type(inputs) is not dict or set(inputs)!={'schema','profile_sha256','unit','unit_file','fixture_home','nonce','home_identity','unit_text'}
            or inputs['schema']!='RBRIDGE_FAKE_UNIT_STOP_INPUT_V1' or inputs['profile_sha256']!=report_sha256(profile)):
        _fail('FAKE_UNIT_CASE_INPUT_INVALID')
    unit,file,home,nonce=(inputs[k] for k in ('unit','unit_file','fixture_home','nonce'))
    home_identity=inputs['home_identity'];expected_text=render_fake_unit(profile,unit,home,nonce,home_identity)
    expected_file='/root/.rbridge-fake-unit-'+unit.removeprefix('rbridge-install-fixture-').removesuffix('.service')+'/'+unit
    if file!=expected_file or inputs['unit_text']!=expected_text:_fail('FAKE_UNIT_CASE_UNIT_BYTES_CHANGED')
    fields={'active_show','stopped_show','active_cgroup_pids','stopped_cgroup_pids','ready_json','ready_uid','ready_mode','ready_nlink',
        'stopped_json','stopped_uid','stopped_mode','stopped_nlink','worker_facts','pidfd_settled','stop_exit_code','production_before','production_after'}
    if (type(out) is not dict or set(out)!=fields or out['pidfd_settled'] is not True
            or type(out['stop_exit_code']) is not int or out['stop_exit_code']!=0
            or type(out['stopped_show']) is not list or len(out['stopped_show'])!=2 or out['stopped_cgroup_pids']!=[[],[]]):
        _fail('FAKE_UNIT_CASE_STOP_UNSETTLED')
    active=validate_fake_unit_show(profile,unit,file,home,nonce,home_identity,out['active_show'],True);pid=int(active['MainPID'])
    if out['active_cgroup_pids']!=[pid] or type(out['active_cgroup_pids'][0]) is not int:_fail('FAKE_UNIT_CASE_CGROUP_UNCLASSIFIED')
    fake_profile=replace(profile,service=replace(profile.service,unit=unit,identity_sha256=report_sha256(inputs)))
    for raw in out['stopped_show']:
        stopped=validate_fake_unit_show(profile,unit,file,home,nonce,home_identity,raw,False)
        _observation({'scope':'FIXTURE_AUTHORITY_ONLY','service_identity_sha256':fake_profile.service.identity_sha256,
            'active_state':stopped['ActiveState'],'main_pid':int(stopped['MainPID']),'cgroup_pids':[],
            'unclassified_same_uid':[],'alternate_writers':[],'supervisors':[],'admissions_closed':stopped['SubState']=='dead'},fake_profile)
    if (any(type(out[k]) is not int for k in ('ready_uid','ready_mode','ready_nlink'))
            or out['ready_uid']!=profile.binding.uid or out['ready_mode']!=0o600 or out['ready_nlink']!=1
            or type(out['ready_json']) is not str):_fail('FAKE_UNIT_CASE_READY_INVALID')
    ready=_json(out['ready_json'].encode(),4096)
    expected_ready={'schema':'RBRIDGE_FAKE_UNIT_READY_V1','pid':pid,'uid':profile.binding.uid,'euid':profile.binding.uid,
        'gid':profile.binding.gid,'unit':unit,'nonce':nonce}
    if encode_report(ready)!=encode_report(expected_ready) or out['ready_json']!=encode_report(ready).decode()+'\n':_fail('FAKE_UNIT_CASE_READY_INVALID')
    if (any(type(out[k]) is not int for k in ('stopped_uid','stopped_mode','stopped_nlink'))
            or out['stopped_uid']!=profile.binding.uid or out['stopped_mode']!=0o600 or out['stopped_nlink']!=1
            or type(out['stopped_json']) is not str):_fail('FAKE_UNIT_CASE_STOP_RECEIPT_INVALID')
    receipt=_json(out['stopped_json'].encode(),4096)
    expected_receipt={**expected_ready,'schema':'RBRIDGE_FAKE_UNIT_STOPPED_V1','signal':'SIGTERM'}
    if (type(receipt) is not dict or set(receipt)!=set(expected_receipt)|{'elapsed_ms'}
            or any(receipt[k]!=v for k,v in expected_receipt.items())
            or type(receipt['elapsed_ms']) is not int or not 0<=receipt['elapsed_ms']<25000
            or out['stopped_json']!=encode_report(receipt).decode()+'\n'):_fail('FAKE_UNIT_CASE_STOP_RECEIPT_INVALID')
    facts=out['worker_facts'];argv=fake_unit_argv(profile,unit,home,nonce,home_identity)
    if (type(facts) is not dict or set(facts)!={'Uid','Gid','Groups','PPid','identity','cgroup_sha256'}
            or any(type(facts[k]) is not list or any(type(v) is not int for v in facts[k]) for k in ('Uid','Gid','Groups','PPid'))
            or facts['Uid']!=[profile.binding.uid]*4 or facts['Gid']!=[profile.binding.gid]*4 or facts['PPid']!=[1]
            or sorted(set(facts['Groups'])-{profile.binding.gid})!=list(profile.binding.supplementary_gids) or 0 in facts['Groups']
            or facts['cgroup_sha256']!=hashlib.sha256(('0::/system.slice/'+unit+'\n').encode()).hexdigest()):
        _fail('FAKE_UNIT_CASE_WORKER_UNQUALIFIED')
    identity=facts['identity']
    if (type(identity) is not dict or set(identity)!={'pid','exe','cmdlineSha256','startTimeTicks'}
            or type(identity['pid']) is not int or identity['pid']!=pid or identity['exe']!=profile.runtime.node_path
            or identity['cmdlineSha256']!=hashlib.sha256(('\0'.join(argv)+'\0').encode()).hexdigest()
            or type(identity['startTimeTicks']) is not str or not re.fullmatch('[1-9][0-9]{0,31}',identity['startTimeTicks'])):
        _fail('FAKE_UNIT_CASE_WORKER_UNQUALIFIED')
    before=out['production_before'];after=out['production_after']
    if (type(before) is not dict or set(before)!={'service','current_release','pointer_identity_sha256'}
            or encode_report(before)!=encode_report(after) or before['current_release']!=str(Path(profile.paths.release_parent)/profile.runtime.old_sha)
            or type(before['pointer_identity_sha256']) is not str or not re.fullmatch('[0-9a-f]{64}',before['pointer_identity_sha256'])):
        _fail('FAKE_UNIT_CASE_PRODUCTION_CHANGED')
    service=before['service']
    if (type(service) is not dict or set(service)!={'scope','identity_sha256','config_sha256','invocation_sha256'}
            or service['scope']!='QUALIFIED_HOST_PAUSE' or service['identity_sha256']!=profile.service.identity_sha256
            or any(type(service[k]) is not str or not re.fullmatch('[0-9a-f]{64}',service[k]) for k in ('config_sha256','invocation_sha256'))):
        _fail('FAKE_UNIT_CASE_PRODUCTION_CHANGED')
    return {'status':'PASS','scope':'ISOLATED_FAKE_UNIT_STOP_DATA_ONLY','case':'fake_unit_stop',
        'physical_origin':'UNQUALIFIED','full_privileged_qualification':'INCOMPLETE','may_execute':False}
