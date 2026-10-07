"""Issue only the exact authenticated owner-reviewed preparation command.

The original bundle, authenticated production publication, actual cold custody
and two identical owner Issue captures are mandatory. All original bytes and
query preimages remain private evidence. An issued command performs preparation
only; its review grants no production switch permission.
"""
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys
import weakref
from .bootstrap_publication_collector import verify_root_bootstrap_publication
from .copy_ledger_collector import _context as _root_context
from .github_lookup import QualifiedGitHubReadBackend,lookup_issues
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile
from .qualification import _bundle_pin,verify_qualification_bundle
from .qualification_custody import open_root_qualification_custody
from .reader_adoption_collector import _queries,_stable_issue
from .readonly_helper import _json


class OwnerCommandError(InstallationError):pass
def _fail(reason):raise OwnerCommandError(reason)
def _hash(value):return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None


PIN_FIELDS={'profile_sha256','bundle_pin','material_evidence_sha256','publication_evidence_sha256',
    'runtime_manifest_sha256','toolkit_manifest_sha256','readers_sha256','helper_sha256',
    'python_closure_sha256','payload_sha256','command_sha256','custody_locator_sha256'}


def compare_owner_command_review(profile,command_bytes,pins,capture):
    """Strict pure data comparison; no caller-provided bytes create an origin."""
    p=parse_profile(json.loads(encode_report(profile)))
    if (type(command_bytes) is not bytes or not 0<len(command_bytes)<=49152
            or type(pins) is not dict or set(pins)!=PIN_FIELDS or any(not _hash(v) for v in pins.values())
            or pins['profile_sha256']!=report_sha256(p) or pins['runtime_manifest_sha256']!=p.runtime.manifest_sha256
            or pins['toolkit_manifest_sha256']!=p.toolkit.manifest_sha256
            or pins['command_sha256']!=hashlib.sha256(command_bytes).hexdigest()):
        _fail('OWNER_COMMAND_REVIEW_PINS_INVALID')
    try:command_bytes.decode('utf-8',errors='strict')
    except UnicodeError:_fail('OWNER_COMMAND_REVIEW_BYTES_INVALID')
    if (type(capture) is not dict or set(capture)!={'schema','repository','viewer','author','issue_number','is_pull_request','url','body'}
            or capture['schema']!='RBRIDGE_OWNER_COMMAND_REVIEW_CAPTURE_V1' or capture['repository']!=p.binding.repository
            or capture['viewer']!=p.binding.author or capture['author']!=p.binding.author
            or type(capture['issue_number']) is not int or not 1<=capture['issue_number']<=2147483647
            or capture['is_pull_request'] is not False
            or capture['url']!='https://github.com/'+p.binding.repository+'/issues/'+str(capture['issue_number'])
            or type(capture['body']) is not str):_fail('OWNER_COMMAND_REVIEW_IDENTITY_INVALID')
    body=_json(capture['body'].encode('utf-8',errors='strict'),65536)
    if (type(body) is not dict or set(body)!={'schema','decision','scope','pins','command_base64','switch_authorized'}
            or body['schema']!='RBRIDGE_OWNER_PREPARATION_COMMAND_REVIEW_V1' or body['decision']!='APPROVED_P2A_PREPARATION_COMMAND'
            or body['scope']!='REVIEWED_PREPARATION_COMMAND_ONLY' or body['switch_authorized'] is not False
            or encode_report(body['pins'])!=encode_report(pins) or type(body['command_base64']) is not str):
        _fail('OWNER_COMMAND_REVIEW_RECEIPT_CHANGED')
    if body['command_base64']!=base64.b64encode(command_bytes).decode():_fail('OWNER_COMMAND_REVIEW_BYTES_CHANGED')
    return {'schema':'RBRIDGE_OWNER_COMMAND_REVIEW_COMPARISON_V1','status':'PASS','scope':'OWNER_COMMAND_REVIEW_DATA_ONLY',
        'capture':capture,'receipt':body,'physical_origin':'UNQUALIFIED','may_execute':False,'service_action_authorized':False}


@dataclass(frozen=True,eq=False)
class _RootOwnerCommandReviewObservation:
    profile_sha256:str
    bundle_pin:str
    publication_sha256:str
    evidence_json:str
    queries_json:str


_observations=weakref.WeakKeyDictionary()
_commands=weakref.WeakKeyDictionary()


def _context(p,request):
    root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/owner_command_collector.py'):
        _fail('OWNER_COMMAND_REVIEW_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _command_material(p,bundle,publication_observation,locator,request):
    verify_qualification_bundle(p,bundle)
    p,_root=_context(p,request)
    if 'ops/install/rbridge_installation/owner_command_collector.py' not in {e.path for e in bundle.toolkit_manifest.entries if e.kind=='FILE'}:
        _fail('OWNER_COMMAND_REVIEW_ENTRY_UNQUALIFIED')
    publication=verify_root_bootstrap_publication(p,publication_observation,request,bundle=bundle)
    # Metadata equality is used only after the distinct actual protected cold
    # factory has independently authenticated its key, full evidence and bytes.
    cold=open_root_qualification_custody(p,locator,request)
    if _bundle_pin(cold)!=_bundle_pin(bundle):_fail('OWNER_COMMAND_REVIEW_CUSTODY_CHANGED')
    body={'profile':json.loads(encode_report(p)),'qualification':{'python_closure_sha256':bundle.python_closure_sha256,'custody':locator}}
    input_bytes=encode_report(body);delimiter='RBRIDGE_INSTALL_INPUT_'+hashlib.sha256(input_bytes).hexdigest()
    path=publication['evidence']['publication']['path']
    argv=['/usr/bin/sudo','-H','--','/usr/bin/env','-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin','HOME=/root','LC_ALL=C',
        p.toolkit.python_path,'-I','-S','-B',path,'prepare']
    # The quoted heredoc does not expand the reviewed JSON. The subshell keeps
    # the parent's cwd and lifetime; its observed sudo/child status is retained.
    command=('set +e\nset +u\nset +E\nset +o pipefail\n(\ncd / || exit 2\n'+shlex.join(argv)+" <<'"+delimiter+"'\n"+
        input_bytes.decode()+'\n'+delimiter+'\n)\nrbridge_bootstrap_outer_exit=$?\n'+
        'printf "RBRIDGE_OUTER_EXIT=%s\\n" "$rbridge_bootstrap_outer_exit"\n(exit "$rbridge_bootstrap_outer_exit")\n')
    raw=command.encode('utf-8')
    if len(raw)>49152:_fail('OWNER_COMMAND_REVIEW_BYTE_LIMIT')
    pins={'profile_sha256':report_sha256(p),'bundle_pin':_bundle_pin(bundle),'material_evidence_sha256':bundle.evidence_sha256,
        'publication_evidence_sha256':publication['evidence_sha256'],'runtime_manifest_sha256':bundle.runtime_manifest.sha256,
        'toolkit_manifest_sha256':bundle.toolkit_manifest.sha256,'readers_sha256':bundle.readers_sha256,
        'helper_sha256':bundle.helper_sha256,'python_closure_sha256':bundle.python_closure_sha256,
        'payload_sha256':publication['evidence']['publication']['payload_sha256'],
        'command_sha256':hashlib.sha256(raw).hexdigest(),'custody_locator_sha256':report_sha256(locator)}
    return raw,pins


def stage_root_owner_command_review(profile,bundle,publication_observation,custody_locator,qualification_request):
    """Reviewable proposal after genuine qualification, never issued authority."""
    p=parse_profile(json.loads(encode_report(profile)))
    raw,pins=_command_material(p,bundle,publication_observation,custody_locator,qualification_request)
    body={'schema':'RBRIDGE_OWNER_PREPARATION_COMMAND_REVIEW_V1','decision':'AWAITING_OWNER_REVIEW',
        'scope':'REVIEWED_PREPARATION_COMMAND_ONLY','pins':pins,'command_base64':base64.b64encode(raw).decode(),
        'switch_authorized':False}
    if len(encode_report(body))>65536:_fail('OWNER_COMMAND_REVIEW_BYTE_LIMIT')
    return {'schema':'RBRIDGE_ROOT_OWNER_COMMAND_REVIEW_PROPOSAL_V1','status':'REVIEW_REQUIRED',
        'scope':'QUALIFIED_PREPARATION_REVIEW_PROPOSAL_ONLY','profile_sha256':report_sha256(p),'pins':pins,
        'command_base64':body['command_base64'],'review_body':body,'command_issued':False,
        'may_execute':False,'production_switch_authorized':False,'service_action_authorized':False}


def collect_root_owner_command_review(profile,bundle,publication_observation,custody_locator,issue_number,qualification_request):
    p=parse_profile(json.loads(encode_report(profile)))
    raw,pins=_command_material(p,bundle,publication_observation,custody_locator,qualification_request)
    if type(issue_number) is not int or not 1<=issue_number<=2147483647:_fail('OWNER_COMMAND_REVIEW_ISSUE_INVALID')
    backend=QualifiedGitHubReadBackend(p,retain_queries=True);lookups=[]
    for _index in range(2):
        issues=lookup_issues(p,[issue_number],backend)
        if len(issues)!=1 or backend.capture_status!='PASS' or backend.profile_sha256!=report_sha256(p):
            _fail('OWNER_COMMAND_REVIEW_CAPTURE_INCOMPLETE')
        lookups.append({'issue':_stable_issue(issues[0]),'capture_sha256':backend.capture_sha256,
            'rate_observations':backend.rate_observations,'rate_sha256':backend.rate_sha256})
    if encode_report(lookups[0]['issue'])!=encode_report(lookups[1]['issue']):_fail('OWNER_COMMAND_REVIEW_ISSUE_CHANGED')
    issue=lookups[0]['issue'];capture={'schema':'RBRIDGE_OWNER_COMMAND_REVIEW_CAPTURE_V1','repository':p.binding.repository,
        'viewer':p.binding.author,'author':issue['author'],'issue_number':issue['number'],'is_pull_request':issue['isPullRequest'],
        'url':issue['url'],'body':issue['body']}
    comparison=compare_owner_command_review(p,raw,pins,capture)
    after,after_pins=_command_material(p,bundle,publication_observation,custody_locator,qualification_request)
    if after!=raw or encode_report(after_pins)!=encode_report(pins):_fail('OWNER_COMMAND_REVIEW_MATERIAL_CHANGED')
    _queries(p,backend.query_evidence,issue_number);assert_owned_helpers_settled()
    evidence={'schema':'RBRIDGE_ROOT_OWNER_COMMAND_REVIEW_EVIDENCE_V1','comparison':comparison,'lookups':lookups,'pins':pins,
        'command_base64':base64.b64encode(raw).decode()}
    token=_RootOwnerCommandReviewObservation(report_sha256(p),_bundle_pin(bundle),report_sha256(publication_observation),
        encode_report(evidence).decode(),encode_report(backend.query_evidence).decode())
    if len(encode_report(token))>p.budget.carrier_bytes:_fail('OWNER_COMMAND_REVIEW_EVIDENCE_BYTE_LIMIT')
    _observations[token]=(report_sha256(token),bundle,publication_observation,p,encode_report(qualification_request).decode(),
        encode_report(custody_locator).decode(),raw.decode())
    try:verify_root_owner_command_review(p,token,qualification_request,bundle=bundle,publication_observation=publication_observation)
    except BaseException:_observations.pop(token,None);raise
    _commands[bundle]=token
    return token


def _registered(profile,token,request,bundle=None,publication_observation=None):
    if type(token) is not _RootOwnerCommandReviewObservation or token not in _observations:_fail('OWNER_COMMAND_REVIEW_ORIGIN_UNQUALIFIED')
    pin,original,publication,p,request_json,locator_json,command=_observations[token]
    if (report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile) or token.profile_sha256!=report_sha256(p)
            or token.publication_sha256!=report_sha256(publication) or encode_report(request).decode()!=request_json):
        _fail('OWNER_COMMAND_REVIEW_OBSERVATION_CHANGED')
    if bundle is not None and bundle is not original:_fail('OWNER_COMMAND_REVIEW_BUNDLE_ORIGIN_CHANGED')
    if publication_observation is not None and publication_observation is not publication:_fail('OWNER_COMMAND_REVIEW_PUBLICATION_ORIGIN_CHANGED')
    return original,publication,p,_json(locator_json.encode(),65536),command


def verify_root_owner_command_review(profile,token,qualification_request,*,bundle=None,publication_observation=None):
    original,publication,p,locator,command=_registered(profile,token,qualification_request,bundle,publication_observation)
    raw,pins=_command_material(p,original,publication,locator,qualification_request)
    if raw.decode()!=command or _bundle_pin(original)!=token.bundle_pin:_fail('OWNER_COMMAND_REVIEW_MATERIAL_CHANGED')
    evidence=_json(token.evidence_json.encode(),p.budget.carrier_bytes);queries=_json(token.queries_json.encode(),p.budget.carrier_bytes)
    if (type(evidence) is not dict or set(evidence)!={'schema','comparison','lookups','pins','command_base64'}
            or evidence['schema']!='RBRIDGE_ROOT_OWNER_COMMAND_REVIEW_EVIDENCE_V1'
            or type(evidence['lookups']) is not list or len(evidence['lookups'])!=2
            or encode_report(evidence['lookups'][0]['issue'])!=encode_report(evidence['lookups'][1]['issue'])
            or evidence['command_base64']!=base64.b64encode(raw).decode() or encode_report(evidence['pins'])!=encode_report(pins)):
        _fail('OWNER_COMMAND_REVIEW_OBSERVATION_CHANGED')
    capture=evidence['comparison']['capture'];_queries(p,queries,capture['issue_number'])
    comparison=compare_owner_command_review(p,raw,pins,capture)
    if encode_report(comparison)!=encode_report(evidence['comparison']):_fail('OWNER_COMMAND_REVIEW_OBSERVATION_CHANGED')
    _registered(profile,token,qualification_request,bundle,publication_observation);assert_owned_helpers_settled()
    return {'schema':'RBRIDGE_ROOT_OWNER_COMMAND_REVIEW_OBSERVATION_V1','status':'PASS','scope':'ROOT_REVIEWED_PREPARATION_COMMAND',
        'profile_sha256':token.profile_sha256,'bundle_pin':token.bundle_pin,'command_sha256':pins['command_sha256'],
        'command_base64':base64.b64encode(raw).decode(),'evidence':evidence,'queries':queries,
        'production_switch_authorized':False,'service_action_authorized':False}


def reviewed_owner_command(bundle):
    if bundle not in _commands:_fail('QUALIFICATION_REVIEWED_BOOTSTRAP_COMMAND_MISSING')
    token=_commands[bundle];row=_observations.get(token)
    if row is None:_fail('OWNER_COMMAND_REVIEW_ORIGIN_UNQUALIFIED')
    request=_json(row[4].encode(),65536)
    observed=verify_root_owner_command_review(bundle.profile,token,request,bundle=bundle)
    raw=base64.b64decode(observed['command_base64'],validate=True)
    if hashlib.sha256(raw).hexdigest()!=observed['command_sha256']:_fail('OWNER_COMMAND_REVIEW_BYTES_CHANGED')
    return raw.decode('utf-8',errors='strict')
