"""Protected Root publication fixture bound to actual authenticated bootstrap bytes.

This exercises the standalone byte copier, never executes its copied payload.
Original protected toolkit bytes and the authenticated observation are retained;
the deliberately damaged isolated copy cannot become an install entrypoint.
"""
import base64
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import weakref
from .artifact_collector import _closure
from .bootstrap_collector import verify_root_bootstrap_observation
from .bootstrap_fixture import _produce,compare_bootstrap_case
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .host_backend import _protected_bytes
from .models import InstallationError,encode_report,report_sha256
from .profile import parse_profile,assert_reader_profile_extension
from .readonly_helper import _json


class BootstrapFixtureCollectorError(InstallationError):pass
def _fail(reason):raise BootstrapFixtureCollectorError(reason)


@dataclass(frozen=True,eq=False)
class _RootBootstrapFixtureObservation:
    profile_sha256:str
    bootstrap_sha256:str
    evidence_json:str
    fixture_path:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/bootstrap_fixture_collector.py'):
        _fail('BOOTSTRAP_FIXTURE_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _materials(p,root,runtime_manifest,toolkit_manifest,request):
    _closure(p,root,runtime_manifest,toolkit_manifest,request)
    needed={'ops/install/rbridge_bootstrap.py','ops/install/rbridge_installation/bootstrap_fixture.py',
        'ops/install/rbridge_installation/bootstrap_fixture_collector.py','ops/install/rbridge_installation/bootstrap_collector.py'}
    if not needed<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('BOOTSTRAP_FIXTURE_COLLECTOR_ENTRY_UNQUALIFIED')


def _module(p,root,runtime_manifest,toolkit_manifest,request):
    _materials(p,root,runtime_manifest,toolkit_manifest,request)
    path=root/'ops/install/rbridge_bootstrap.py';entry=next(e for e in toolkit_manifest.entries if e.path=='ops/install/rbridge_bootstrap.py')
    raw=_protected_bytes(path,49152)
    if len(raw)!=entry.size or hashlib.sha256(raw).hexdigest()!=entry.sha256:_fail('BOOTSTRAP_FIXTURE_COLLECTOR_CODE_CHANGED')
    name='_rbridge_protected_bootstrap';existing=sys.modules.get(name)
    if existing is not None:
        if getattr(existing,'__file__',None)!=str(path):_fail('BOOTSTRAP_FIXTURE_COLLECTOR_IMPORT_CHANGED')
        module=existing
    else:
        spec=importlib.util.spec_from_file_location(name,path)
        if spec is None or spec.loader is None:_fail('BOOTSTRAP_FIXTURE_COLLECTOR_IMPORT_CHANGED')
        module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    _materials(p,root,runtime_manifest,toolkit_manifest,request)
    return module,raw


def collect_root_bootstrap_fixture(profile,runtime_manifest,toolkit_manifest,bootstrap_observation,qualification_request):
    p,root=_context(profile,qualification_request);_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    original=verify_root_bootstrap_observation(p,bootstrap_observation,runtime_manifest,toolkit_manifest,qualification_request)
    module,payload=_module(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    if base64.b64encode(payload).decode()!=original['payload_base64']:_fail('BOOTSTRAP_FIXTURE_COLLECTOR_PAYLOAD_CHANGED')
    capture=original['evidence']['capture'];manifest=original['manifest']
    binding={'repository':p.binding.repository,'author':p.binding.author,'issue_number':capture['issue_number']}
    fixture=_FixtureDirectory(p,prefix='.rbridge-bootstrap-fixture-',limit=p.budget.carrier_bytes)
    try:
        def guard():
            fixture.check();_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
            verify_root_bootstrap_observation(p,bootstrap_observation,runtime_manifest,toolkit_manifest,qualification_request)
        case=_produce(fixture.path,p,module,payload,manifest,capture,binding,module._publish_root_fixture_bootstrap,guard)
        raw=encode_report(case);fixture.write(raw);guard()
        token=_RootBootstrapFixtureObservation(report_sha256(p),report_sha256(bootstrap_observation),raw.decode(),str(fixture.path))
        _observations[token]=(report_sha256(token),bootstrap_observation,runtime_manifest,toolkit_manifest,p)
        return token
    finally:fixture.close()


def verify_root_bootstrap_fixture_observation(profile,token,qualification_request,*,bootstrap_observation=None):
    if type(token) is not _RootBootstrapFixtureObservation or token not in _observations:_fail('BOOTSTRAP_FIXTURE_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,original,runtime_manifest,toolkit_manifest,original_profile=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(original_profile):_fail('BOOTSTRAP_FIXTURE_COLLECTOR_OBSERVATION_CHANGED')
    if bootstrap_observation is not None and bootstrap_observation is not original:_fail('BOOTSTRAP_FIXTURE_COLLECTOR_AUTH_ORIGIN_CHANGED')
    if report_sha256(original)!=token.bootstrap_sha256:_fail('BOOTSTRAP_FIXTURE_COLLECTOR_OBSERVATION_CHANGED')
    assert_reader_profile_extension(original_profile,profile)
    p,root=_context(original_profile,qualification_request);target,target_root=_context(profile,qualification_request)
    _materials(target,target_root,runtime_manifest,toolkit_manifest,qualification_request)
    observed=verify_root_bootstrap_observation(p,original,runtime_manifest,toolkit_manifest,qualification_request)
    module,payload=_module(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    fixture=_FixtureDirectory(p,token.fixture_path,prefix='.rbridge-bootstrap-fixture-',limit=p.budget.carrier_bytes)
    try:
        raw=fixture.read()
        if raw.decode()!=token.evidence_json:_fail('BOOTSTRAP_FIXTURE_COLLECTOR_OBSERVATION_CHANGED')
        case=_json(raw,p.budget.carrier_bytes);compare_bootstrap_case(p,module,case)
        inputs=_json(case['input_json'].encode(),p.budget.carrier_bytes);output=_json(case['output_json'].encode(),p.budget.carrier_bytes)
        if (inputs['parent']!=token.fixture_path or inputs['manifest']!=observed['manifest']
                or encode_report(inputs['capture'])!=encode_report(observed['evidence']['capture'])
                or inputs['payload_base64']!=observed['payload_base64'] or base64.b64encode(payload).decode()!=inputs['payload_base64']
                or output['publication']['scope']!='ROOT_PROTECTED_BYTES_ONLY' or output['uid']!=0 or output['euid']!=0):
            _fail('BOOTSTRAP_FIXTURE_COLLECTOR_OBSERVATION_CHANGED')
        return {'schema':'RBRIDGE_ROOT_BOOTSTRAP_FIXTURE_OBSERVATION_V1','scope':'ROOT_PROTECTED_BOOTSTRAP_FIXTURE_OBSERVATION',
            'status':'PASS','original_profile_sha256':token.profile_sha256,'profile_sha256':report_sha256(target),
            'bootstrap_sha256':token.bootstrap_sha256,'evidence_sha256':hashlib.sha256(raw).hexdigest(),'output':case,'case':'bootstrap',
            'bootstrap_execution':'NOT_PERFORMED','full_privileged_qualification':'INCOMPLETE','may_execute':False,'service_action_authorized':False}
    finally:fixture.close()
