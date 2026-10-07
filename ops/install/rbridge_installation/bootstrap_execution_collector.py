"""Actual protected copied-entry probe; never an installer or service permit.

The pure predicate compares complete retained preimages. Root origin additionally
requires the same authenticated byte-observation object, immutable material,
actual owned Python process and a private live registration. No serialized PASS,
fixture namespace or equal-byte token can grant that origin.
"""
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import weakref
from .artifact_collector import _closure
from .bootstrap_collector import decode_bootstrap_body,verify_root_bootstrap_observation
from .bootstrap_fixture import _pins
from .bootstrap_fixture_collector import _module
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .host_backend import validate_kernel_namespace_evidence
from .models import InstallationError,encode_report,report_sha256
from .owned_process import run_owned_process,validate_owned_session,assert_owned_helpers_settled
from .profile import parse_profile,assert_reader_profile_extension
from .python_closure import validate_python_closure
from .readonly_helper import _json,parse_helper_ready


class BootstrapExecutionCollectorError(InstallationError):pass
def _fail(reason):raise BootstrapExecutionCollectorError(reason)


@dataclass(frozen=True,eq=False)
class _RootBootstrapExecutionObservation:
    profile_sha256:str
    bootstrap_sha256:str
    evidence_json:str
    fixture_path:str


@dataclass(frozen=True)
class _PythonPin:
    path:str
    sha256:str


_observations=weakref.WeakKeyDictionary()


def _fields(value,keys):
    if type(value) is not dict or set(value)!=set(keys):_fail('BOOTSTRAP_EXECUTION_DATA_INCOMPLETE')
    return value


def _bytes(value,limit):
    if type(value) is not str or len(value)>((limit+2)//3)*4:_fail('BOOTSTRAP_EXECUTION_PREIMAGE_INVALID')
    try:raw=base64.b64decode(value,validate=True)
    except (ValueError,TypeError):_fail('BOOTSTRAP_EXECUTION_PREIMAGE_INVALID')
    if len(raw)>limit or base64.b64encode(raw).decode()!=value:_fail('BOOTSTRAP_EXECUTION_PREIMAGE_INVALID')
    return raw


def _closure_data(p,report,path,identity,request):
    closure=_fields(report['import_closure'],('schema','status','scope','execution_qualified','manifest_sha256','files',
        'profile_sha256','imports','mapped_files','service_action_authorized','copied_bootstrap'))
    entries=validate_python_closure(report['python_manifest'],request['python_closure_sha256'])
    files={path for path,row in entries.items() if row['kind']=='FILE'};manifest=report['python_manifest']
    if (manifest['python_version']!=p.toolkit.python_version or manifest['interpreter_path']!=p.toolkit.python_path
            or manifest['interpreter_sha256']!=p.toolkit.python_sha256
            or closure['schema']!='RBRIDGE_PYTHON_CLOSURE_BYTES_V1' or closure['status']!='PASS'
            or closure['scope']!='RUNNING_ROOT_INTERPRETER_OBSERVATION_ONLY' or closure['execution_qualified'] is not False
            or closure['service_action_authorized'] is not False or type(closure['files']) is not int or closure['files']!=len(files)
            or closure['manifest_sha256']!=request['python_closure_sha256'] or closure['profile_sha256']!=report_sha256(p)
            or closure['copied_bootstrap']!={'path':path,'payload_sha256':report['payload_sha256'],
                'payload_bytes':report['payload_bytes'],'identity':identity}):_fail('BOOTSTRAP_EXECUTION_CLOSURE_CHANGED')
    imports=closure['imports'];mapped=closure['mapped_files'];root=p.paths.release_parent+'/toolkit-'+p.toolkit.source_sha
    if (type(imports) is not list or not 1<=len(imports)<=100000 or type(mapped) is not list or len(mapped)>100000
            or any(type(v) is not str or v not in files for v in mapped) or mapped!=sorted(set(mapped))):
        _fail('BOOTSTRAP_EXECUTION_IMPORT_CHANGED')
    names=[];main=False
    for row in imports:
        _fields(row,('module','path'));name=row['module'];file=row['path']
        if type(name) is not str or not re.fullmatch('[A-Za-z_][A-Za-z0-9_.]*',name) or type(file) is not str:
            _fail('BOOTSTRAP_EXECUTION_IMPORT_CHANGED')
        if name=='__main__':
            if file!=path:_fail('BOOTSTRAP_EXECUTION_IMPORT_CHANGED')
            main=True
        elif (file not in files and file not in (root+'/ops/install/rbridge_install.py',root+'/ops/install/rbridge_bootstrap.py')
                and not re.fullmatch(re.escape(root)+r'/ops/install/rbridge_installation/[a-z_][a-z0-9_]*\.py',file)):
            _fail('BOOTSTRAP_EXECUTION_IMPORT_CHANGED')
        names.append(name)
    if not main or names!=sorted(set(names)):_fail('BOOTSTRAP_EXECUTION_IMPORT_CHANGED')


def compare_bootstrap_execution(profile,module,evidence,qualification_request):
    """Full data comparison cannot register Root origin, execution or a bundle."""
    p=parse_profile(json.loads(encode_report(profile)));limit=p.budget.carrier_bytes
    if len(encode_report(evidence))>limit:_fail('BOOTSTRAP_EXECUTION_BYTE_LIMIT')
    _fields(evidence,('schema','scope','profile_sha256','manifest','capture','publication','nonce',
        'input_base64','output_base64','stderr_base64','session'))
    if (evidence['schema']!='RBRIDGE_BOOTSTRAP_EXECUTION_CAPTURE_V1' or evidence['scope']!='COPIED_BOOTSTRAP_EXECUTION_DATA_ONLY'
            or evidence['profile_sha256']!=report_sha256(p) or type(qualification_request) is not dict
            or evidence['manifest'].get('python_closure_sha256')!=qualification_request.get('python_closure_sha256')):
        _fail('BOOTSTRAP_EXECUTION_PINS_CHANGED')
    capture=evidence['capture'];manifest=evidence['manifest'];publication=evidence['publication']
    payload=decode_bootstrap_body(capture['body'],manifest)
    binding={'repository':p.binding.repository,'author':p.binding.author,'issue_number':capture['issue_number']}
    _pins(p,manifest,binding);proof=module.verify_bootstrap_artifact(payload,manifest,capture,binding)
    _fields(publication,(*proof.keys(),'path','identity'))
    if (publication['scope']!='ROOT_PROTECTED_BYTES_ONLY' or publication['may_execute'] is not False
            or any(publication[k]!=v for k,v in proof.items() if k!='scope')
            or type(publication['path']) is not str
            or not re.fullmatch(r'/root/\.rbridge-bootstrap-fixture-[0-9a-f]{32}/bootstrap-'+manifest['payload_sha256']+r'/payload\.py',publication['path'])):
        _fail('BOOTSTRAP_EXECUTION_PUBLICATION_CHANGED')
    identity=publication['identity'];path=publication['path']
    if (type(identity) is not list or len(identity)!=9
            or any(type(v) is not str or not re.fullmatch('0|[1-9][0-9]{0,31}',v) for v in identity)
            or int(identity[0])<1 or int(identity[1])<1 or int(identity[2])!=stat.S_IFREG|0o400
            or identity[3]!='0' or identity[5]!='1' or int(identity[6])!=len(payload)):
        _fail('BOOTSTRAP_EXECUTION_PUBLICATION_CHANGED')
    raw_input=_bytes(evidence['input_base64'],limit);raw_output=_bytes(evidence['output_base64'],limit)
    stderr=_bytes(evidence['stderr_base64'],4096)
    if raw_input!=encode_report({'profile':p,'qualification':qualification_request}):_fail('BOOTSTRAP_EXECUTION_INPUT_CHANGED')
    report=_json(raw_output,limit)
    if encode_report(report)+b'\n'!=raw_output:_fail('BOOTSTRAP_EXECUTION_OUTPUT_CHANGED')
    _fields(report,('schema','status','scope','operation','profile_sha256','toolkit_manifest_sha256','python_closure_sha256',
        'payload_sha256','payload_bytes','payload_path','payload_identity','kernel_namespace','import_closure','python_manifest',
        'may_execute','service_action_authorized'))
    if (report['schema']!='RBRIDGE_BOOTSTRAP_EXECUTION_REPORT_V1' or report['status']!='PASS'
            or report['scope']!='ROOT_INTERPRETER_READONLY_PROBE' or report['operation']!='QUALIFICATION_FIXTURE_ONLY'
            or report['profile_sha256']!=report_sha256(p) or report['toolkit_manifest_sha256']!=p.toolkit.manifest_sha256
            or report['python_closure_sha256']!=qualification_request['python_closure_sha256']
            or report['payload_sha256']!=manifest['payload_sha256'] or type(report['payload_bytes']) is not int
            or report['payload_bytes']!=len(payload) or report['payload_path']!=path or report['payload_identity']!=identity
            or report['may_execute'] is not False or report['service_action_authorized'] is not False):
        _fail('BOOTSTRAP_EXECUTION_OUTPUT_CHANGED')
    validate_kernel_namespace_evidence(report['kernel_namespace']);module._validate_fixture_namespace(report['kernel_namespace'])
    _closure_data(p,report,path,identity,qualification_request)
    session=_fields(evidence['session'],('schema','scope','status','pid','start_ticks','argv','executable_sha256',
        'input_sha256','output_sha256','processes','live_helpers','exit_code'))
    argv=[p.toolkit.python_path,'-I','-S','-B',path,'--qualification-fixture'];pid=parse_helper_ready(stderr,evidence['nonce'])
    if (session['schema']!='RBRIDGE_OWNED_HELPER_SESSION_V1' or session['scope']!='ROOT_FIXED_PROCESS_OBSERVATION'
            or session['status']!='PASS' or type(session['exit_code']) is not int or session['exit_code']!=0
            or type(session['pid']) is not int or session['pid']!=pid or report['kernel_namespace']['pid']!=pid
            or session['argv']!=argv or session['executable_sha256']!=p.toolkit.python_sha256 or session['live_helpers']!=[]
            or session['input_sha256']!=hashlib.sha256(raw_input).hexdigest()
            or session['output_sha256']!=hashlib.sha256(raw_output).hexdigest()
            or type(session['processes']) is not list or len(session['processes'])!=1):_fail('BOOTSTRAP_EXECUTION_SESSION_CHANGED')
    parent=session['processes'][0];validate_owned_session(parent,session['processes'],())
    if (parent['pid']!=pid or parent['session']!=pid or parent['start_ticks']!=session['start_ticks']
            or parent['uid']!=[0]*4 or parent['exe']!=p.toolkit.python_path or parent['argv']!=argv):
        _fail('BOOTSTRAP_EXECUTION_SESSION_CHANGED')
    return {'schema':'RBRIDGE_BOOTSTRAP_EXECUTION_COMPARISON_V1','scope':'COPIED_BOOTSTRAP_EXECUTION_DATA_ONLY',
        'status':'PASS','evidence':evidence,'report':report,'physical_origin':'UNQUALIFIED',
        'may_execute':False,'service_action_authorized':False}


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/bootstrap_execution_collector.py'):
        _fail('BOOTSTRAP_EXECUTION_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _materials(p,root,runtime_manifest,toolkit_manifest,request):
    _closure(p,root,runtime_manifest,toolkit_manifest,request)
    needed={'ops/install/rbridge_bootstrap.py','ops/install/rbridge_install.py',
        'ops/install/rbridge_installation/bootstrap_execution_collector.py','ops/install/rbridge_installation/qualification.py'}
    if not needed<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('BOOTSTRAP_EXECUTION_COLLECTOR_ENTRY_UNQUALIFIED')


def _copy(module,evidence,payload):
    publication=evidence['publication'];raw,identity=module._protected_file(Path(publication['path']),49152,0o400)
    if raw!=payload or identity!=publication['identity']:_fail('BOOTSTRAP_EXECUTION_COLLECTOR_COPY_CHANGED')


def collect_root_bootstrap_execution(profile,runtime_manifest,toolkit_manifest,bootstrap_observation,qualification_request):
    p,root=_context(profile,qualification_request);_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    original=verify_root_bootstrap_observation(p,bootstrap_observation,runtime_manifest,toolkit_manifest,qualification_request)
    module,payload=_module(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    if base64.b64encode(payload).decode()!=original['payload_base64']:_fail('BOOTSTRAP_EXECUTION_COLLECTOR_PAYLOAD_CHANGED')
    capture=original['evidence']['capture'];manifest=original['manifest'];assert_owned_helpers_settled()
    fixture=_FixtureDirectory(p,prefix='.rbridge-bootstrap-fixture-',limit=p.budget.carrier_bytes)
    try:
        binding={'repository':p.binding.repository,'author':p.binding.author,'issue_number':capture['issue_number']}
        publication=module._publish_root_fixture_bootstrap(fixture.path,payload,manifest,capture,binding)
        evidence={'schema':'RBRIDGE_BOOTSTRAP_EXECUTION_CAPTURE_V1','scope':'COPIED_BOOTSTRAP_EXECUTION_DATA_ONLY',
            'profile_sha256':report_sha256(p),'manifest':manifest,'capture':capture,'publication':publication,'nonce':secrets.token_hex(32)}
        def guard():
            fixture.check();_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request);_copy(module,evidence,payload)
            current=verify_root_bootstrap_observation(p,bootstrap_observation,runtime_manifest,toolkit_manifest,qualification_request)
            if encode_report(current)!=encode_report(original):_fail('BOOTSTRAP_EXECUTION_COLLECTOR_AUTH_CHANGED')
        def ready(raw,observed):
            pid=parse_helper_ready(raw,evidence['nonce'])
            if type(observed) is not dict or set(observed)!={pid}:_fail('BOOTSTRAP_EXECUTION_COLLECTOR_READY_CHANGED')
            row=observed[pid];validate_owned_session(row,[row],())
            if row['uid']!=[0]*4 or row['exe']!=p.toolkit.python_path or row['argv']!=argv:
                _fail('BOOTSTRAP_EXECUTION_COLLECTOR_READY_CHANGED')
        raw_input=encode_report({'profile':p,'qualification':qualification_request})
        args=('-I','-S','-B',publication['path'],'--qualification-fixture');argv=[p.toolkit.python_path,*args]
        output,errors,session=run_owned_process(_PythonPin(p.toolkit.python_path,p.toolkit.python_sha256),args,p.budget.scan_ms,
            p.budget.carrier_bytes,input_bytes=raw_input,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/root','LC_ALL':'C',
                'RBRIDGE_BOOTSTRAP_NONCE':evidence['nonce']},guard=guard,ready=ready)
        evidence.update(input_base64=base64.b64encode(raw_input).decode(),output_base64=base64.b64encode(output).decode(),
            stderr_base64=base64.b64encode(errors).decode(),session=session)
        compare_bootstrap_execution(p,module,evidence,qualification_request);assert_owned_helpers_settled();guard()
        raw=encode_report(evidence);fixture.write(raw);guard()
        token=_RootBootstrapExecutionObservation(report_sha256(p),report_sha256(bootstrap_observation),raw.decode(),str(fixture.path))
        _observations[token]=(report_sha256(token),bootstrap_observation,runtime_manifest,toolkit_manifest,p)
        return token
    finally:fixture.close()


def verify_root_bootstrap_execution(profile,token,qualification_request,*,bootstrap_observation=None):
    if type(token) is not _RootBootstrapExecutionObservation or token not in _observations:_fail('BOOTSTRAP_EXECUTION_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,original,runtime_manifest,toolkit_manifest,original_profile=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(original_profile):_fail('BOOTSTRAP_EXECUTION_COLLECTOR_OBSERVATION_CHANGED')
    if bootstrap_observation is not None and bootstrap_observation is not original:_fail('BOOTSTRAP_EXECUTION_COLLECTOR_AUTH_ORIGIN_CHANGED')
    if report_sha256(original)!=token.bootstrap_sha256:_fail('BOOTSTRAP_EXECUTION_COLLECTOR_OBSERVATION_CHANGED')
    assert_reader_profile_extension(original_profile,profile)
    p,root=_context(original_profile,qualification_request);target,target_root=_context(profile,qualification_request)
    _materials(target,target_root,runtime_manifest,toolkit_manifest,qualification_request)
    observed=verify_root_bootstrap_observation(p,original,runtime_manifest,toolkit_manifest,qualification_request)
    module,payload=_module(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    fixture=_FixtureDirectory(p,token.fixture_path,prefix='.rbridge-bootstrap-fixture-',limit=p.budget.carrier_bytes)
    try:
        raw=fixture.read()
        if raw.decode()!=token.evidence_json:_fail('BOOTSTRAP_EXECUTION_COLLECTOR_OBSERVATION_CHANGED')
        evidence=_json(raw,p.budget.carrier_bytes);comparison=compare_bootstrap_execution(p,module,evidence,qualification_request)
        if (str(Path(evidence['publication']['path']).parents[1])!=token.fixture_path
                or evidence['manifest']!=observed['manifest'] or encode_report(evidence['capture'])!=encode_report(observed['evidence']['capture'])
                or base64.b64encode(payload).decode()!=observed['payload_base64']):_fail('BOOTSTRAP_EXECUTION_COLLECTOR_OBSERVATION_CHANGED')
        _copy(module,evidence,payload);assert_owned_helpers_settled()
        return {'schema':'RBRIDGE_ROOT_BOOTSTRAP_EXECUTION_OBSERVATION_V1','scope':'ROOT_COPIED_BOOTSTRAP_READONLY_EXECUTION',
            'status':'PASS','original_profile_sha256':token.profile_sha256,'profile_sha256':report_sha256(target),
            'evidence_sha256':hashlib.sha256(raw).hexdigest(),'evidence':evidence,'report':comparison['report'],
            'may_execute':False,'service_action_authorized':False}
    finally:fixture.close()
