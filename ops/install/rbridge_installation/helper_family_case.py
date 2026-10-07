"""Full original-artifact launch/IO comparison, explicitly without Root origin.

The independent fixed roster comes from the approved profile and original
fixture packet. Rehashed caller data can be useful Source evidence; only the
separate protected collector can correlate it to a genuine observed launch.
"""
import hashlib
import json
from pathlib import Path
import re
from .artifact import ArtifactEntry,ArtifactManifest,validate_manifest
from .models import InstallationError,encode_report,report_sha256
from .owned_process import validate_owned_session
from .qualification import _artifact
from .readonly_helper import _json,parse_helper_ready


class HelperFamilyCaseError(InstallationError):pass
def _fail(reason):raise HelperFamilyCaseError(reason)


def _parsed(raw,limit,canonical=False):
    if type(raw) is not str:_fail('HELPER_FAMILY_CASE_BYTES_INVALID')
    value=_json(raw.encode('utf-8',errors='strict'),limit)
    if canonical and encode_report(value).decode()!=raw:_fail('HELPER_FAMILY_CASE_BYTES_NOT_CANONICAL')
    return value


def _manifest(value,profile,kind):
    try:
        manifest=ArtifactManifest(**{k:v for k,v in value.items() if k!='entries'},
            entries=tuple(ArtifactEntry(**e) for e in value['entries']))
        validate_manifest(manifest);pin=profile.runtime if kind=='RUNTIME' else profile.toolkit
        if (manifest.kind!=kind or manifest.sha256!=pin.manifest_sha256 or manifest.source_sha!=pin.source_sha
                or manifest.tree_sha!=pin.tree_sha or manifest.node_sha256!=profile.runtime.node_sha256):
            _fail('HELPER_FAMILY_CASE_MANIFEST_CHANGED')
    except (TypeError,KeyError,AttributeError):_fail('HELPER_FAMILY_CASE_MANIFEST_CHANGED')


def capture_helper_family_case(profile,evidence,session,fixture_home):
    """Capture full comparison inputs, never register a physical observation."""
    value={'schema':'RBRIDGE_HELPER_FAMILY_CASE_V1','scope':'ORIGINAL_ARTIFACT_HELPER_FAMILY_DATA_ONLY',
        'profile_sha256':report_sha256(profile),'fixture_home':fixture_home,
        'evidence_json':encode_report(evidence).decode(),'session_json':encode_report(session).decode()}
    value.update(evidence_sha256=hashlib.sha256(value['evidence_json'].encode()).hexdigest(),
                 session_sha256=hashlib.sha256(value['session_json'].encode()).hexdigest())
    compare_helper_family_case(profile,value)
    return value


def compare_helper_family_case(profile,value):
    """Require exact original bytes and all three fixed roles; no authority."""
    if len(encode_report(value))>profile.budget.carrier_bytes:_fail('HELPER_FAMILY_CASE_BYTE_LIMIT')
    fields={'schema','scope','profile_sha256','fixture_home','evidence_json','session_json','evidence_sha256','session_sha256'}
    if (type(value) is not dict or set(value)!=fields or value['schema']!='RBRIDGE_HELPER_FAMILY_CASE_V1'
            or value['scope']!='ORIGINAL_ARTIFACT_HELPER_FAMILY_DATA_ONLY' or value['profile_sha256']!=report_sha256(profile)
            or type(value['fixture_home']) is not str
            or not re.fullmatch(re.escape(profile.binding.home)+r'/\.rbridge-artifact-[0-9a-f]{32}',value['fixture_home'])):
        _fail('HELPER_FAMILY_CASE_IDENTITY_CHANGED')
    for raw,digest in [('evidence_json','evidence_sha256'),('session_json','session_sha256')]:
        if type(value[raw]) is not str or hashlib.sha256(value[raw].encode()).hexdigest()!=value[digest]:
            _fail('HELPER_FAMILY_CASE_PREIMAGE_CHANGED')
    evidence=_parsed(value['evidence_json'],profile.budget.carrier_bytes,True)
    session=_parsed(value['session_json'],profile.budget.carrier_bytes,True)
    if (type(evidence) is not dict or set(evidence)!={'artifact','input_json','output_json','ready_json','node_sha256',
            'runtime_manifest_sha256','toolkit_manifest_sha256'} or evidence['node_sha256']!=profile.runtime.node_sha256
            or evidence['runtime_manifest_sha256']!=profile.runtime.manifest_sha256
            or evidence['toolkit_manifest_sha256']!=profile.toolkit.manifest_sha256):_fail('HELPER_FAMILY_CASE_ARTIFACT_CHANGED')
    packet=_parsed(evidence['input_json'],profile.budget.carrier_bytes,True)
    if (type(packet) is not dict or set(packet)!={'schema','profile','runtime_manifest','toolkit_manifest','isolated_home'}
            or packet['schema']!='RBRIDGE_INSTALL_ARTIFACT_INPUT_V1' or report_sha256(packet['profile'])!=report_sha256(profile)
            or packet['isolated_home']!=value['fixture_home']):_fail('HELPER_FAMILY_CASE_INPUT_CHANGED')
    _manifest(packet['runtime_manifest'],profile,'RUNTIME');_manifest(packet['toolkit_manifest'],profile,'TOOLKIT')
    output=_parsed(evidence['output_json'],profile.budget.carrier_bytes)
    if (encode_report(output)!=encode_report(evidence['artifact']) or _artifact(profile,output)!='PASS'
            or evidence['output_json']!=encode_report(output).decode()+'\n'):_fail('HELPER_FAMILY_CASE_OUTPUT_CHANGED')
    root=Path(profile.paths.release_parent)/('toolkit-'+profile.toolkit.source_sha)
    runuser=next(t for t in profile.tools if t.role=='runuser')
    node=[profile.runtime.node_path,str(root/'dist/server/cli/rbridgeArtifactQualification.js')]
    parent_argv=[runuser.path,'--user',profile.binding.account,'--',*node]
    binding={'runtimeUid':profile.binding.uid,'principalId':profile.binding.principal_id,'targetInstanceId':profile.binding.target_instance_id}
    sdk=[profile.runtime.node_path,str(root/'dist/server/installation/artifactFixture.js'),'--stdio-client',
        str(Path(profile.paths.release_parent)/profile.runtime.source_sha),
        str(Path(value['fixture_home'])/'.local/state/rbridge/execution-v2'),json.dumps(binding,separators=(',',':'))]
    keys={'schema','scope','status','pid','argv','executable_sha256','input_sha256','processes','start_ticks','exit_code','output_sha256','live_helpers'}
    if (type(session) is not dict or set(session)!=keys or session['schema']!='RBRIDGE_OWNED_HELPER_SESSION_V1'
            or session['scope']!='ROOT_FIXED_PROCESS_OBSERVATION' or session['status']!='PASS'
            or type(session['pid']) is not int or not 2<=session['pid']<=2147483647
            or session['argv']!=parent_argv or session['executable_sha256']!=runuser.sha256
            or session['input_sha256']!=hashlib.sha256(evidence['input_json'].encode()).hexdigest()
            or session['output_sha256']!=hashlib.sha256(evidence['output_json'].encode()).hexdigest()
            or type(session['exit_code']) is not int or session['exit_code']!=0 or session['live_helpers']!=[]
            or type(session['processes']) is not list or len(session['processes'])!=3):_fail('HELPER_FAMILY_CASE_SESSION_CHANGED')
    rows=session['processes'];parents=[r for r in rows if type(r) is dict and r.get('pid')==session['pid']]
    if len(parents)!=1:_fail('HELPER_FAMILY_CASE_ROSTER_INCOMPLETE')
    parent=parents[0]
    spec={'exe':profile.runtime.node_path,'uid':profile.binding.uid,'gid':profile.binding.gid,
        'groups':list(profile.binding.supplementary_gids),'max_count':1}
    specs=[{**spec,'argv':node,'parent_argv':parent_argv},{**spec,'argv':sdk,'parent_argv':node}]
    validate_owned_session(parent,rows,specs)
    if (parent['argv']!=parent_argv or parent['exe']!=runuser.path or parent['uid']!=[0]*4 or parent['gid']!=[0]*4
            or parent['groups']!=[0] or parent['start_ticks']!=session['start_ticks']
            or [r['pid'] for r in rows]!=sorted(r['pid'] for r in rows)):_fail('HELPER_FAMILY_CASE_PARENT_CHANGED')
    owners=[r for r in rows if r['argv']==node];children=[r for r in rows if r['argv']==sdk]
    if len(owners)!=1 or len(children)!=1 or owners[0]['ppid']!=parent['pid'] or children[0]['ppid']!=owners[0]['pid']:
        _fail('HELPER_FAMILY_CASE_ROSTER_INCOMPLETE')
    ready=_parsed(evidence['ready_json'],4096)
    if type(ready) is not dict or parse_helper_ready(evidence['ready_json'].encode(),ready.get('nonce'))!=owners[0]['pid']:
        _fail('HELPER_FAMILY_CASE_READY_CHANGED')
    return {'scope':'ORIGINAL_ARTIFACT_HELPER_FAMILY_DATA_ONLY','status':'PASS',
        'observed_roles':['ROOT_RUNUSER','RUNTIME_OWNER','RUNTIME_SDK'],'case':'owned_helper_family',
        'physical_origin':'UNQUALIFIED','full_privileged_qualification':'INCOMPLETE','may_execute':False}
