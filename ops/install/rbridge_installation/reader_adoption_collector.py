"""Authenticate owner adoption of the exact genuinely invoked named readers.

The owner receipt is a declaration of workflow adoption and deployment consumer
inventory. It is not independent discovery of unindexed clients or observation
of an external workflow run. Full protected reader invocation and original case
origins are required separately; no serialized adoption or scope mints authority.
"""
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sys
import weakref
from .artifact_collector import _closure
from .github_lookup import QualifiedGitHubReadBackend,lookup_issues,_query
from .host_backend import _assert_kernel_namespace
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile
from .qualification import _readers,verify_import_closure
from .reader_collector import verify_root_reader_observation
from .readonly_helper import _json


class ReaderAdoptionError(InstallationError):pass
def _fail(reason):raise ReaderAdoptionError(reason)


def compare_reader_adoption(profile,registry,report,fixtures,capture):
    """Bounded complete data comparison; authentication requires the collector."""
    if len(encode_report({'registry':registry,'report':report,'fixtures':fixtures,'capture':capture}))>profile.budget.carrier_bytes:
        _fail('READER_ADOPTION_BYTE_LIMIT')
    _readers(profile,{'registry':registry,'report':report})
    fields={'schema','repository','viewer','author','issue_number','is_pull_request','url','body'}
    if (type(capture) is not dict or set(capture)!=fields or capture['schema']!='RBRIDGE_READER_ADOPTION_CAPTURE_V1'
            or capture['repository']!=profile.binding.repository or capture['viewer']!=profile.binding.author
            or capture['author']!=profile.binding.author or type(capture['issue_number']) is not int
            or not 1<=capture['issue_number']<=2147483647 or capture['is_pull_request'] is not False
            or capture['url']!='https://github.com/'+profile.binding.repository+'/issues/'+str(capture['issue_number'])
            or type(capture['body']) is not str):_fail('READER_ADOPTION_CAPTURE_INVALID')
    raw=capture['body'].encode('utf-8',errors='strict')
    if not 1<=len(raw)<=65536:_fail('READER_ADOPTION_RECEIPT_BYTE_LIMIT')
    receipt=_json(raw,65536)
    fields={'schema','decision','profile_sha256','registry','report_sha256','fixture_set_sha256','consumer_inventory'}
    if (type(receipt) is not dict or set(receipt)!=fields or receipt['schema']!='RBRIDGE_OWNER_READER_ADOPTION_RECEIPT_V1'
            or receipt['decision']!='ADOPTED_FOR_P2A_ACCEPTANCE' or receipt['profile_sha256']!=report_sha256(profile)
            or encode_report(receipt['registry'])!=encode_report(registry) or receipt['report_sha256']!=report_sha256(report)
            or receipt['fixture_set_sha256']!=report_sha256(fixtures)
            or receipt['consumer_inventory']!='OWNER_DECLARED_COMPLETE_FOR_THIS_DEPLOYMENT'):_fail('READER_ADOPTION_RECEIPT_CHANGED')
    if any(a['fixture_set_sha256']!=receipt['fixture_set_sha256'] for a in registry['adoptions']):
        _fail('READER_ADOPTION_FIXTURE_SET_CHANGED')
    return {'schema':'RBRIDGE_READER_ADOPTION_COMPARISON_V1','scope':'READER_ADOPTION_DATA_ONLY','status':'PASS',
        'capture':capture,'receipt':receipt,'physical_origin':'UNQUALIFIED','may_execute':False}


@dataclass(frozen=True,eq=False)
class _RootReaderAdoptionObservation:
    profile_sha256:str
    reader_sha256:str
    evidence_json:str
    queries_json:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/reader_adoption_collector.py'):
        _fail('READER_ADOPTION_ROOT_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();verify_import_closure(root,p,request);return p,root


def _reader(profile,reader,request):
    observed=verify_root_reader_observation(profile,reader,request)
    if (observed['status']!='PASS' or observed['non_archive_fixture_origin']!='ROOT_PROTECTED_CORE_AND_MCP_FIXTURE_PRODUCERS'
            or observed['may_execute'] is not False or observed['service_action_authorized'] is not False):
        _fail('READER_ADOPTION_ACTUAL_INVOCATION_INCOMPLETE')
    return observed


def _stable_issue(issue):
    return {k:getattr(issue,k) for k in ('number','state','title','body','author','url','isPullRequest','updatedAt')}


def _queries(profile,queries,issue_number):
    # The backend probes its version once, then each lookup performs one fixed
    # GraphQL query containing the viewer and the original issue together.
    if type(queries) is not list or len(queries)!=3:_fail('READER_ADOPTION_QUERY_EVIDENCE_INCOMPLETE')
    gh=next(t for t in profile.tools if t.role=='gh');owner,name=profile.binding.repository.split('/')
    expected=encode_report({'query':_query(1),'variables':{'owner':owner,'name':name,'n0':issue_number}})
    for index,query in enumerate(queries):
        session=query['session']
        parts={}
        for key,digest in (('input_base64','input_sha256'),('output_base64','output_sha256')):
            raw=base64.b64decode(query[key],validate=True)
            if len(raw)>profile.budget.carrier_bytes or base64.b64encode(raw).decode()!=query[key] or hashlib.sha256(raw).hexdigest()!=session[digest]:
                _fail('READER_ADOPTION_QUERY_EVIDENCE_CHANGED')
            parts[key]=raw
        argv=[gh.path,'--version'] if index==0 else [gh.path,'api','--hostname','github.com','graphql','--input','-']
        if query['argv']!=argv or parts['input_base64']!=(b'' if index==0 else expected):
            _fail('READER_ADOPTION_FIXED_QUERY_CHANGED')
        if index==0 and (not parts['output_base64'] or len(parts['output_base64'])>16384
                or parts['output_base64'].decode('utf-8',errors='strict').splitlines()[0]!=gh.version):
            _fail('READER_ADOPTION_TOOL_VERSION_CHANGED')
        if (session['scope']!='ROOT_FIXED_PROCESS_OBSERVATION' or session['status']!='PASS'
                or type(session['exit_code']) is not int or session['exit_code']!=0 or session['live_helpers']!=[]
                or session['argv']!=query['argv']):_fail('READER_ADOPTION_QUERY_EVIDENCE_CHANGED')


def collect_root_reader_adoption(profile,runtime_manifest,toolkit_manifest,reader_observation,issue_number,qualification_request):
    p,root=_context(profile,qualification_request)
    if type(issue_number) is not int or not 1<=issue_number<=2147483647:_fail('READER_ADOPTION_ISSUE_INVALID')
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    actual=_reader(p,reader_observation,qualification_request)
    backend=QualifiedGitHubReadBackend(p,retain_queries=True);lookups=[]
    for _index in range(2):
        issues=lookup_issues(p,[issue_number],backend)
        if len(issues)!=1 or backend.capture_status!='PASS' or backend.profile_sha256!=report_sha256(p):
            _fail('READER_ADOPTION_AUTHENTICATED_CAPTURE_INCOMPLETE')
        lookups.append({'issue':_stable_issue(issues[0]),'capture_sha256':backend.capture_sha256,
            'rate_observations':backend.rate_observations,'rate_sha256':backend.rate_sha256})
    if encode_report(lookups[0]['issue'])!=encode_report(lookups[1]['issue']):_fail('READER_ADOPTION_ISSUE_CHANGED')
    issue=lookups[0]['issue'];capture={'schema':'RBRIDGE_READER_ADOPTION_CAPTURE_V1','repository':p.binding.repository,
        'viewer':p.binding.author,'author':issue['author'],'issue_number':issue['number'],'is_pull_request':issue['isPullRequest'],
        'url':issue['url'],'body':issue['body']}
    comparison=compare_reader_adoption(p,actual['readers']['registry'],actual['readers']['report'],actual['input']['fixtures'],capture)
    if encode_report(_reader(p,reader_observation,qualification_request))!=encode_report(actual):_fail('READER_ADOPTION_READER_CHANGED')
    _queries(p,backend.query_evidence,issue_number);assert_owned_helpers_settled()
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    evidence={'schema':'RBRIDGE_ROOT_READER_ADOPTION_EVIDENCE_V1','comparison':comparison,'lookups':lookups,
        'reader_report_sha256':report_sha256(actual['readers']['report']),'fixture_set_sha256':report_sha256(actual['input']['fixtures'])}
    token=_RootReaderAdoptionObservation(report_sha256(p),report_sha256(reader_observation),encode_report(evidence).decode(),
        encode_report(backend.query_evidence).decode())
    if len(encode_report(token))>p.budget.carrier_bytes:_fail('READER_ADOPTION_EVIDENCE_BYTE_LIMIT')
    _observations[token]=(report_sha256(token),reader_observation,runtime_manifest,toolkit_manifest,p)
    return token


def verify_root_reader_adoption_observation(profile,token,qualification_request,*,reader_observation=None):
    if type(token) is not _RootReaderAdoptionObservation or token not in _observations:_fail('READER_ADOPTION_ORIGIN_UNQUALIFIED')
    pin,original,runtime_manifest,toolkit_manifest,original_profile=_observations[token]
    if (report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile)
            or report_sha256(original_profile)!=token.profile_sha256 or report_sha256(original)!=token.reader_sha256):
        _fail('READER_ADOPTION_OBSERVATION_CHANGED')
    if reader_observation is not None and reader_observation is not original:_fail('READER_ADOPTION_READER_ORIGIN_CHANGED')
    p,root=_context(profile,qualification_request);_closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    actual=_reader(p,original,qualification_request);evidence=_json(token.evidence_json.encode(),p.budget.carrier_bytes)
    queries=_json(token.queries_json.encode(),p.budget.carrier_bytes)
    _queries(p,queries,evidence['comparison']['capture']['issue_number'])
    before,after=evidence['lookups']
    if encode_report(before['issue'])!=encode_report(after['issue']):_fail('READER_ADOPTION_ISSUE_CHANGED')
    comparison=compare_reader_adoption(p,actual['readers']['registry'],actual['readers']['report'],actual['input']['fixtures'],evidence['comparison']['capture'])
    if (encode_report(comparison)!=encode_report(evidence['comparison'])
            or evidence['reader_report_sha256']!=report_sha256(actual['readers']['report'])
            or evidence['fixture_set_sha256']!=report_sha256(actual['input']['fixtures'])):_fail('READER_ADOPTION_OBSERVATION_CHANGED')
    assert_owned_helpers_settled()
    return {'schema':'RBRIDGE_ROOT_READER_ADOPTION_OBSERVATION_V1','scope':'ROOT_AUTHENTICATED_OWNER_READER_ADOPTION',
        'status':'PASS','profile_sha256':token.profile_sha256,'reader_sha256':token.reader_sha256,
        'evidence':evidence,'queries':queries,'reader_invocation_origin':'ROOT_INSTALLED_READER_INVOCATIONS',
        'workflow_adoption_origin':'AUTHENTICATED_OWNER_DECLARATION','external_workflow_execution':'NOT_OBSERVED',
        'inventory_origin':'OWNER_DECLARATION_NOT_INDEPENDENT_DISCOVERY','may_execute':False,'service_action_authorized':False}
