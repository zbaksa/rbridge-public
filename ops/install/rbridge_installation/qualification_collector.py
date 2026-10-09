"""Join genuine Root observations before owner review or bundle issuance.

Original live producer references and full retained bytes are both mandatory.
Collecting these materials grants no installation or service permission. Fresh
preparation validation and preserving historical fixture provenance after our
own production switch are deliberately different operations.
"""
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sys
import weakref
from .artifact_collector import _closure,verify_root_artifact_for_reader_profile
from .bootstrap_collector import verify_root_bootstrap_observation
from .bootstrap_execution_collector import verify_root_bootstrap_execution
from .bootstrap_fixture_collector import _module
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .privileged_collector import PrivilegedFixtureOrigins,ORIGIN_FIELDS as PRIVILEGED_FIELDS,verify_root_privileged_observation
from .profile import parse_profile,assert_reader_profile_extension
from .qualification import _source,_artifact,_readers,_privileged,verify_import_closure
from .reader_adoption_collector import verify_root_reader_adoption_observation
from .reader_collector import verify_root_reader_observation
from .readonly_helper import _json
from .source_ci_collector import verify_root_source_ci_observation
from .canary_data import read_profile_canary


class QualificationCollectorError(InstallationError):pass
def _fail(reason):raise QualificationCollectorError(reason)


@dataclass(frozen=True,eq=False)
class QualificationOrigins:
    source:object
    artifact:object
    readers:object
    adoption:object
    privileged:object
    privileged_origins:object
    bootstrap:object
    bootstrap_execution:object


@dataclass(frozen=True,eq=False)
class _RootQualificationMaterialObservation:
    profile_sha256:str
    base_profile_sha256:str
    origins_sha256:str
    evidence_json:str
    fixture_path:str


ORIGIN_FIELDS=('source','artifact','readers','adoption','privileged','privileged_origins','bootstrap','bootstrap_execution')
_observations=weakref.WeakKeyDictionary()


def _snapshot(origins):
    if type(origins) is not QualificationOrigins or type(origins.privileged_origins) is not PrivilegedFixtureOrigins:
        _fail('QUALIFICATION_COLLECTOR_ORIGIN_SET_UNQUALIFIED')
    return (tuple(getattr(origins,k) for k in ORIGIN_FIELDS)
        +tuple(getattr(origins.privileged_origins,k) for k in PRIVILEGED_FIELDS))


def _same(origins,originals):
    if type(originals) is not tuple or len(originals)!=15 or any(a is not b for a,b in zip(_snapshot(origins),originals)):
        _fail('QUALIFICATION_COLLECTOR_ORIGIN_SET_CHANGED')


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/qualification_collector.py'):
        _fail('QUALIFICATION_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _materials(p,root,runtime_manifest,toolkit_manifest,request):
    _closure(p,root,runtime_manifest,toolkit_manifest,request)
    required={'ops/install/rbridge_installation/qualification_collector.py','ops/install/rbridge_installation/reader_adoption_collector.py',
        'ops/install/rbridge_installation/bootstrap_execution_collector.py','dist/server/cli/rbridgeInstallationAudit.js'}
    if not required<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('QUALIFICATION_COLLECTOR_ENTRY_UNQUALIFIED')


def _observe(p,base,root,runtime_manifest,toolkit_manifest,origins,request):
    _materials(p,root,runtime_manifest,toolkit_manifest,request)
    assert_reader_profile_extension(base,p);_snapshot(origins)
    if (origins.privileged_origins.artifact is not origins.artifact or origins.privileged_origins.bootstrap is not origins.bootstrap):
        _fail('QUALIFICATION_COLLECTOR_ORIGIN_RELATION_CHANGED')
    rows={
        'source_ci':verify_root_source_ci_observation(p,origins.source,request),
        'artifact':verify_root_artifact_for_reader_profile(p,origins.artifact,request),
        'readers':verify_root_reader_observation(p,origins.readers,request,artifact_observation=origins.artifact),
        'adoption':verify_root_reader_adoption_observation(p,origins.adoption,request,reader_observation=origins.readers),
        'privileged':verify_root_privileged_observation(p,origins.privileged,request,origins=origins.privileged_origins),
        'bootstrap':verify_root_bootstrap_observation(base,origins.bootstrap,runtime_manifest,toolkit_manifest,request),
        'bootstrap_execution':verify_root_bootstrap_execution(p,origins.bootstrap_execution,request,bootstrap_observation=origins.bootstrap)}
    scopes={'source_ci':'ROOT_AUTHENTICATED_SOURCE_CI','artifact':'ROOT_FINAL_ARTIFACT_OBSERVATION',
        'readers':'ROOT_INSTALLED_READER_INVOCATIONS','adoption':'ROOT_AUTHENTICATED_OWNER_READER_ADOPTION',
        'privileged':'ROOT_PROTECTED_PRIVILEGED_FIXTURE_OBSERVATION','bootstrap':'ROOT_AUTHENTICATED_BOOTSTRAP_BYTES',
        'bootstrap_execution':'ROOT_COPIED_BOOTSTRAP_READONLY_EXECUTION'}
    for name,row in rows.items():
        if (row.get('scope')!=scopes[name] or row.get('service_action_authorized') is not False
                or name!='artifact' and (row.get('status')!='PASS' or row.get('may_execute') is not False)):
            _fail('QUALIFICATION_COLLECTOR_COMPONENT_INCOMPLETE')
    if (rows['artifact']['original_profile_sha256']!=report_sha256(base)
            or rows['privileged']['original_profile_sha256']!=report_sha256(base)
            or rows['bootstrap_execution']['original_profile_sha256']!=report_sha256(base)
            or rows['readers']['non_archive_fixture_origin']!='ROOT_PROTECTED_CORE_AND_MCP_FIXTURE_PRODUCERS'
            or rows['adoption']['workflow_adoption_origin']!='AUTHENTICATED_OWNER_DECLARATION'
            or rows['adoption']['inventory_origin']!='OWNER_DECLARATION_NOT_INDEPENDENT_DISCOVERY'
            or rows['adoption']['external_workflow_execution']!='NOT_OBSERVED'):
        _fail('QUALIFICATION_COLLECTOR_COMPONENT_RELATION_CHANGED')
    _source(p,rows['source_ci']['source']);_artifact(p,rows['artifact']['artifact'])
    _readers(p,rows['readers']['readers']);_privileged(base,rows['privileged']['qualification'])
    contexts={r.trusted_context_sha256 for r in p.readers if r.transport=='GITHUB'}
    if len(contexts)!=1:_fail('QUALIFICATION_COLLECTOR_READER_CONTEXT_INCOMPLETE')
    helper=next(e for e in toolkit_manifest.entries if e.path=='dist/server/cli/rbridgeInstallationAudit.js')
    canary,canary_observation=read_profile_canary(p)
    if not canary or hashlib.sha256(canary).hexdigest()!=p.service.canary_sha256:_fail('QUALIFICATION_COLLECTOR_CANARY_CHANGED')
    canary.decode('utf-8',errors='strict');closure=verify_import_closure(root,p,request);assert_owned_helpers_settled()
    evidence={'schema':'RBRIDGE_QUALIFICATION_MATERIAL_EVIDENCE_V1','profile':p,'base_profile':base,
        'runtime_manifest':runtime_manifest,'toolkit_manifest':toolkit_manifest,'observations':rows,'import_closure':closure,
        'source_ci_locator':{'run_id':origins.source.run_id,'job_id':origins.source.job_id},
        'readers_sha256':report_sha256(rows['readers']['readers']),'reader_context_sha256':next(iter(contexts)),
        'helper_sha256':helper.sha256,'canary_base64':base64.b64encode(canary).decode(),
        'canary_observation':canary_observation,
        'owner_review':'NOT_COLLECTED','installation_authority':False,'service_action_authorized':False}
    if len(encode_report(evidence))>p.budget.carrier_bytes:_fail('QUALIFICATION_COLLECTOR_EVIDENCE_BYTE_LIMIT')
    return evidence


def collect_root_qualification_material(profile,base_profile,runtime_manifest,toolkit_manifest,origins,qualification_request):
    p,root=_context(profile,qualification_request);base=parse_profile(json.loads(encode_report(base_profile)))
    assert_reader_profile_extension(base,p);originals=_snapshot(origins);request=_json(encode_report(qualification_request))
    fixture=_FixtureDirectory(p,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        evidence=_observe(p,base,root,runtime_manifest,toolkit_manifest,origins,request);_same(origins,originals)
        raw=encode_report(evidence);fixture.write(raw)
        if not _same_evidence(evidence,_observe(p,base,root,runtime_manifest,toolkit_manifest,origins,request)):
            _fail('QUALIFICATION_COLLECTOR_COMPONENT_CHANGED')
        _same(origins,originals);fixture.check()
        token=_RootQualificationMaterialObservation(report_sha256(p),report_sha256(base),report_sha256(origins),raw.decode(),str(fixture.path))
        _observations[token]=(report_sha256(token),origins,originals,base,p,runtime_manifest,toolkit_manifest,encode_report(request).decode())
        return token
    finally:fixture.close()


def _same_evidence(previous,current):
    """Data only. Callers first concretely verify the entire current Root closure.

    Later imports/mappings may grow within that independently checked immutable
    closure. Preserve the complete original observation and require every other
    closure pin and every full producer preimage to remain unchanged.
    """
    try:
        before=_json(encode_report(previous));after=_json(encode_report(current))
        a=dict(before['import_closure']);b=dict(after['import_closure'])
        for row in (a,b):
            if type(row['imports']) is not list or type(row['mapped_files']) is not list:return False
            row.pop('imports');row.pop('mapped_files')
        if encode_report(a)!=encode_report(b):return False
        after['import_closure']=before['import_closure']
        return encode_report(before)==encode_report(after)
    except (ValueError,TypeError,KeyError,AttributeError):return False


def _registered(profile,token,request,origins=None):
    if type(token) is not _RootQualificationMaterialObservation or token not in _observations:_fail('QUALIFICATION_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,original,originals,base,p,runtime_manifest,toolkit_manifest,request_json=_observations[token]
    if (report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile) or token.profile_sha256!=report_sha256(p)
            or token.base_profile_sha256!=report_sha256(base) or token.origins_sha256!=report_sha256(original)
            or encode_report(request).decode()!=request_json):_fail('QUALIFICATION_COLLECTOR_OBSERVATION_CHANGED')
    if origins is not None and origins is not original:_fail('QUALIFICATION_COLLECTOR_ORIGIN_SET_CHANGED')
    _same(original,originals)
    return original,base,p,runtime_manifest,toolkit_manifest


def _retained(p,token):
    fixture=_FixtureDirectory(p,token.fixture_path,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        raw=fixture.read()
        if raw.decode()!=token.evidence_json:_fail('QUALIFICATION_COLLECTOR_OBSERVATION_CHANGED')
        value=_json(raw,p.budget.carrier_bytes)
        if encode_report(value)!=raw:_fail('QUALIFICATION_COLLECTOR_OBSERVATION_CHANGED')
        return value,hashlib.sha256(raw).hexdigest()
    finally:fixture.close()


def _result(p,token,value,digest,scope):
    return {'schema':'RBRIDGE_ROOT_QUALIFICATION_MATERIAL_V1','scope':scope,'status':'PASS',
        'profile_sha256':token.profile_sha256,'base_profile_sha256':token.base_profile_sha256,
        'evidence_sha256':digest,'evidence':value,'installation_authority':False,
        'may_execute':False,'service_action_authorized':False}


def verify_root_qualification_material(profile,token,qualification_request,*,origins=None):
    original,base,p,runtime_manifest,toolkit_manifest=_registered(profile,token,qualification_request,origins)
    p,root=_context(p,qualification_request);value,digest=_retained(p,token)
    current=_observe(p,base,root,runtime_manifest,toolkit_manifest,original,qualification_request)
    if not _same_evidence(value,current):_fail('QUALIFICATION_COLLECTOR_COMPONENT_CHANGED')
    _registered(profile,token,qualification_request,origins)
    return _result(p,token,value,digest,'ROOT_COMPLETE_QUALIFICATION_MATERIAL')


def preserve_root_qualification_material(profile,token,qualification_request):
    """Preserve historical origin after our switch; never repeat its fake-unit case."""
    original,base,p,runtime_manifest,toolkit_manifest=_registered(profile,token,qualification_request)
    p,root=_context(p,qualification_request);_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    value,digest=_retained(p,token)
    if type(value.get('canary_observation')) is not dict:_fail('QUALIFICATION_COLLECTOR_CANARY_OBSERVATION_MISSING')
    canary,_canary_observation=read_profile_canary(p,previous_observation=value['canary_observation'])
    if base64.b64encode(canary).decode()!=value['canary_base64']:_fail('QUALIFICATION_COLLECTOR_CANARY_CHANGED')
    module,payload=_module(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    publication=value['observations']['bootstrap_execution']['evidence']['publication']
    raw,identity=module._protected_file(Path(publication['path']),49152,0o400)
    if raw!=payload or identity!=publication['identity']:_fail('QUALIFICATION_COLLECTOR_BOOTSTRAP_CHANGED')
    _registered(profile,token,qualification_request);assert_owned_helpers_settled()
    return _result(p,token,value,digest,'ROOT_PRESERVED_QUALIFICATION_MATERIAL')
