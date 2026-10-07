"""Authenticate exact owner review of complete material, never a service switch.

The owner reviews the full material digest and every preparation pin. A pure
receipt comparison is data only; Root collection additionally requires the
original private material observation and two identical authenticated captures.
The historical review can be preserved after our own switch without repeating
the fixture's original production baseline.
"""
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sys
import weakref
from .artifact_collector import _closure
from .copy_ledger_collector import _context as _root_context
from .github_lookup import QualifiedGitHubReadBackend,lookup_issues
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile,assert_reader_profile_extension
from .qualification_collector import verify_root_qualification_material,preserve_root_qualification_material
from .reader_adoption_collector import _queries,_stable_issue
from .readonly_helper import _json


class MaterialReviewError(InstallationError):pass
def _fail(reason):raise MaterialReviewError(reason)


def _hash(value,length=64):return type(value) is str and re.fullmatch('[0-9a-f]{'+str(length)+'}',value) is not None


def material_review_pins(profile,material):
    """Pure full-preimage pins only; no supplied scope authenticates its caller."""
    p=parse_profile(json.loads(encode_report(profile)))
    if len(encode_report(material))>p.budget.carrier_bytes:_fail('MATERIAL_REVIEW_BYTE_LIMIT')
    if (type(material) is not dict or set(material)!={'schema','scope','status','profile_sha256','base_profile_sha256',
            'evidence_sha256','evidence','installation_authority','may_execute','service_action_authorized'}
            or material['schema']!='RBRIDGE_ROOT_QUALIFICATION_MATERIAL_V1'
            or material['scope'] not in ('ROOT_COMPLETE_QUALIFICATION_MATERIAL','ROOT_PRESERVED_QUALIFICATION_MATERIAL')
            or material['status']!='PASS' or material['installation_authority'] is not False or material['may_execute'] is not False
            or material['service_action_authorized'] is not False or material['profile_sha256']!=report_sha256(p)
            or material['evidence_sha256']!=report_sha256(material['evidence'])):_fail('MATERIAL_REVIEW_MATERIAL_CHANGED')
    value=material['evidence'];base=parse_profile(json.loads(encode_report(value['base_profile'])))
    assert_reader_profile_extension(base,p)
    if (material['base_profile_sha256']!=report_sha256(base) or encode_report(value['profile'])!=encode_report(p)
            or value['runtime_manifest']['sha256']!=p.runtime.manifest_sha256
            or value['toolkit_manifest']['sha256']!=p.toolkit.manifest_sha256
            or value['owner_review']!='NOT_COLLECTED' or value['installation_authority'] is not False
            or value['service_action_authorized'] is not False):_fail('MATERIAL_REVIEW_MATERIAL_CHANGED')
    source=value['observations']['source_ci']['source'];locator=value['source_ci_locator']
    if (source['commit']!=p.toolkit.source_sha or source['tree']!=p.toolkit.tree_sha
            or set(locator)!={'run_id','job_id'} or any(type(v) is not int or not 1<=v<=9007199254740991 for v in locator.values())
            or type(source['run_id']) is not int or source['run_id']!=locator['run_id']):_fail('MATERIAL_REVIEW_SOURCE_CHANGED')
    bootstrap=value['observations']['bootstrap']['manifest']
    pins={'profile_sha256':report_sha256(p),'base_profile_sha256':report_sha256(base),
        'runtime_manifest_sha256':p.runtime.manifest_sha256,'toolkit_manifest_sha256':p.toolkit.manifest_sha256,
        'source_commit':p.toolkit.source_sha,'source_tree':p.toolkit.tree_sha,
        'source_ci_run_id':locator['run_id'],'source_ci_job_id':locator['job_id'],'source_log_sha256':source['log_sha256'],
        'readers_sha256':value['readers_sha256'],'reader_context_sha256':value['reader_context_sha256'],
        'helper_sha256':value['helper_sha256'],'canary_sha256':p.service.canary_sha256,
        'python_closure_sha256':bootstrap['python_closure_sha256'],'bootstrap_manifest_sha256':report_sha256(bootstrap),
        'bootstrap_payload_sha256':bootstrap['payload_sha256'],'material_evidence_sha256':material['evidence_sha256']}
    for key,value in pins.items():
        if key not in ('source_ci_run_id','source_ci_job_id') and not _hash(value,40 if key in ('source_commit','source_tree') else 64):
            _fail('MATERIAL_REVIEW_PIN_INVALID')
    return pins


def compare_material_review(profile,material,capture):
    p=parse_profile(json.loads(encode_report(profile)));pins=material_review_pins(p,material)
    if (type(capture) is not dict or set(capture)!={'schema','repository','viewer','author','issue_number','is_pull_request','url','body'}
            or capture['schema']!='RBRIDGE_MATERIAL_REVIEW_CAPTURE_V1' or capture['repository']!=p.binding.repository
            or capture['viewer']!=p.binding.author or capture['author']!=p.binding.author
            or type(capture['issue_number']) is not int or not 1<=capture['issue_number']<=2147483647
            or capture['is_pull_request'] is not False
            or capture['url']!='https://github.com/'+p.binding.repository+'/issues/'+str(capture['issue_number'])
            or type(capture['body']) is not str):_fail('MATERIAL_REVIEW_IDENTITY_INVALID')
    body=_json(capture['body'].encode('utf-8',errors='strict'),65536)
    if (type(body) is not dict or set(body)!={'schema','decision','scope','pins','switch_authorized'}
            or body['schema']!='RBRIDGE_OWNER_INSTALLATION_MATERIAL_REVIEW_V1' or body['decision']!='APPROVED_FOR_P2A_PREPARATION'
            or body['scope']!='REVIEWED_QUALIFICATION_MATERIAL_ONLY' or body['switch_authorized'] is not False
            or encode_report(body['pins'])!=encode_report(pins)):_fail('MATERIAL_REVIEW_RECEIPT_CHANGED')
    return {'schema':'RBRIDGE_MATERIAL_REVIEW_COMPARISON_V1','scope':'MATERIAL_REVIEW_DATA_ONLY','status':'PASS',
        'capture':capture,'receipt':body,'physical_origin':'UNQUALIFIED','may_execute':False,'service_action_authorized':False}


@dataclass(frozen=True,eq=False)
class _RootMaterialReviewObservation:
    profile_sha256:str
    material_sha256:str
    evidence_json:str
    queries_json:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/material_review_collector.py'):
        _fail('MATERIAL_REVIEW_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def collect_root_material_review(profile,runtime_manifest,toolkit_manifest,material_observation,issue_number,qualification_request):
    p,root=_context(profile,qualification_request)
    if type(issue_number) is not int or not 1<=issue_number<=2147483647:_fail('MATERIAL_REVIEW_ISSUE_INVALID')
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    original=verify_root_qualification_material(p,material_observation,qualification_request)
    backend=QualifiedGitHubReadBackend(p,retain_queries=True);lookups=[]
    for _index in range(2):
        issues=lookup_issues(p,[issue_number],backend)
        if len(issues)!=1 or backend.capture_status!='PASS' or backend.profile_sha256!=report_sha256(p):
            _fail('MATERIAL_REVIEW_CAPTURE_INCOMPLETE')
        lookups.append({'issue':_stable_issue(issues[0]),'capture_sha256':backend.capture_sha256,
            'rate_observations':backend.rate_observations,'rate_sha256':backend.rate_sha256})
    if encode_report(lookups[0]['issue'])!=encode_report(lookups[1]['issue']):_fail('MATERIAL_REVIEW_ISSUE_CHANGED')
    issue=lookups[0]['issue'];capture={'schema':'RBRIDGE_MATERIAL_REVIEW_CAPTURE_V1','repository':p.binding.repository,
        'viewer':p.binding.author,'author':issue['author'],'issue_number':issue['number'],'is_pull_request':issue['isPullRequest'],
        'url':issue['url'],'body':issue['body']}
    comparison=compare_material_review(p,original,capture)
    after=verify_root_qualification_material(p,material_observation,qualification_request)
    if encode_report(after)!=encode_report(original):_fail('MATERIAL_REVIEW_MATERIAL_CHANGED')
    _queries(p,backend.query_evidence,issue_number);assert_owned_helpers_settled()
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    evidence={'schema':'RBRIDGE_ROOT_MATERIAL_REVIEW_EVIDENCE_V1','comparison':comparison,'lookups':lookups,
        'material_evidence_sha256':original['evidence_sha256']}
    token=_RootMaterialReviewObservation(report_sha256(p),report_sha256(material_observation),encode_report(evidence).decode(),
        encode_report(backend.query_evidence).decode())
    if len(encode_report(token))>p.budget.carrier_bytes:_fail('MATERIAL_REVIEW_EVIDENCE_BYTE_LIMIT')
    _observations[token]=(report_sha256(token),material_observation,runtime_manifest,toolkit_manifest,p,encode_report(qualification_request).decode())
    return token


def _registered(profile,token,request,material_observation=None):
    if type(token) is not _RootMaterialReviewObservation or token not in _observations:_fail('MATERIAL_REVIEW_ORIGIN_UNQUALIFIED')
    pin,original,runtime_manifest,toolkit_manifest,p,request_json=_observations[token]
    if (report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile) or token.profile_sha256!=report_sha256(p)
            or token.material_sha256!=report_sha256(original) or encode_report(request).decode()!=request_json):
        _fail('MATERIAL_REVIEW_OBSERVATION_CHANGED')
    if material_observation is not None and material_observation is not original:_fail('MATERIAL_REVIEW_MATERIAL_ORIGIN_CHANGED')
    return original,runtime_manifest,toolkit_manifest,p


def _verify(profile,token,request,material_observation,preserve):
    original,runtime_manifest,toolkit_manifest,p=_registered(profile,token,request,material_observation)
    p,root=_context(p,request);_closure(p,root,runtime_manifest,toolkit_manifest,request)
    actual=(preserve_root_qualification_material if preserve else verify_root_qualification_material)(p,original,request)
    evidence=_json(token.evidence_json.encode(),p.budget.carrier_bytes);queries=_json(token.queries_json.encode(),p.budget.carrier_bytes)
    if (type(evidence) is not dict or set(evidence)!={'schema','comparison','lookups','material_evidence_sha256'}
            or evidence['schema']!='RBRIDGE_ROOT_MATERIAL_REVIEW_EVIDENCE_V1' or type(evidence['lookups']) is not list
            or len(evidence['lookups'])!=2):_fail('MATERIAL_REVIEW_OBSERVATION_CHANGED')
    before,after=evidence['lookups']
    if encode_report(before['issue'])!=encode_report(after['issue']):_fail('MATERIAL_REVIEW_ISSUE_CHANGED')
    capture=evidence['comparison']['capture'];_queries(p,queries,capture['issue_number'])
    comparison=compare_material_review(p,actual,capture)
    if encode_report(comparison)!=encode_report(evidence['comparison']) or evidence['material_evidence_sha256']!=actual['evidence_sha256']:
        _fail('MATERIAL_REVIEW_OBSERVATION_CHANGED')
    _registered(profile,token,request,material_observation);assert_owned_helpers_settled()
    return {'schema':'RBRIDGE_ROOT_MATERIAL_REVIEW_OBSERVATION_V1','scope':'ROOT_AUTHENTICATED_OWNER_MATERIAL_REVIEW',
        'status':'PASS','profile_sha256':token.profile_sha256,'material_sha256':token.material_sha256,
        'evidence':evidence,'queries':queries,'review_scope':'PREPARATION_ONLY',
        'may_execute':False,'service_action_authorized':False}


def verify_root_material_review(profile,token,qualification_request,*,material_observation=None):
    return _verify(profile,token,qualification_request,material_observation,False)


def preserve_root_material_review(profile,token,qualification_request,*,material_observation=None):
    return _verify(profile,token,qualification_request,material_observation,True)
