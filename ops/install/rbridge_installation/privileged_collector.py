"""Join six actual private fixture origins; never grant installation authority.

Complete Source comparisons remain data. The protected collector verifies each
original object, retains all component bytes, and privately records their joint
origin. Bootstrap payload execution, actual workflow adoption, review and the
complete installation issuer remain distinct gates.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sys
import weakref
from .artifact_collector import _closure,verify_root_artifact_for_reader_profile
from .bootstrap_collector import verify_root_bootstrap_observation
from .bootstrap_fixture import compare_bootstrap_case
from .bootstrap_fixture_collector import _module,verify_root_bootstrap_fixture_observation
from .config_cas_collector import verify_root_config_cas_observation
from .config_cas_fixture import compare_config_cas_cases
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory,verify_root_copy_ledger_observation
from .copy_ledger_fixture import compare_copy_ledger_cases
from .fake_unit_case import compare_fake_unit_case
from .fake_unit_collector import verify_root_fake_unit_observation
from .helper_family_case import compare_helper_family_case
from .helper_family_collector import verify_root_helper_family_observation
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile,assert_reader_profile_extension
from .qualification import _privileged
from .readonly_helper import _json


class PrivilegedCollectorError(InstallationError):pass
def _fail(reason):raise PrivilegedCollectorError(reason)


@dataclass(frozen=True,eq=False)
class PrivilegedFixtureOrigins:
    artifact:object
    bootstrap:object
    copy_ledger:object
    config_cas:object
    helper_family:object
    fake_unit:object
    bootstrap_fixture:object


@dataclass(frozen=True,eq=False)
class _RootPrivilegedObservation:
    profile_sha256:str
    origins_sha256:str
    evidence_json:str
    fixture_path:str


_observations=weakref.WeakKeyDictionary()
ORIGIN_FIELDS=('artifact','bootstrap','copy_ledger','config_cas','helper_family','fake_unit','bootstrap_fixture')


def _snapshot(origins):
    if type(origins) is not PrivilegedFixtureOrigins:_fail('PRIVILEGED_COLLECTOR_COMPONENT_ORIGIN_UNQUALIFIED')
    return tuple(getattr(origins,name) for name in ORIGIN_FIELDS)


def _same_origins(origins,originals):
    if type(originals) is not tuple or len(originals)!=len(ORIGIN_FIELDS) or any(a is not b for a,b in zip(_snapshot(origins),originals)):
        _fail('PRIVILEGED_COLLECTOR_COMPONENT_ORIGIN_CHANGED')


def _record(inputs,outputs):
    a,b=encode_report(inputs).decode(),encode_report(outputs).decode()
    return {'status':'PASS','input_json':a,'output_json':b,
        'input_sha256':hashlib.sha256(a.encode()).hexdigest(),'output_sha256':hashlib.sha256(b.encode()).hexdigest()}


def compare_privileged_components(profile,module,components):
    """Compare all fixed case preimages; serialized components have no origin."""
    names={'copy_ledger','config_cas','owned_helper_family','fake_unit_stop','bootstrap'}
    if type(components) is not dict or set(components)!=names:_fail('PRIVILEGED_COMPONENT_ROSTER_INCOMPLETE')
    if len(encode_report(components))>profile.budget.carrier_bytes:_fail('PRIVILEGED_COMPONENT_BYTE_LIMIT')
    compare_copy_ledger_cases(profile,components['copy_ledger'])
    compare_config_cas_cases(profile,components['config_cas'])
    family=compare_helper_family_case(profile,components['owned_helper_family'])
    compare_fake_unit_case(profile,components['fake_unit_stop'])
    compare_bootstrap_case(profile,module,components['bootstrap'])
    # Preserve whole configuration scenario records and the whole original
    # helper evidence/session, rather than reducing either to a summary hash.
    config=components['config_cas']
    cases=dict(components['copy_ledger']['cases'])
    cases['config_cas']=_record({'profile_sha256':report_sha256(profile),
        'scenario_inputs':{k:v['input_json'] for k,v in config['cases'].items()}},config)
    cases['owned_helper_family']=_record(components['owned_helper_family'],family)
    for name in ('fake_unit_stop','bootstrap'):
        value=components[name];cases[name]={k:value[k] for k in ('status','input_json','output_json','input_sha256','output_sha256')}
    result={'schema':'RBRIDGE_PRIVILEGED_COMPONENT_DATA_V1','scope':'PRIVILEGED_COMPONENT_DATA_ONLY','status':'PASS',
        'cases':cases,'physical_origin':'UNQUALIFIED','bootstrap_execution':'NOT_PERFORMED','may_execute':False}
    if len(encode_report(result))>profile.budget.carrier_bytes:_fail('PRIVILEGED_COMPONENT_BYTE_LIMIT')
    return result


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/privileged_collector.py'):
        _fail('PRIVILEGED_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _materials(p,root,runtime_manifest,toolkit_manifest,request):
    _closure(p,root,runtime_manifest,toolkit_manifest,request)
    if 'ops/install/rbridge_installation/privileged_collector.py' not in {e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:
        _fail('PRIVILEGED_COLLECTOR_ENTRY_UNQUALIFIED')


def _observe(p,root,runtime_manifest,toolkit_manifest,origins,request):
    if type(origins) is not PrivilegedFixtureOrigins:_fail('PRIVILEGED_COLLECTOR_COMPONENT_ORIGIN_UNQUALIFIED')
    _materials(p,root,runtime_manifest,toolkit_manifest,request)
    verify_root_artifact_for_reader_profile(p,origins.artifact,request)
    verify_root_bootstrap_observation(p,origins.bootstrap,runtime_manifest,toolkit_manifest,request)
    rows={'copy_ledger':verify_root_copy_ledger_observation(p,origins.copy_ledger,request),
        'config_cas':verify_root_config_cas_observation(p,origins.config_cas,request),
        'owned_helper_family':verify_root_helper_family_observation(p,origins.helper_family,request,artifact_observation=origins.artifact),
        'fake_unit_stop':verify_root_fake_unit_observation(p,origins.fake_unit,request),
        'bootstrap':verify_root_bootstrap_fixture_observation(p,origins.bootstrap_fixture,request,bootstrap_observation=origins.bootstrap)}
    for row in rows.values():
        if (row.get('status')!='PASS' or row.get('profile_sha256')!=report_sha256(p)
                or row.get('may_execute') is not False or row.get('service_action_authorized') is not False):
            _fail('PRIVILEGED_COLLECTOR_COMPONENT_INCOMPLETE')
    module,_payload=_module(p,root,runtime_manifest,toolkit_manifest,request)
    data=compare_privileged_components(p,module,{k:v['output'] for k,v in rows.items()})
    qualification={'schema':'RBRIDGE_ROOT_FIXTURE_QUALIFICATION_V1','scope':'ISOLATED_ROOT_FIXTURES_ONLY','status':'PASS',
        'uid':os.getuid(),'euid':os.geteuid(),'runtime_uid':p.binding.uid,'production_changed':False,'cases':data['cases']}
    _privileged(p,qualification);assert_owned_helpers_settled()
    evidence={'schema':'RBRIDGE_PRIVILEGED_COMPONENT_EVIDENCE_V1','profile_sha256':report_sha256(p),
        'origins_sha256':report_sha256(origins),'components':rows,'qualification':qualification,
        'bootstrap_execution':'NOT_PERFORMED','installation_authority':False}
    if len(encode_report(evidence))>p.budget.carrier_bytes:_fail('PRIVILEGED_COLLECTOR_EVIDENCE_LIMIT')
    _materials(p,root,runtime_manifest,toolkit_manifest,request)
    return evidence


def collect_root_privileged_fixtures(profile,runtime_manifest,toolkit_manifest,origins,qualification_request):
    p,root=_context(profile,qualification_request)
    originals=_snapshot(origins);origin_pin=report_sha256(origins)
    evidence=_observe(p,root,runtime_manifest,toolkit_manifest,origins,qualification_request)
    _same_origins(origins,originals)
    if report_sha256(origins)!=origin_pin:_fail('PRIVILEGED_COLLECTOR_OBSERVATION_CHANGED')
    fixture=_FixtureDirectory(p,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        raw=encode_report(evidence);fixture.write(raw)
        if encode_report(_observe(p,root,runtime_manifest,toolkit_manifest,origins,qualification_request))!=raw:
            _fail('PRIVILEGED_COLLECTOR_OBSERVATION_CHANGED')
        _same_origins(origins,originals)
        if report_sha256(origins)!=origin_pin:_fail('PRIVILEGED_COLLECTOR_OBSERVATION_CHANGED')
        token=_RootPrivilegedObservation(report_sha256(p),report_sha256(origins),raw.decode(),str(fixture.path))
        _observations[token]=(report_sha256(token),origins,runtime_manifest,toolkit_manifest,p,originals)
        return token
    finally:fixture.close()


def verify_root_privileged_observation(profile,token,qualification_request,*,origins=None):
    if type(token) is not _RootPrivilegedObservation or token not in _observations:_fail('PRIVILEGED_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,original,runtime_manifest,toolkit_manifest,original_profile,originals=_observations[token]
    _same_origins(original,originals)
    if (report_sha256(token)!=pin or token.profile_sha256!=report_sha256(original_profile)
            or token.origins_sha256!=report_sha256(original)):_fail('PRIVILEGED_COLLECTOR_OBSERVATION_CHANGED')
    if origins is not None and origins is not original:_fail('PRIVILEGED_COLLECTOR_COMPONENT_ORIGIN_CHANGED')
    assert_reader_profile_extension(original_profile,profile)
    p,root=_context(original_profile,qualification_request);target,target_root=_context(profile,qualification_request)
    _materials(target,target_root,runtime_manifest,toolkit_manifest,qualification_request)
    actual=_observe(p,root,runtime_manifest,toolkit_manifest,original,qualification_request)
    fixture=_FixtureDirectory(p,token.fixture_path,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        raw=fixture.read()
        if raw.decode()!=token.evidence_json or raw!=encode_report(actual):_fail('PRIVILEGED_COLLECTOR_OBSERVATION_CHANGED')
        evidence=_json(raw,p.budget.carrier_bytes)
        return {'schema':'RBRIDGE_ROOT_PRIVILEGED_OBSERVATION_V1','scope':'ROOT_PROTECTED_PRIVILEGED_FIXTURE_OBSERVATION',
            'status':'PASS','profile_sha256':report_sha256(target),'original_profile_sha256':token.profile_sha256,
            'evidence_sha256':hashlib.sha256(raw).hexdigest(),'evidence':evidence,'qualification':evidence['qualification'],
            'bootstrap_execution':'NOT_PERFORMED','installation_authority':False,'may_execute':False,'service_action_authorized':False}
    finally:fixture.close()
