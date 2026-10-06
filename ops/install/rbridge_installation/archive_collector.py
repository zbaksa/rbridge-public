"""Fixed authenticated GitHub archive producer, without result or service authority.

Preserve exact request bytes and two complete comment inventories. Pure comparisons
are explicitly fixture data; only the protected Root producer registers origin.
An authenticated archive still needs the actual reader's semantic/adoption proof.
"""
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
from .artifact_collector import _closure
from .github_lookup import QualifiedGitHubReadBackend,lookup_issues,_query,_timestamp
from .host_backend import _assert_kernel_namespace
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile,assert_reader_profile_extension
from .qualification import verify_import_closure
from .readonly_helper import _json


class ArchiveCollectorError(InstallationError):pass
def _fail(reason):raise ArchiveCollectorError(reason)


def _text(value,limit):
    if type(value) is not str or '\0' in value:_fail('ARCHIVE_COLLECTOR_TEXT_INVALID')
    try:
        if len(value.encode('utf-8',errors='strict'))>limit:_fail('ARCHIVE_COLLECTOR_TEXT_LIMIT')
    except UnicodeError:_fail('ARCHIVE_COLLECTOR_TEXT_INVALID')
    return value


def _pins(value):
    keys={'schema','issue_number','request_title','request_body_sha256','context_sha256'}
    if (type(value) is not dict or set(value)!=keys or value['schema']!='RBRIDGE_GITHUB_ARCHIVE_PINS_V1'
            or type(value['issue_number']) is not int or not 1<=value['issue_number']<=2147483647
            or any(type(value[k]) is not str or not re.fullmatch('[0-9a-f]{64}',value[k])
                   for k in ('request_body_sha256','context_sha256'))):_fail('ARCHIVE_COLLECTOR_PINS_INVALID')
    if not re.fullmatch(r'\[COCWIN BRIDGE REQUEST\] [a-z0-9][a-z0-9._:-]{0,127}',_text(value['request_title'],1024)):
        _fail('ARCHIVE_COLLECTOR_PINS_INVALID')


def _issue(profile,pins,raw):
    row=_json(raw,profile.budget.carrier_object_bytes)
    url='https://github.com/'+profile.binding.repository+'/issues/'+str(pins['issue_number'])
    if (type(row) is not dict or 'pull_request' in row or type(row.get('number')) is not int
            or row['number']!=pins['issue_number'] or row.get('html_url')!=url
            or row.get('title')!=pins['request_title'] or type(row.get('user')) is not dict
            or row['user'].get('login')!=profile.binding.author or row.get('state') not in ('open','closed')
            or type(row.get('comments')) is not int or not 0<=row['comments']<=profile.budget.carrier_comments):
        _fail('ARCHIVE_COLLECTOR_ISSUE_IDENTITY_INVALID')
    body=_text(row.get('body'),65536)
    if hashlib.sha256(body.encode()).hexdigest()!=pins['request_body_sha256']:_fail('ARCHIVE_COLLECTOR_REQUEST_CHANGED')
    return {'number':row['number'],'title':row['title'],'body':body,'author':profile.binding.author,
        'url':url,'state':row['state'].upper(),'isPullRequest':False,'comments':row['comments'],
        'updated_at':_timestamp(row.get('updated_at'))}


def _comments(profile,issue,pages):
    count=issue['comments'];page_count=(count+99)//100
    if type(pages) is not list or len(pages)!=page_count+1:_fail('ARCHIVE_COLLECTOR_PAGES_INCOMPLETE')
    rows=[];last_id=0
    for index,raw in enumerate(pages):
        page=_json(raw,profile.budget.carrier_object_bytes)
        expected=min(100,max(0,count-index*100))
        if type(page) is not list or len(page)!=expected:_fail('ARCHIVE_COLLECTOR_PAGES_INCOMPLETE')
        for row in page:
            if (type(row) is not dict or type(row.get('id')) is not int or not last_id<row['id']<=9007199254740991
                    or row.get('html_url')!=issue['url']+'#issuecomment-'+str(row['id'])
                    or type(row.get('user')) is not dict):_fail('ARCHIVE_COLLECTOR_COMMENT_IDENTITY_INVALID')
            author=_text(row['user'].get('login'),256)
            if not author:_fail('ARCHIVE_COLLECTOR_COMMENT_IDENTITY_INVALID')
            created=_timestamp(row.get('created_at'));updated=_timestamp(row.get('updated_at'))
            if updated<created:_fail('ARCHIVE_COLLECTOR_COMMENT_TIMESTAMP_INVALID')
            rows.append({'id':row['id'],'author':author,'body':_text(row.get('body'),profile.budget.comment_bytes),
                'url':row['html_url'],'created_at':created,'updated_at':updated});last_id=row['id']
    return rows


def compare_archive_responses(profile,pins,viewer_json,before_json,first_pages,second_pages,after_json):
    """Bounded byte predicate only. Neither scope nor digest authenticates a caller."""
    _pins(pins);p=parse_profile(json.loads(encode_report(profile)))
    if (type(first_pages) is not list or type(second_pages) is not list
            or len(first_pages)>(p.budget.carrier_comments+99)//100+1
            or len(second_pages)>(p.budget.carrier_comments+99)//100+1):_fail('ARCHIVE_COLLECTOR_PAGES_INCOMPLETE')
    total=0
    for raw in (viewer_json,before_json,after_json,*first_pages,*second_pages):
        if type(raw) is not bytes or len(raw)>p.budget.carrier_object_bytes:_fail('ARCHIVE_COLLECTOR_RESPONSE_LIMIT')
        total+=len(raw)
        if total>p.budget.carrier_bytes:_fail('ARCHIVE_COLLECTOR_EVIDENCE_BYTE_LIMIT')
    viewer=_json(viewer_json,16384)
    if type(viewer) is not dict or viewer.get('login')!=p.binding.author:_fail('ARCHIVE_COLLECTOR_VIEWER_MISMATCH')
    before=_issue(p,pins,before_json);after=_issue(p,pins,after_json)
    first=_comments(p,before,first_pages);second=_comments(p,before,second_pages)
    if before!=after or first!=second:_fail('ARCHIVE_COLLECTOR_CHANGED_DURING_CAPTURE')
    base={'schema':'RBRIDGE_GITHUB_CARRIER_CAPTURE_V1','scope':'FIXTURE_AUTHORITY_ONLY',
        'context_sha256':pins['context_sha256'],'repository':p.binding.repository,'viewer':p.binding.author,
        'issue':{k:v for k,v in before.items() if k not in ('comments','updated_at')},
        'comments':[{k:v for k,v in row.items() if k not in ('created_at','updated_at')} for row in first],'complete':True}
    if len(encode_report(base))>p.budget.carrier_bytes:_fail('ARCHIVE_COLLECTOR_EVIDENCE_BYTE_LIMIT')
    return {**base,'capture_sha256':report_sha256(base)}


@dataclass(frozen=True,eq=False)
class _RootArchiveObservation:
    profile_sha256:str
    pins_json:str
    capture_json:str
    evidence_json:str
    queries_json:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/archive_collector.py'):
        _fail('ARCHIVE_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();verify_import_closure(root,p,request);return p,root


def _authenticated(capture):
    base={k:v for k,v in capture.items() if k!='capture_sha256'}
    base['scope']='AUTHENTICATED_GITHUB_READ';return {**base,'capture_sha256':report_sha256(base)}


def _compare_lookup(profile,pins,issue,rest):
    # The GraphQL viewer/repository/rate observation and REST inventory must agree.
    expected={k:rest[k] for k in ('number','state','title','body','author','url','isPullRequest')}
    expected['updatedAt']=rest['updated_at']
    if issue!={**expected,'capture_sha256':report_sha256(expected)}:_fail('ARCHIVE_COLLECTOR_LOOKUP_CHANGED')


def collect_root_archive(profile,runtime_manifest,toolkit_manifest,pins,qualification_request):
    p,root=_context(profile,qualification_request);_pins(pins)
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    deadline=time.monotonic()+p.budget.lookup_overall_ms/1000
    backend=QualifiedGitHubReadBackend(p,retain_queries=True)
    issues=lookup_issues(p,[pins['issue_number']],backend)
    if len(issues)!=1 or backend.capture_status!='PASS' or len(backend.query_evidence)!=2:
        _fail('ARCHIVE_COLLECTOR_LOOKUP_INCOMPLETE')
    endpoint='repos/'+p.binding.repository+'/issues/'+str(pins['issue_number'])
    def read(path):
        if time.monotonic()>=deadline:_fail('ARCHIVE_COLLECTOR_DEADLINE')
        _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
        remaining=max(1,int((deadline-time.monotonic())*1000))
        result=backend._run(('api','--hostname','github.com','--method','GET',path),b'',
            min(p.budget.lookup_ms,remaining),p.budget.carrier_object_bytes)
        if time.monotonic()>=deadline:_fail('ARCHIVE_COLLECTOR_DEADLINE')
        return result
    viewer=read('user');before=read(endpoint);rest=_issue(p,pins,before)
    lookup=_json(encode_report(issues[0]));_compare_lookup(p,pins,lookup,rest)
    def sweep():
        return [read(endpoint+'/comments?per_page=100&page='+str(page))
                for page in range(1,(rest['comments']+99)//100+2)]
    first=sweep();second=sweep();after=read(endpoint)
    capture=_authenticated(compare_archive_responses(p,pins,viewer,before,first,second,after))
    evidence={'lookup_issue':lookup,'lookup_capture_sha256':backend.capture_sha256,
        'rate_observations':backend.rate_observations,'rate_sha256':backend.rate_sha256,
        'comment_inventory':_comments(p,rest,first),'issue_inventory':rest}
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request);assert_owned_helpers_settled()
    token=_RootArchiveObservation(report_sha256(p),encode_report(pins).decode(),encode_report(capture).decode(),
        encode_report(evidence).decode(),encode_report(backend.query_evidence).decode())
    if len(encode_report(token))>p.budget.carrier_bytes:_fail('ARCHIVE_COLLECTOR_EVIDENCE_BYTE_LIMIT')
    _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest,p)
    return token


def _query_bytes(query):
    try:
        session=query['session'];values=[]
        # Owned-process sessions hash input/output. The private observation's full
        # immutable pin also covers the complete stderr bytes; do not invent a
        # session field that its concrete producer never emits.
        for key,digest in (('input_base64','input_sha256'),('output_base64','output_sha256'),('stderr_base64',None)):
            raw=base64.b64decode(query[key],validate=True)
            if (base64.b64encode(raw).decode()!=query[key]
                    or digest is not None and hashlib.sha256(raw).hexdigest()!=session[digest]):
                _fail('ARCHIVE_COLLECTOR_OBSERVATION_CHANGED')
            values.append(raw)
        if (session['status']!='PASS' or session['scope']!='ROOT_FIXED_PROCESS_OBSERVATION' or session['exit_code']!=0
                or session['live_helpers']!=[] or query['argv']!=session['argv']):_fail('ARCHIVE_COLLECTOR_OBSERVATION_CHANGED')
        return values[0],values[1]
    except (KeyError,TypeError,ValueError):_fail('ARCHIVE_COLLECTOR_OBSERVATION_CHANGED')


def verify_root_archive_observation(profile,token,runtime_manifest,toolkit_manifest,qualification_request):
    if type(token) is not _RootArchiveObservation or token not in _observations:_fail('ARCHIVE_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,original_runtime,original_toolkit,_original_profile=_observations[token]
    if (report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile)
            or report_sha256(runtime_manifest)!=report_sha256(original_runtime)
            or report_sha256(toolkit_manifest)!=report_sha256(original_toolkit)):_fail('ARCHIVE_COLLECTOR_OBSERVATION_CHANGED')
    p,root=_context(profile,qualification_request);_closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    pins=_json(token.pins_json.encode());_pins(pins)
    evidence=_json(token.evidence_json.encode());queries=_json(token.queries_json.encode())
    page_count=(evidence['issue_inventory']['comments']+99)//100+1
    endpoint='repos/'+p.binding.repository+'/issues/'+str(pins['issue_number'])
    gh=next(t for t in p.tools if t.role=='gh')
    paths=['user',endpoint]+[endpoint+'/comments?per_page=100&page='+str(i) for _ in range(2) for i in range(1,page_count+1)]+[endpoint]
    argv=[[gh.path,'--version'],[gh.path,'api','--hostname','github.com','graphql','--input','-'],
        *[[gh.path,'api','--hostname','github.com','--method','GET',path] for path in paths]]
    if type(queries) is not list or len(queries)!=len(argv):_fail('ARCHIVE_COLLECTOR_OBSERVATION_CHANGED')
    graphql=encode_report({'query':_query(1),'variables':{'owner':p.binding.repository.split('/')[0],
        'name':p.binding.repository.split('/')[1],'n0':pins['issue_number']}})
    outputs=[]
    for index,(query,args) in enumerate(zip(queries,argv)):
        input_bytes,output=_query_bytes(query)
        if query['argv']!=args or input_bytes!=(graphql if index==1 else b''):_fail('ARCHIVE_COLLECTOR_OBSERVATION_CHANGED')
        outputs.append(output)
    if outputs[0].decode('utf-8',errors='strict').splitlines()[0]!=gh.version:_fail('ARCHIVE_COLLECTOR_OBSERVATION_CHANGED')
    rest=_issue(p,pins,outputs[3]);_compare_lookup(p,pins,evidence['lookup_issue'],rest)
    first=outputs[4:4+page_count];second=outputs[4+page_count:4+2*page_count]
    capture=_authenticated(compare_archive_responses(p,pins,outputs[2],outputs[3],first,second,outputs[-1]))
    if (capture!=_json(token.capture_json.encode()) or evidence['issue_inventory']!=rest
            or evidence['comment_inventory']!=_comments(p,rest,first)):_fail('ARCHIVE_COLLECTOR_OBSERVATION_CHANGED')
    return {'schema':'RBRIDGE_ROOT_ARCHIVE_OBSERVATION_V1','scope':'ROOT_AUTHENTICATED_ARCHIVE_BYTES',
        'status':'PASS','capture':capture,'pins':pins,'evidence':evidence,'queries':queries,
        'reader_semantics':'NOT_PERFORMED','may_execute':False,'service_action_authorized':False}


def verify_root_archive_for_reader_profile(profile,token,runtime_manifest,toolkit_manifest,qualification_request):
    if type(token) is not _RootArchiveObservation or token not in _observations:_fail('ARCHIVE_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,_runtime,_toolkit,original_profile=_observations[token]
    if report_sha256(token)!=pin:_fail('ARCHIVE_COLLECTOR_OBSERVATION_CHANGED')
    original,target=assert_reader_profile_extension(original_profile,profile)
    observed=verify_root_archive_observation(original,token,runtime_manifest,toolkit_manifest,qualification_request)
    p,root=_context(target,qualification_request);_closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    return {**observed,'original_profile_sha256':report_sha256(original),'reader_profile_sha256':report_sha256(target)}
