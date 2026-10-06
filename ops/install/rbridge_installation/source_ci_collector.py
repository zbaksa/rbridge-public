"""Authenticated exact Source CI observations, distinct from physical qualification."""
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import weakref
from .archive_collector import _query_bytes
from .artifact_collector import _closure
from .github_lookup import QualifiedGitHubReadBackend
from .host_backend import _assert_kernel_namespace
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile
from .qualification import verify_import_closure,_source
from .readonly_helper import _json


SOURCE_REPOSITORY='zbaksa/rbridge-public'
STEPS={'installation_tests':'Installation tests','tests':'Test','typecheck':'Typecheck','lint':'Lint',
    'build':'Build server','public_scrub':'Public-source scrub','tracked_clean':'Verify tracked source stayed clean'}
class SourceCICollectorError(InstallationError):pass
def _fail(reason):raise SourceCICollectorError(reason)


def _ids(run_id,job_id):
    if any(type(v) is not int or not 1<=v<=9007199254740991 for v in (run_id,job_id)):_fail('SOURCE_CI_COLLECTOR_IDS_INVALID')


def compare_source_ci(profile,run_id,job_id,run_json,job_json,commit_json,log_bytes):
    """Full bounded data comparison; this function does not authenticate a caller."""
    _ids(run_id,job_id);p=parse_profile(json.loads(encode_report(profile)))
    if type(log_bytes) is not bytes or not 1<=len(log_bytes)<=p.budget.carrier_bytes:_fail('SOURCE_CI_COLLECTOR_LOG_LIMIT')
    if sum(len(v) for v in (run_json,job_json,commit_json,log_bytes) if type(v) is bytes)>p.budget.carrier_bytes:
        _fail('SOURCE_CI_COLLECTOR_EVIDENCE_BYTE_LIMIT')
    run=_json(run_json,p.budget.lookup_response_bytes);job=_json(job_json,p.budget.lookup_response_bytes)
    commit=_json(commit_json,p.budget.lookup_response_bytes)
    if (type(run) is not dict or type(run.get('id')) is not int or run['id']!=run_id
            or run.get('head_sha')!=p.toolkit.source_sha or run.get('head_branch')!='review/p2a-installation-native'
            or run.get('status')!='completed' or run.get('conclusion')!='success' or run.get('event')!='push'
            or run.get('name')!='RBridge Local-First CI' or run.get('path')!='.github/workflows/local-first-ci.yml'
            or run.get('repository',{}).get('full_name')!=SOURCE_REPOSITORY
            or run.get('head_repository',{}).get('full_name')!=SOURCE_REPOSITORY
            or run.get('actor',{}).get('login')!=p.binding.author):_fail('SOURCE_CI_COLLECTOR_RUN_INVALID')
    if (type(commit) is not dict or commit.get('sha')!=p.toolkit.source_sha
            or commit.get('tree',{}).get('sha')!=p.toolkit.tree_sha):_fail('SOURCE_CI_COLLECTOR_TREE_INVALID')
    if (type(job) is not dict or type(job.get('id')) is not int or job['id']!=job_id
            or type(job.get('run_id')) is not int or job['run_id']!=run_id or job.get('head_sha')!=p.toolkit.source_sha
            or job.get('name')!='rbridge-local-first' or job.get('status')!='completed' or job.get('conclusion')!='success'
            or job.get('runner_name')!='rbridge-debian-ci' or type(job.get('steps')) is not list
            or not 8<=len(job['steps'])<=64):_fail('SOURCE_CI_COLLECTOR_JOB_INVALID')
    names=set();last_number=0
    for step in job['steps']:
        if (type(step) is not dict or type(step.get('name')) is not str or step['name'] in names
                or type(step.get('number')) is not int or not last_number<step['number']<=9007199254740991
                or step.get('status')!='completed' or step.get('conclusion')!='success'):_fail('SOURCE_CI_COLLECTOR_STEPS_INVALID')
        names.add(step['name']);last_number=step['number']
    if not {'Verify dedicated runner identity',*STEPS.values()}<=names:_fail('SOURCE_CI_COLLECTOR_STEPS_INCOMPLETE')
    try:
        text=log_bytes.decode('utf-8',errors='strict')
        if '\0' in text:_fail('SOURCE_CI_COLLECTOR_LOG_INVALID')
        clean=re.sub(r'\x1b\[[0-9;]*m','',text)
        # Keep complete raw bytes separately; match actual emitted summaries only.
        lines=[re.sub(r'^\d{4}-\d{2}-\d{2}T[0-9:.]+Z ','',line).strip() for line in clean.splitlines()]
        versions=[m[1] for line in lines if (m:=re.fullmatch(r'node: v(22\.[0-9]+\.[0-9]+)',line))]
        python=[m for line in lines if (m:=re.fullmatch(r'Ran ([1-9][0-9]*) tests in [0-9.]+s',line))]
        ts=[m for line in lines if (m:=re.fullmatch(r'Tests\s+([1-9][0-9]*) passed \(([1-9][0-9]*)\)',line))]
        if (len(versions)!=1 or len(python)!=1 or len(ts)!=1 or lines.count('OK')!=1
                or ts[0][1]!=ts[0][2] or any(re.match(r'FAILED\b',line) for line in lines)):
            _fail('SOURCE_CI_COLLECTOR_LOG_INVALID')
    except UnicodeError:_fail('SOURCE_CI_COLLECTOR_LOG_INVALID')
    proof={'schema':'RBRIDGE_SOURCE_QUALIFICATION_V1','scope':'SOURCE_QUALIFICATION_ONLY','commit':p.toolkit.source_sha,
        'tree':p.toolkit.tree_sha,'run_id':run_id,'conclusion':'success','node_version':versions[0],
        'steps':{k:'success' for k in STEPS},'log_base64':base64.b64encode(log_bytes).decode(),
        'log_sha256':hashlib.sha256(log_bytes).hexdigest()}
    _source(p,proof);return proof


@dataclass(frozen=True,eq=False)
class _RootSourceCIObservation:
    profile_sha256:str
    run_id:int
    job_id:int
    proof_json:str
    queries_json:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/source_ci_collector.py'):
        _fail('SOURCE_CI_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();verify_import_closure(root,p,request);return p,root


def _paths(profile,run_id,job_id):
    _ids(run_id,job_id);repo='repos/'+SOURCE_REPOSITORY
    return ['user',repo+'/actions/runs/'+str(run_id),repo+'/actions/jobs/'+str(job_id),
        repo+'/git/commits/'+profile.toolkit.source_sha,repo+'/actions/jobs/'+str(job_id)+'/logs']


def collect_root_source_ci(profile,runtime_manifest,toolkit_manifest,run_id,job_id,qualification_request):
    p,root=_context(profile,qualification_request);paths=_paths(p,run_id,job_id)
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    deadline=time.monotonic()+p.budget.lookup_overall_ms/1000
    backend=QualifiedGitHubReadBackend(p,retain_queries=True);outputs=[]
    for index,path in enumerate(paths):
        _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
        remaining=int((deadline-time.monotonic())*1000)
        if remaining<=0:_fail('SOURCE_CI_COLLECTOR_DEADLINE')
        outputs.append(backend._run(('api','--hostname','github.com','--method','GET',path),b'',
            min(p.budget.lookup_ms,remaining),p.budget.carrier_bytes if index==4 else p.budget.lookup_response_bytes))
    if time.monotonic()>=deadline:_fail('SOURCE_CI_COLLECTOR_DEADLINE')
    viewer=_json(outputs[0],p.budget.lookup_response_bytes)
    if type(viewer) is not dict or viewer.get('login')!=p.binding.author:_fail('SOURCE_CI_COLLECTOR_VIEWER_INVALID')
    proof=compare_source_ci(p,run_id,job_id,*outputs[1:])
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request);assert_owned_helpers_settled()
    token=_RootSourceCIObservation(report_sha256(p),run_id,job_id,encode_report(proof).decode(),encode_report(backend.query_evidence).decode())
    if len(encode_report(token))>p.budget.carrier_bytes:_fail('SOURCE_CI_COLLECTOR_EVIDENCE_BYTE_LIMIT')
    _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest);return token


def verify_root_source_ci_observation(profile,token,qualification_request):
    if type(token) is not _RootSourceCIObservation or token not in _observations:_fail('SOURCE_CI_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,runtime_manifest,toolkit_manifest=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile):_fail('SOURCE_CI_COLLECTOR_OBSERVATION_CHANGED')
    p,root=_context(profile,qualification_request);_closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    paths=_paths(p,token.run_id,token.job_id);queries=_json(token.queries_json.encode());gh=next(t for t in p.tools if t.role=='gh')
    args=[[gh.path,'--version'],*[[gh.path,'api','--hostname','github.com','--method','GET',path] for path in paths]]
    if type(queries) is not list or len(queries)!=len(args):_fail('SOURCE_CI_COLLECTOR_OBSERVATION_CHANGED')
    outputs=[]
    for query,argv in zip(queries,args):
        input_bytes,output=_query_bytes(query)
        if query['argv']!=argv or input_bytes!=b'':_fail('SOURCE_CI_COLLECTOR_OBSERVATION_CHANGED')
        outputs.append(output)
    if outputs[0].decode('utf-8',errors='strict').splitlines()[0]!=gh.version:_fail('SOURCE_CI_COLLECTOR_OBSERVATION_CHANGED')
    viewer=_json(outputs[1],p.budget.lookup_response_bytes)
    if type(viewer) is not dict or viewer.get('login')!=p.binding.author:_fail('SOURCE_CI_COLLECTOR_OBSERVATION_CHANGED')
    proof=compare_source_ci(p,token.run_id,token.job_id,*outputs[2:])
    if encode_report(proof).decode()!=token.proof_json:_fail('SOURCE_CI_COLLECTOR_OBSERVATION_CHANGED')
    return {'schema':'RBRIDGE_ROOT_SOURCE_CI_OBSERVATION_V1','scope':'ROOT_AUTHENTICATED_SOURCE_CI','status':'PASS',
        'source':proof,'queries':queries,'qualifies_physical_gates':False,'may_execute':False,'service_action_authorized':False}
