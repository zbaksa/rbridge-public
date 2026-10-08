"""Fixed protected producer origin for isolated Core carrier cases.

The local carrier port performs no network writes. Its captured bytes remain
Source fixture data; only the actual Root launcher registers the protected
runtime observation. Neither class of proof authenticates workflow adoption,
qualifies a service switch, or issues a full installation bundle.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import weakref
from .artifact_collector import _closure,verify_root_artifact_for_reader_profile
from .host_backend import _assert_kernel_namespace,_run_fixed_tool
from .models import InstallationError,encode_report,report_sha256
from .owned_process import run_owned_process,assert_owned_helpers_settled
from .profile import parse_profile,assert_reader_profile_extension
from .qualification import verify_import_closure,_artifact_preimages
from .readonly_helper import _json,validate_readonly_ready,parse_helper_ready


class CoreCollectorError(InstallationError):pass
def _fail(reason):raise CoreCollectorError(reason)


@dataclass(frozen=True,eq=False)
class _RootCoreObservation:
    profile_sha256:str
    input_json:str
    output_json:str
    session_json:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/core_collector.py'):
        _fail('CORE_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();verify_import_closure(root,p,request);return p,root


def _packet(profile,root,runtime_manifest,toolkit_manifest,artifact,context,request):
    if (type(context) is not str or not re.fullmatch('[0-9a-f]{64}',context)
            or any(r.transport=='GITHUB' and r.trusted_context_sha256!=context for r in profile.readers)):
        _fail('CORE_COLLECTOR_CONTEXT_INVALID')
    _closure(profile,root,runtime_manifest,toolkit_manifest,request)
    original=verify_root_artifact_for_reader_profile(profile,artifact,request)
    needed={'dist/server/cli/rbridgeReadResult.js','dist/server/installation/archivedReaderFixture.js',
        'dist/server/installation/coreCarrierFixture.js','ops/install/rbridge_installation/core_collector.py'}
    if not needed<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('CORE_COLLECTOR_ENTRY_UNQUALIFIED')
    packet={'schema':'RBRIDGE_READER_INPUT_V1','operation':'PRODUCE_CORE_ARCHIVED_ARTIFACT','profile':profile,
        'runtime_manifest':runtime_manifest,'toolkit_manifest':toolkit_manifest,'isolated_home':artifact.fixture_home,
        'artifact_fixture':original['artifact']['receipts'],'context_sha256':context}
    if len(encode_report(packet))>profile.budget.carrier_bytes:_fail('CORE_COLLECTOR_INPUT_LIMIT')
    return _json(encode_report(packet))


def compare_core_producer_output(profile,output,artifact_fixture,context):
    """Bounded full-data comparison only. No scope or SHA registers origin."""
    if len(encode_report({'output':output,'artifact':artifact_fixture}))>profile.budget.carrier_bytes:
        _fail('CORE_COLLECTOR_EVIDENCE_BYTE_LIMIT')
    _artifact_preimages(profile,artifact_fixture)
    binding={'runtimeUid':profile.binding.uid,'principalId':profile.binding.principal_id,'targetInstanceId':profile.binding.target_instance_id}
    originals=[{'operation_id':r['operationId'],'receipt_json':r['receiptJSON'],
        'receipt_sha256':r['receiptSHA256'],'output_sha256':r['resultSHA256']} for r in artifact_fixture['receipts']]
    if (type(output) is not dict or set(output)!={'schema','scope','producer_source_sha','binding_sha256','context_sha256','original_receipts','originals_unchanged','cases'}
            or output['schema']!='RBRIDGE_ISOLATED_CORE_CASES_V1' or output['scope']!='ISOLATED_CORE_SOURCE_DATA_ONLY'
            or output['producer_source_sha']!=profile.runtime.source_sha or output['binding_sha256']!=report_sha256(binding)
            or output['context_sha256']!=context or output['originals_unchanged'] is not True
            or encode_report(output['original_receipts'])!=encode_report(originals)
            or type(output['cases']) is not list or len(output['cases'])!=16):_fail('CORE_COLLECTOR_OUTPUT_INVALID')
    expected_ids=[('C02','health'),('C02','file'),('C03','missing'),('C03','blocked'),('C04','large'),
        ('C05','digest-substitution'),('C06','foreign-author'),('C07','expired-closed-replay'),('C08','fresh-expired'),('C08','collision'),
        ('C04','large-missing'),('C04','large-conflicting'),('C04','large-mixed'),('C04','large-corrupt'),
        ('C06','rehashed-foreign-scope'),('C06','rehashed-foreign-policy')]
    fixtures=[]
    for case,(case_id,suffix) in zip(output['cases'],expected_ids):
        fields={'fixture_id','case_id','transport','provenance','capture','expected','expected_verdict_json','expected_verdict_sha256','expected_verdict_canonical_sha256'}
        if case_id=='C07':fields.add('replayed_at')
        if (type(case) is not dict or set(case)!=fields or case['fixture_id']!='core-producer-'+suffix
                or case['case_id']!=case_id or case['transport']!='GITHUB' or case['provenance']!='SOURCE_PRODUCER'):
            _fail('CORE_COLLECTOR_CASE_INVALID')
        capture=case['capture'];expected=case['expected'];raw=case['expected_verdict_json']
        if type(capture) is not dict or type(expected) is not dict or type(raw) is not str:_fail('CORE_COLLECTOR_CASE_INVALID')
        base={k:v for k,v in capture.items() if k!='capture_sha256'}
        if (capture.get('scope')!='FIXTURE_AUTHORITY_ONLY' or capture.get('complete') is not True
                or capture.get('repository')!=profile.binding.repository or capture.get('viewer')!=profile.binding.author
                or capture.get('context_sha256')!=context or capture.get('capture_sha256')!=report_sha256(base)
                or expected.get('capture_sha256')!=capture['capture_sha256'] or expected.get('capture_context_sha256')!=context
                or expected.get('producer_source_sha')!=profile.runtime.source_sha or expected.get('expected_source_sha')!=profile.runtime.source_sha
                or expected.get('mode')!='CORE' or expected.get('repository')!=profile.binding.repository or expected.get('author')!=profile.binding.author
                or expected.get('runtime_uid')!=profile.binding.uid or expected.get('policy_sha256')!=profile.binding.policy_sha256
                or hashlib.sha256(raw.encode()).hexdigest()!=case['expected_verdict_sha256']):_fail('CORE_COLLECTOR_CASE_CHANGED')
        verdict=_json(raw.encode(),profile.budget.carrier_bytes)
        if (verdict.get('scope')!='REFERENCE_PARSER_ONLY' or report_sha256(verdict)!=case['expected_verdict_canonical_sha256']):
            _fail('CORE_COLLECTOR_ORACLE_INVALID')
        fixtures.append({k:v for k,v in case.items() if k not in ('expected_verdict_json','expected_verdict_canonical_sha256')})
    return {'scope':'ISOLATED_CORE_SOURCE_DATA_ONLY','fixtures':fixtures,'may_execute':False}


def collect_root_core_cases(profile,runtime_manifest,toolkit_manifest,artifact_observation,context_sha256,qualification_request):
    p,root=_context(profile,qualification_request)
    packet=_packet(p,root,runtime_manifest,toolkit_manifest,artifact_observation,context_sha256,qualification_request)
    runuser=next(t for t in p.tools if t.role=='runuser')
    if _run_fixed_tool(runuser,('--version',),5000,16384).decode().splitlines()[0]!=runuser.version:
        _fail('CORE_COLLECTOR_RUNUSER_UNQUALIFIED')
    # Shared existing-only descriptor retention; import here avoids a consumer cycle.
    from .reader_collector import _RetainedFixtureHome
    home=_RetainedFixtureHome(p,packet['isolated_home'])
    try:
        args=[p.runtime.node_path,str(root/'dist/server/cli/rbridgeReadResult.js')]
        argv=[runuser.path,'--user',p.binding.account,'--',*args]
        spec={'exe':p.runtime.node_path,'argv':args,'uid':p.binding.uid,'gid':p.binding.gid,
            'groups':list(p.binding.supplementary_gids),'parent_argv':argv,'max_count':1}
        nonce=secrets.token_hex(32);child=None
        def started(actual):
            nonlocal child
            child=actual
        def ready(raw,observed):
            if child is None:_fail('CORE_COLLECTOR_PARENT_UNQUALIFIED')
            validate_readonly_ready(raw,nonce,child.pid,observed,spec)
        def guard():
            _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request);home.check()
        raw,errors,session=run_owned_process(runuser,argv[1:],min(p.budget.acceptance_ms,180000),p.budget.carrier_bytes,
            input_bytes=encode_report(packet),child_specs=[spec],guard=guard,started=started,ready=ready,
            env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':p.binding.home,'USER':p.binding.account,'LOGNAME':p.binding.account,
                'LC_ALL':'C','RBRIDGE_INSTALL_HELPER_NONCE':nonce})
        parse_helper_ready(errors,nonce);output=_json(raw,p.budget.carrier_bytes)
        compare_core_producer_output(p,output,packet['artifact_fixture'],context_sha256)
        if session['exit_code']!=0:_fail('CORE_COLLECTOR_EXIT_INCONSISTENT')
        assert_owned_helpers_settled();guard()
        token=_RootCoreObservation(report_sha256(p),encode_report(packet).decode(),raw.decode('utf-8',errors='strict'),
            encode_report({'session':session,'ready_json':errors.decode(),'nonce':nonce}).decode())
        if len(encode_report(token))>p.budget.carrier_bytes:_fail('CORE_COLLECTOR_EVIDENCE_BYTE_LIMIT')
        _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest,artifact_observation,p)
        return token
    finally:home.close()


def verify_root_core_observation(profile,token,qualification_request,*,artifact_observation=None):
    if type(token) is not _RootCoreObservation or token not in _observations:_fail('CORE_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,runtime_manifest,toolkit_manifest,artifact,original=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(original):_fail('CORE_COLLECTOR_OBSERVATION_CHANGED')
    if artifact_observation is not None and artifact_observation is not artifact:
        _fail('CORE_COLLECTOR_ARTIFACT_ORIGIN_CHANGED')
    assert_reader_profile_extension(original,profile)
    p,root=_context(original,qualification_request);target,target_root=_context(profile,qualification_request)
    _closure(target,target_root,runtime_manifest,toolkit_manifest,qualification_request)
    packet=_json(token.input_json.encode());output=_json(token.output_json.encode());proof=_json(token.session_json.encode())
    actual=_packet(p,root,runtime_manifest,toolkit_manifest,artifact,packet['context_sha256'],qualification_request)
    if (encode_report(actual).decode()!=token.input_json or any(r.transport=='GITHUB' and r.trusted_context_sha256!=packet['context_sha256'] for r in target.readers)):
        _fail('CORE_COLLECTOR_OBSERVATION_CHANGED')
    comparison=compare_core_producer_output(target,output,packet['artifact_fixture'],packet['context_sha256'])
    parse_helper_ready(proof['ready_json'].encode(),proof['nonce']);session=proof['session']
    if (session['scope']!='ROOT_FIXED_PROCESS_OBSERVATION' or session['status']!='PASS' or session['exit_code']!=0 or session['live_helpers']!=[]
            or session['input_sha256']!=hashlib.sha256(token.input_json.encode()).hexdigest()
            or session['output_sha256']!=hashlib.sha256(token.output_json.encode()).hexdigest()):_fail('CORE_COLLECTOR_OBSERVATION_CHANGED')
    return {'schema':'RBRIDGE_ROOT_CORE_OBSERVATION_V1','scope':'ROOT_PROTECTED_CORE_FIXTURE_PRODUCER','status':'PASS',
        'original_profile_sha256':token.profile_sha256,'reader_profile_sha256':report_sha256(target),'fixtures':comparison['fixtures'],
        'output':output,'session':proof,'workflow_adoption':'UNKNOWN','may_execute':False,'service_action_authorized':False}
