"""Fixed protected read-only SDK producer against the original artifact owner.

Full wire/operation bytes remain Source fixture data. Only the real protected
Root launcher registers the origin token; neither it nor serialized PASS grants
workflow adoption, production acceptance, service actions or a full bundle.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
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


class McpCollectorError(InstallationError):pass
def _fail(reason):raise McpCollectorError(reason)


@dataclass(frozen=True,eq=False)
class _RootMcpObservation:
    profile_sha256:str
    input_json:str
    output_json:str
    session_json:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/mcp_collector.py'):
        _fail('MCP_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();verify_import_closure(root,p,request);return p,root


def _packet(profile,root,runtime_manifest,toolkit_manifest,artifact,request):
    _closure(profile,root,runtime_manifest,toolkit_manifest,request)
    observed=verify_root_artifact_for_reader_profile(profile,artifact,request)
    needed={'dist/server/cli/rbridgeReadResult.js','dist/server/installation/archivedReaderFixture.js',
        'dist/server/installation/mcpArtifactFixture.js','dist/server/installation/artifactFixture.js',
        'dist/server/installation/mcpNegativeCases.js','dist/server/installation/mcpNegativeFixture.js',
        'ops/install/rbridge_installation/mcp_collector.py'}
    if not needed<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('MCP_COLLECTOR_ENTRY_UNQUALIFIED')
    packet={'schema':'RBRIDGE_READER_INPUT_V1','operation':'PRODUCE_MCP_ARCHIVED_ARTIFACT','profile':profile,
        'runtime_manifest':runtime_manifest,'toolkit_manifest':toolkit_manifest,'isolated_home':artifact.fixture_home,
        'artifact_fixture':observed['artifact']['receipts']}
    if len(encode_report(packet))>profile.budget.carrier_bytes:_fail('MCP_COLLECTOR_INPUT_LIMIT')
    return _json(encode_report(packet))


def compare_mcp_producer_output(profile,output,artifact_fixture):
    """Full-data comparison only; a matching rehash never registers origin."""
    if len(encode_report({'output':output,'artifact':artifact_fixture}))>profile.budget.carrier_bytes:
        _fail('MCP_COLLECTOR_EVIDENCE_BYTE_LIMIT')
    _artifact_preimages(profile,artifact_fixture)
    binding={'runtimeUid':profile.binding.uid,'principalId':profile.binding.principal_id,'targetInstanceId':profile.binding.target_instance_id}
    originals=[{'operation_id':r['operationId'],'receipt_json':r['receiptJSON'],
        'receipt_sha256':r['receiptSHA256'],'output_sha256':r['resultSHA256']} for r in artifact_fixture['receipts']]
    if (type(output) is not dict or set(output)!={'schema','scope','producer_source_sha','binding_sha256','original_receipts','originals_unchanged','cases'}
            or output['schema']!='RBRIDGE_ISOLATED_MCP_CASES_V1' or output['scope']!='ISOLATED_MCP_SOURCE_DATA_ONLY'
            or output['producer_source_sha']!=profile.runtime.source_sha or output['binding_sha256']!=report_sha256(binding)
            or output['originals_unchanged'] is not True or encode_report(output['original_receipts'])!=encode_report(originals)
            or type(output['cases']) is not list or len(output['cases'])!=24):_fail('MCP_COLLECTOR_OUTPUT_INVALID')
    fixtures=[]
    for case,era,original in zip(output['cases'],('legacy','modern'),artifact_fixture['receipts']):
        fields={'fixture_id','case_id','transport','provenance','era','expected','expected_verdict_json',
            'expected_verdict_sha256','expected_verdict_canonical_sha256','sdk_transcript_json'}
        if (type(case) is not dict or set(case)!=fields or case['fixture_id']!='mcp-producer-'+era
                or case['case_id']!='C09' or case['transport']!='MCP' or case['provenance']!='SOURCE_PRODUCER'
                or case['era']!=era or type(case['expected_verdict_json']) is not str or type(case['sdk_transcript_json']) is not str):
            _fail('MCP_COLLECTOR_CASE_INVALID')
        receipt=_json(original['receiptJSON'].encode());raw=case['expected_verdict_json'];verdict=_json(raw.encode(),profile.budget.carrier_bytes)
        expected={'operationId':original['operationId'],'principalId':binding['principalId'],'targetInstanceId':binding['targetInstanceId'],
            'runtime_uid':binding['runtimeUid'],'intent_sha256':receipt['intentSha256'],'policy_sha256':profile.binding.policy_sha256,
            'receipt_sha256':original['receiptSHA256'],'output_sha256':original['resultSHA256'],
            'deadline_ms':min(profile.budget.acceptance_ms,180000)}
        vf={'scope','query_evidence','status','reason_codes','receipt','output','output_sha256','raw_output_base64',
            'response_sha256','sdk_package_version','negotiated_protocol_version','protocol_era'}
        if (encode_report(case['expected'])!=encode_report(expected) or type(verdict) is not dict or set(verdict)!=vf
                or hashlib.sha256(raw.encode()).hexdigest()!=case['expected_verdict_sha256']
                or report_sha256(verdict)!=case['expected_verdict_canonical_sha256'] or verdict['scope']!='REFERENCE_MCP_READ'
                or verdict['status']!='RESULT' or verdict['reason_codes']!=[] or verdict['receipt']!=receipt
                or verdict['output']!=_json(original['resultJSON'].encode(),8388608)
                or verdict['output_sha256']!=original['resultSHA256'] or verdict['raw_output_base64']!=original['resultBase64']
                or verdict['sdk_package_version']!='2.3.0' or verdict['protocol_era']!=era
                or (verdict['negotiated_protocol_version']!='2026-07-28' if era=='modern' else verdict['negotiated_protocol_version'] not in
                    ('2024-11-05','2025-03-26','2025-06-18','2025-11-25'))):_fail('MCP_COLLECTOR_ORACLE_CHANGED')
        transcript=_json(case['sdk_transcript_json'].encode(),profile.budget.carrier_bytes)
        tf={'sdk_package_version','negotiated_protocol_version','protocol_era','responses'}
        if (type(transcript) is not dict or set(transcript)!=tf
                or any(transcript[k]!=verdict[k] for k in tf-{'responses'}) or type(transcript['responses']) is not list):
            _fail('MCP_COLLECTOR_TRANSCRIPT_INVALID')
        capability={'schema':'RBRIDGE_MCP_CAPABILITIES_V1','mode':'SAFE','principalId':binding['principalId'],
            'targetInstanceId':binding['targetInstanceId'],'supportedKinds':['HEALTH','FILE','PROCESS','CHUNK'],
            'enabledActions':['HEALTH/STATUS','FILE/LIST','FILE/STAT','FILE/READ','FILE/READ_MANY','FILE/READ_BINARY','FILE/SEARCH'],
            'policySha256':profile.binding.policy_sha256,
            'executionAvailable':True,'executionStatus':'CORE_CONNECTED'}
        status={'schema':'RBRIDGE_MCP_CORE_QUERY_RESULT_V1','tool':'rbridge_status','result':{'status':'RECEIPT','receipt':receipt}}
        queries=[('rbridge_capabilities',{},capability),('rbridge_status',{'operationId':original['operationId']},status)]
        for raw_page in original['pagesJSON']:
            page=_json(raw_page.encode())
            queries.append(('rbridge_result',{'operationId':original['operationId'],'cursor':page['cursor'],'maxBytes':32768},
                {'schema':'RBRIDGE_MCP_CORE_QUERY_RESULT_V1','tool':'rbridge_result','result':page}))
        queries.extend([('rbridge_status',{'operationId':original['operationId']},status),('rbridge_capabilities',{},capability)])
        evidence=verdict['query_evidence'];responses=transcript['responses']
        if (type(evidence) is not list or len(evidence)!=len(queries) or len(responses)!=len(queries)
                or verdict['response_sha256']!=[q.get('response_sha256') for q in evidence if type(q) is dict]):
            _fail('MCP_COLLECTOR_TRANSCRIPT_INCOMPLETE')
        for (name,args,want),query,response in zip(queries,evidence,responses):
            if (type(query) is not dict or set(query)!={'name','arguments_json','response_json','response_sha256'}
                    or query['name']!=name or type(query['arguments_json']) is not str or type(query['response_json']) is not str
                    or encode_report(_json(query['arguments_json'].encode()))!=encode_report(args)
                    or encode_report(_json(query['response_json'].encode(),131072))!=encode_report(want)
                    or hashlib.sha256(query['response_json'].encode()).hexdigest()!=query['response_sha256']
                    or type(response) is not dict or set(response)!={'name','arguments','response'}
                    or response['name']!=name or encode_report(response['arguments'])!=encode_report(args)):
                _fail('MCP_COLLECTOR_TRANSCRIPT_CHANGED')
            frame=response['response']
            if (type(frame) is not dict or not {'content','structuredContent'}<=set(frame)
                    or set(frame)-{'content','structuredContent','isError','_meta'}
                    or 'isError' in frame and frame['isError'] is not False
                    or encode_report(frame['structuredContent'])!=encode_report(want)
                    or frame['content']!=[{'type':'text','text':query['response_json']}]
                    or '_meta' in frame and frame['_meta']!={'io.modelcontextprotocol/serverInfo':{'name':'rbridge','version':'0.1.0-dev'}}):
                _fail('MCP_COLLECTOR_FRAME_CHANGED')
        fixtures.append({k:v for k,v in case.items() if k not in ('expected_verdict_json','expected_verdict_canonical_sha256','sdk_transcript_json')})
    variants=('not-found','not-ready','terminal','unavailable','binding','schema','cursor','digest','utf8','json','canonical')
    for case,(era,variant) in zip(output['cases'][2:],((era,variant) for era in ('legacy','modern') for variant in variants)):
        fixtures.append(_compare_negative_case(profile,case,era,variant,artifact_fixture['receipts'][0]))
    return {'scope':'ISOLATED_MCP_SOURCE_DATA_ONLY','fixtures':fixtures,'may_execute':False}


def _negative_recipe(profile,original,variant):
    """Independent Python oracle for the fixed Source byte recipes."""
    binding=profile.binding;operation='artifact-mcp-'+variant
    intent=report_sha256({'schema':'RBRIDGE_OPERATION_SUBMISSION_V1','principalId':binding.principal_id,
        'targetInstanceId':binding.target_instance_id,'operation':{'kind':'HEALTH','action':'STATUS'}})
    expected={'operationId':operation,'principalId':binding.principal_id,'targetInstanceId':binding.target_instance_id,
        'runtime_uid':binding.uid,'intent_sha256':intent,'policy_sha256':binding.policy_sha256,
        'deadline_ms':min(profile.budget.acceptance_ms,180000)}
    capability={'schema':'RBRIDGE_MCP_CAPABILITIES_V1','mode':'SAFE','principalId':binding.principal_id,'targetInstanceId':binding.target_instance_id,
        'supportedKinds':['HEALTH','FILE','PROCESS','CHUNK'],
        'enabledActions':['HEALTH/STATUS','FILE/LIST','FILE/STAT','FILE/READ','FILE/READ_MANY','FILE/READ_BINARY','FILE/SEARCH'],
        'policySha256':binding.policy_sha256,'executionAvailable':True,'executionStatus':'CORE_CONNECTED'}
    queries=[('rbridge_capabilities',{},capability,False)]
    def envelope(tool,result):return {'schema':'RBRIDGE_MCP_CORE_QUERY_RESULT_V1','tool':tool,'result':result}
    if variant=='not-found':
        queries.append(('rbridge_status',{'operationId':operation},envelope('rbridge_status',{'status':'NOT_FOUND',
            'operationId':operation,'principalId':binding.principal_id,'targetInstanceId':binding.target_instance_id}),False))
        return expected,{'status':'NOT_FOUND','reason_codes':[]},queries
    if variant=='unavailable':
        queries.append(('rbridge_status',{'operationId':operation},{'schema':'RBRIDGE_MCP_CORE_QUERY_RESULT_V1','tool':'rbridge_status',
            'operationId':operation,'principalId':binding.principal_id,'targetInstanceId':binding.target_instance_id,
            'status':'UNCERTAIN','reason':'RBRIDGE_MCP_CORE_UNAVAILABLE'},True))
        return expected,{'status':'UNAVAILABLE','reason_codes':['MCP_READER_QUERY_UNAVAILABLE']},queries
    receipt=_json(original['receiptJSON'].encode());receipt['operationId']=operation;receipt['intentSha256']=intent;receipt.pop('reason',None)
    data=encode_report({'fixture':'reader-negative','text':'é🙂'})
    if variant=='utf8':data=bytes((0xc3,0x28))
    if variant=='json':data=b'{'
    if variant=='canonical':data='{ "fixture": "reader-negative", "text": "é🙂" }'.encode()
    receipt['resultSha256']='d'*64 if variant=='digest' else hashlib.sha256(data).hexdigest()
    if variant=='not-ready':
        receipt['phase']='RUNNING';receipt.pop('outcome');receipt.pop('resultSha256')
        receipt['transitions']=[row for row in receipt['transitions'] if row['phase']!='TERMINAL']
    if variant=='terminal':
        receipt['outcome']='FAIL';receipt['reason']='SOURCE_FIXTURE_TERMINAL_NO_OUTPUT';receipt.pop('resultSha256')
    expected['receipt_sha256']=report_sha256(receipt)
    if 'resultSha256' in receipt:expected['output_sha256']=receipt['resultSha256']
    status=envelope('rbridge_result' if variant=='binding' else 'rbridge_status',{'status':'RECEIPT','receipt':receipt})
    if variant=='schema':status['schema']='SOURCE_FIXTURE_WRONG_SCHEMA'
    queries.append(('rbridge_status',{'operationId':operation},status,False))
    if variant in ('not-ready','terminal'):
        return expected,{'status':'NOT_READY' if variant=='not-ready' else 'TERMINAL','reason_codes':[],'receipt':receipt},queries
    reasons={'binding':'MCP_READER_BINDING_INVALID','schema':'MCP_READER_SCHEMA_INVALID','cursor':'MCP_READER_PAGE_INVALID',
        'digest':'MCP_READER_WHOLE_DIGEST_INVALID','utf8':'MCP_READER_UTF8_INVALID','json':'MCP_READER_JSON_INVALID','canonical':'MCP_READER_CANONICAL_OUTPUT_INVALID'}
    if variant not in ('binding','schema'):
        import base64
        queries.append(('rbridge_result',{'operationId':operation,'cursor':0,'maxBytes':32768},envelope('rbridge_result',{
            'status':'RESULT','receipt':receipt,'resultSha256':receipt['resultSha256'],'cursor':0,
            'nextCursor':len(data)+(1 if variant=='cursor' else 0),'eof':True,'dataBase64':base64.b64encode(data).decode()}),False))
    return expected,{'status':'INVALID','reason_codes':[reasons[variant]]},queries


def _compare_negative_case(profile,case,era,variant,original):
    fields={'fixture_id','case_id','transport','provenance','era','expected','expected_verdict_json',
        'expected_verdict_sha256','expected_verdict_canonical_sha256','sdk_transcript_json'}
    if (type(case) is not dict or set(case)!=fields or case['fixture_id']!='mcp-producer-'+era+'-'+variant
            or case['case_id']!='C09' or case['transport']!='MCP' or case['provenance']!='SOURCE_PRODUCER' or case['era']!=era
            or type(case['expected_verdict_json']) is not str or type(case['sdk_transcript_json']) is not str):_fail('MCP_COLLECTOR_CASE_INVALID')
    expected,want,queries=_negative_recipe(profile,original,variant)
    raw=case['expected_verdict_json'];verdict=_json(raw.encode(),profile.budget.carrier_bytes)
    transcript=_json(case['sdk_transcript_json'].encode(),profile.budget.carrier_bytes)
    tf={'sdk_package_version','negotiated_protocol_version','protocol_era','responses'}
    if (type(transcript) is not dict or set(transcript)!=tf or transcript['sdk_package_version']!='2.3.0' or transcript['protocol_era']!=era
            or (transcript['negotiated_protocol_version']!='2026-07-28' if era=='modern' else transcript['negotiated_protocol_version'] not in
                ('2024-11-05','2025-03-26','2025-06-18','2025-11-25'))):_fail('MCP_COLLECTOR_TRANSCRIPT_INVALID')
    vf={'scope','query_evidence',*want}
    valid=want['status'] in ('NOT_FOUND','NOT_READY','TERMINAL')
    if valid:vf.update(('response_sha256','sdk_package_version','negotiated_protocol_version','protocol_era'))
    if (encode_report(case['expected'])!=encode_report(expected) or type(verdict) is not dict or set(verdict)!=vf
            or verdict['scope']!='REFERENCE_MCP_READ' or any(encode_report(verdict[k])!=encode_report(v) for k,v in want.items())
            or hashlib.sha256(raw.encode()).hexdigest()!=case['expected_verdict_sha256']
            or report_sha256(verdict)!=case['expected_verdict_canonical_sha256']
            or valid and any(verdict[k]!=transcript[k] for k in tf-{'responses'})):_fail('MCP_COLLECTOR_ORACLE_CHANGED')
    evidence=verdict['query_evidence'];responses=transcript['responses']
    if (type(evidence) is not list or type(responses) is not list or len(evidence)!=len(queries) or len(responses)!=len(queries)
            or valid and verdict['response_sha256']!=[q.get('response_sha256') for q in evidence if type(q) is dict]):_fail('MCP_COLLECTOR_TRANSCRIPT_INCOMPLETE')
    for (name,args,row,is_error),query,response in zip(queries,evidence,responses):
        if (type(query) is not dict or set(query)!={'name','arguments_json','response_json','response_sha256'} or query['name']!=name
                or type(query['arguments_json']) is not str or type(query['response_json']) is not str
                or encode_report(_json(query['arguments_json'].encode()))!=encode_report(args)
                or encode_report(_json(query['response_json'].encode(),131072))!=encode_report(row)
                or hashlib.sha256(query['response_json'].encode()).hexdigest()!=query['response_sha256']
                or type(response) is not dict or set(response)!={'name','arguments','response'} or response['name']!=name
                or encode_report(response['arguments'])!=encode_report(args)):_fail('MCP_COLLECTOR_TRANSCRIPT_CHANGED')
        frame=response['response']
        if (type(frame) is not dict or not {'content','structuredContent'}<=set(frame) or set(frame)-{'content','structuredContent','isError','_meta'}
                or (frame.get('isError') is not True if is_error else 'isError' in frame and frame['isError'] is not False)
                or encode_report(frame['structuredContent'])!=encode_report(row) or frame['content']!=[{'type':'text','text':query['response_json']}]
                or '_meta' in frame and frame['_meta']!={'io.modelcontextprotocol/serverInfo':{'name':'rbridge','version':'0.1.0-dev'}}):_fail('MCP_COLLECTOR_FRAME_CHANGED')
    return {k:v for k,v in case.items() if k not in ('expected_verdict_json','expected_verdict_canonical_sha256','sdk_transcript_json')}


def collect_root_mcp_cases(profile,runtime_manifest,toolkit_manifest,artifact_observation,qualification_request):
    p,root=_context(profile,qualification_request)
    packet=_packet(p,root,runtime_manifest,toolkit_manifest,artifact_observation,qualification_request)
    runuser=next(t for t in p.tools if t.role=='runuser')
    if _run_fixed_tool(runuser,('--version',),5000,16384).decode().splitlines()[0]!=runuser.version:
        _fail('MCP_COLLECTOR_RUNUSER_UNQUALIFIED')
    from .reader_collector import _RetainedFixtureHome
    home=_RetainedFixtureHome(p,packet['isolated_home'])
    try:
        runtime=Path(p.paths.release_parent)/p.runtime.source_sha;state=Path(packet['isolated_home'])/'.local/state/rbridge/execution-v2'
        args=[p.runtime.node_path,str(root/'dist/server/cli/rbridgeReadResult.js')];argv=[runuser.path,'--user',p.binding.account,'--',*args]
        binding={'runtimeUid':p.binding.uid,'principalId':p.binding.principal_id,'targetInstanceId':p.binding.target_instance_id}
        sdk=[p.runtime.node_path,str(root/'dist/server/installation/artifactFixture.js'),'--stdio-client',str(runtime),str(state),json.dumps(binding,separators=(',',':'))]
        spec={'exe':p.runtime.node_path,'argv':args,'uid':p.binding.uid,'gid':p.binding.gid,
            'groups':list(p.binding.supplementary_gids),'parent_argv':argv,'max_count':1}
        negative=[p.runtime.node_path,str(root/'dist/server/installation/mcpNegativeFixture.js'),'--stdio-client',str(runtime),str(state),json.dumps(binding,separators=(',',':'))]
        specs=[spec,{**spec,'argv':sdk,'parent_argv':args,'max_count':2},{**spec,'argv':negative,'parent_argv':args,'max_count':2}];nonce=secrets.token_hex(32);child=None
        def started(actual):
            nonlocal child
            child=actual
        def ready(raw,observed):
            if child is None:_fail('MCP_COLLECTOR_PARENT_UNQUALIFIED')
            validate_readonly_ready(raw,nonce,child.pid,observed,spec)
        def guard():
            _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request);home.check()
        raw,errors,session=run_owned_process(runuser,argv[1:],p.budget.acceptance_ms,p.budget.carrier_bytes,
            input_bytes=encode_report(packet),child_specs=specs,guard=guard,started=started,ready=ready,
            env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':p.binding.home,'USER':p.binding.account,
                'LOGNAME':p.binding.account,'LC_ALL':'C','RBRIDGE_INSTALL_HELPER_NONCE':nonce})
        parse_helper_ready(errors,nonce);output=_json(raw,p.budget.carrier_bytes)
        compare_mcp_producer_output(p,output,packet['artifact_fixture'])
        if session['exit_code']!=0:_fail('MCP_COLLECTOR_EXIT_INCONSISTENT')
        assert_owned_helpers_settled();guard()
        token=_RootMcpObservation(report_sha256(p),encode_report(packet).decode(),raw.decode('utf-8',errors='strict'),
            encode_report({'session':session,'ready_json':errors.decode(),'nonce':nonce}).decode())
        if len(encode_report(token))>p.budget.carrier_bytes:_fail('MCP_COLLECTOR_EVIDENCE_BYTE_LIMIT')
        _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest,artifact_observation,p)
        return token
    finally:home.close()


def verify_root_mcp_observation(profile,token,qualification_request,*,artifact_observation=None):
    if type(token) is not _RootMcpObservation or token not in _observations:_fail('MCP_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,runtime_manifest,toolkit_manifest,artifact,original=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(original):_fail('MCP_COLLECTOR_OBSERVATION_CHANGED')
    if artifact_observation is not None and artifact_observation is not artifact:_fail('MCP_COLLECTOR_ARTIFACT_ORIGIN_CHANGED')
    assert_reader_profile_extension(original,profile)
    p,root=_context(original,qualification_request);target,target_root=_context(profile,qualification_request)
    _closure(target,target_root,runtime_manifest,toolkit_manifest,qualification_request)
    actual=_packet(p,root,runtime_manifest,toolkit_manifest,artifact,qualification_request)
    if encode_report(actual).decode()!=token.input_json:_fail('MCP_COLLECTOR_OBSERVATION_CHANGED')
    output=_json(token.output_json.encode(),p.budget.carrier_bytes);comparison=compare_mcp_producer_output(target,output,actual['artifact_fixture'])
    proof=_json(token.session_json.encode());parse_helper_ready(proof['ready_json'].encode(),proof['nonce']);session=proof['session']
    if (session['status']!='PASS' or session['scope']!='ROOT_FIXED_PROCESS_OBSERVATION' or session['exit_code']!=0 or session['live_helpers']!=[]
            or session['input_sha256']!=hashlib.sha256(token.input_json.encode()).hexdigest()
            or session['output_sha256']!=hashlib.sha256(token.output_json.encode()).hexdigest()):_fail('MCP_COLLECTOR_OBSERVATION_CHANGED')
    return {'schema':'RBRIDGE_ROOT_MCP_OBSERVATION_V1','scope':'ROOT_PROTECTED_MCP_FIXTURE_PRODUCER','status':'PASS',
        'original_profile_sha256':token.profile_sha256,'reader_profile_sha256':report_sha256(target),'fixtures':comparison['fixtures'],
        'output':output,'session':proof,'workflow_adoption':'UNKNOWN','may_execute':False,'service_action_authorized':False}
