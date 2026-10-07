"""Exact owner command bytes require a genuine bundle and authenticated review.

Pure recipes and receipt comparisons are data only. Root review retains the
same bundle/bootstrap objects, complete query preimages and protected evidence.
Review never supplies production switch authorization.
"""
from dataclasses import dataclass
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys
import weakref
from .bootstrap_collector import _manifest,verify_root_bootstrap_observation
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .github_lookup import QualifiedGitHubReadBackend,lookup_issues
from .host_backend import _protected_bytes
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile
from .qualification import _bundle_pin,_bundle_authorization,verify_qualification_bundle
from .qualification_custody import _locator
from .reader_adoption_collector import _queries,_stable_issue
from .readonly_helper import _json
from .transaction import SwitchAuthorization


class OwnerCommandError(InstallationError):pass
def _fail(reason):raise OwnerCommandError(reason)


OPERATIONS=('prepare','check','apply','resume','status')
_observations=weakref.WeakKeyDictionary()
_commands=weakref.WeakKeyDictionary()


def _hash(value,length=64):return type(value) is str and re.fullmatch('[0-9a-f]{'+str(length)+'}',value) is not None
def _issue(value):return type(value) is int and 1<=value<=2147483647


def entry_input(value):
    return {k:v for k,v in value.items() if k in ('profile','qualification','authorization','transaction_id')}


def owner_command_recipe(profile,operation,value):
    """Canonical whole-byte review material; this function authenticates nobody."""
    p=parse_profile(json.loads(encode_report(profile)))
    required={'profile','qualification','bootstrap','command_review_issue'}
    if operation=='apply':required.add('authorization')
    elif operation in ('resume','status'):required.add('transaction_id')
    if (operation not in OPERATIONS or type(value) is not dict or set(value)!=required
            or encode_report(value['profile'])!=encode_report(p) or not _issue(value['command_review_issue'])):
        _fail('OWNER_COMMAND_INPUT_INVALID')
    q=value['qualification'];bootstrap=value['bootstrap']
    if (type(q) is not dict or set(q)!={'python_closure_sha256','custody'} or not _hash(q['python_closure_sha256'])
            or type(bootstrap) is not dict or set(bootstrap)!={'issue_number','manifest'}
            or not _issue(bootstrap['issue_number'])):_fail('OWNER_COMMAND_INPUT_INVALID')
    locator=_locator(p,q['custody']);request={'python_closure_sha256':q['python_closure_sha256']}
    if locator['request_sha256']!=report_sha256(request):_fail('OWNER_COMMAND_CUSTODY_REQUEST_CHANGED')
    manifest=bootstrap['manifest'];_manifest(manifest)
    if (manifest['source_sha']!=p.toolkit.source_sha or manifest['tree_sha']!=p.toolkit.tree_sha
            or manifest['toolkit_manifest_sha256']!=p.toolkit.manifest_sha256
            or manifest['python_closure_sha256']!=q['python_closure_sha256']):_fail('OWNER_COMMAND_BOOTSTRAP_CHANGED')
    if operation=='apply':
        auth=value['authorization']
        if (type(auth) is not dict or set(auth)!=set(SwitchAuthorization.__dataclass_fields__)
                or auth['purpose']!='OWNER_PRESENT_PRODUCTION_SWITCH' or auth['owner_present'] is not True
                or type(auth['transaction_id']) is not str or not _hash(auth['transaction_id'],32)
                or type(auth['expires_at']) is not str
                or auth['profile_sha256']!=report_sha256(p) or auth['runtime_manifest_sha256']!=p.runtime.manifest_sha256
                or auth['toolkit_manifest_sha256']!=p.toolkit.manifest_sha256
                or any(not _hash(auth[k]) for k in ('readers_sha256','helper_sha256'))):
            _fail('OWNER_COMMAND_SWITCH_AUTHORIZATION_MISSING')
    if operation in ('resume','status') and not _hash(value['transaction_id'],32):_fail('OWNER_COMMAND_TRANSACTION_ID_INVALID')
    raw=encode_report(value)
    if not 0<len(raw)<=p.budget.carrier_bytes:_fail('OWNER_COMMAND_INPUT_BYTE_LIMIT')
    path=p.paths.release_parent+'/toolkit-'+p.toolkit.source_sha+'/ops/install/rbridge_bootstrap.py'
    inner='cd / && exec '+shlex.join([p.toolkit.python_path,'-I','-S','-B',path,'--retrieve',operation])
    argv=['/usr/bin/sudo','-H','/usr/bin/env','-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin','HOME=/root','LC_ALL=C','/bin/sh','-c',inner]
    script=('set +e\nset +u\nset +E\nset +o pipefail\n'+shlex.join(argv)+" <<'RBRIDGE_REVIEWED_BOOTSTRAP_INPUT'\n"+
        raw.decode()+'\nRBRIDGE_REVIEWED_BOOTSTRAP_INPUT\nrbridge_bootstrap_outer_exit=$?\n'+
        'printf "RBRIDGE_OUTER_EXIT=%s\\n" "$rbridge_bootstrap_outer_exit"\n(exit "$rbridge_bootstrap_outer_exit")\n')
    pins={'profile_sha256':report_sha256(p),'runtime_manifest_sha256':p.runtime.manifest_sha256,
        'toolkit_manifest_sha256':p.toolkit.manifest_sha256,'source_commit':p.toolkit.source_sha,'source_tree':p.toolkit.tree_sha,
        'python_closure_sha256':q['python_closure_sha256'],'qualification_bundle_pin':locator['bundle_pin'],
        'qualification_evidence_sha256':locator['evidence_sha256'],'custody_locator_sha256':report_sha256(locator),
        'bootstrap_manifest_sha256':report_sha256(manifest),'bootstrap_payload_sha256':manifest['payload_sha256'],
        'bootstrap_issue_number':bootstrap['issue_number'],'command_review_issue_number':value['command_review_issue'],
        'operation':operation,'input_sha256':hashlib.sha256(raw).hexdigest(),
        'command_sha256':hashlib.sha256(script.encode()).hexdigest(),'command_bytes':len(script.encode())}
    return {'schema':'RBRIDGE_OWNER_COMMAND_RECIPE_V1','scope':'OWNER_COMMAND_RECIPE_DATA_ONLY','status':'PASS',
        'pins':pins,'input_json':raw.decode(),'script':script,'physical_origin':'UNQUALIFIED',
        'may_execute':False,'service_action_authorized':False}


def compare_owner_command_review(profile,operation,value,capture):
    p=parse_profile(json.loads(encode_report(profile)));recipe=owner_command_recipe(p,operation,value)
    if (type(capture) is not dict or set(capture)!={'schema','repository','viewer','author','issue_number','is_pull_request','url','body'}
            or capture['schema']!='RBRIDGE_OWNER_COMMAND_REVIEW_CAPTURE_V1' or capture['repository']!=p.binding.repository
            or capture['viewer']!=p.binding.author or capture['author']!=p.binding.author
            or not _issue(capture['issue_number']) or capture['issue_number']!=value['command_review_issue']
            or capture['is_pull_request'] is not False
            or capture['url']!='https://github.com/'+p.binding.repository+'/issues/'+str(capture['issue_number'])
            or type(capture['body']) is not str):_fail('OWNER_COMMAND_REVIEW_IDENTITY_INVALID')
    body=_json(capture['body'].encode('utf-8',errors='strict'),65536)
    if (type(body) is not dict or set(body)!={'schema','decision','scope','pins','switch_authorized'}
            or body['schema']!='RBRIDGE_OWNER_EXACT_COMMAND_REVIEW_V1' or body['decision']!='APPROVED_EXACT_COMMAND'
            or body['scope']!='REVIEWED_BOOTSTRAP_COMMAND_ONLY' or body['switch_authorized'] is not False
            or encode_report(body['pins'])!=encode_report(recipe['pins'])):_fail('OWNER_COMMAND_REVIEW_BYTES_CHANGED')
    return {'schema':'RBRIDGE_OWNER_COMMAND_REVIEW_COMPARISON_V1','scope':'OWNER_COMMAND_REVIEW_DATA_ONLY','status':'PASS',
        'capture':capture,'receipt':body,'physical_origin':'UNQUALIFIED','may_execute':False,'service_action_authorized':False}


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/owner_command.py'):
        _fail('OWNER_COMMAND_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _root_recipe(p,bundle,bootstrap,operation,value):
    recipe=owner_command_recipe(p,operation,value);q=value['qualification'];request={'python_closure_sha256':q['python_closure_sha256']}
    verify_qualification_bundle(p,bundle)
    if (bundle.python_closure_sha256!=request['python_closure_sha256'] or _bundle_pin(bundle)!=q['custody']['bundle_pin']
            or bundle.evidence_sha256!=q['custody']['evidence_sha256']):_fail('OWNER_COMMAND_BUNDLE_CHANGED')
    actual=verify_root_bootstrap_observation(p,bootstrap,bundle.runtime_manifest,bundle.toolkit_manifest,request)
    manifest=value['bootstrap']['manifest'];capture=actual['evidence']['capture']
    if (encode_report(actual['manifest'])!=encode_report(manifest)
            or capture['issue_number']!=value['bootstrap']['issue_number']):_fail('OWNER_COMMAND_BOOTSTRAP_CHANGED')
    payload=base64.b64decode(actual['payload_base64'],validate=True)
    root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    entry=next((e for e in bundle.toolkit_manifest.entries if e.path=='ops/install/rbridge_bootstrap.py'),None)
    if (entry is None or entry.kind!='FILE' or entry.size!=len(payload) or entry.sha256!=manifest['payload_sha256']
            or _protected_bytes(root/entry.path,49152)!=payload):_fail('OWNER_COMMAND_BOOTSTRAP_CHANGED')
    if operation=='apply':_bundle_authorization(bundle,SwitchAuthorization(**value['authorization']))
    assert_owned_helpers_settled();return recipe,actual


def prepare_root_owner_command_recipe(profile,bundle,bootstrap_observation,operation,value):
    """Expose exact review material only after actual qualification; no READY command."""
    request={'python_closure_sha256':value['qualification']['python_closure_sha256']};p,_root=_context(profile,request)
    recipe,actual=_root_recipe(p,bundle,bootstrap_observation,operation,value)
    return {'schema':'RBRIDGE_ROOT_OWNER_COMMAND_RECIPE_V1','scope':'ROOT_QUALIFIED_REVIEW_MATERIAL',
        'status':'REVIEW_REQUIRED','recipe':recipe,'bootstrap_capture_sha256':report_sha256(actual),
        'may_execute':False,'service_action_authorized':False}


@dataclass(frozen=True,eq=False)
class _RootOwnerCommandObservation:
    profile_sha256:str
    evidence_json:str
    fixture_path:str


def collect_root_owner_command_review(profile,bundle,bootstrap_observation,operation,value):
    request={'python_closure_sha256':value['qualification']['python_closure_sha256']};p,_root=_context(profile,request)
    recipe,actual=_root_recipe(p,bundle,bootstrap_observation,operation,value)
    backend=QualifiedGitHubReadBackend(p,retain_queries=True);lookups=[];number=value['command_review_issue']
    for _index in range(2):
        issues=lookup_issues(p,[number],backend)
        if len(issues)!=1 or backend.capture_status!='PASS' or backend.profile_sha256!=report_sha256(p):
            _fail('OWNER_COMMAND_REVIEW_CAPTURE_INCOMPLETE')
        lookups.append({'issue':_stable_issue(issues[0]),'capture_sha256':backend.capture_sha256,
            'rate_observations':backend.rate_observations,'rate_sha256':backend.rate_sha256})
    if encode_report(lookups[0]['issue'])!=encode_report(lookups[1]['issue']):_fail('OWNER_COMMAND_REVIEW_ISSUE_CHANGED')
    issue=lookups[0]['issue'];capture={'schema':'RBRIDGE_OWNER_COMMAND_REVIEW_CAPTURE_V1','repository':p.binding.repository,
        'viewer':p.binding.author,'author':issue['author'],'issue_number':issue['number'],'is_pull_request':issue['isPullRequest'],
        'url':issue['url'],'body':issue['body']}
    comparison=compare_owner_command_review(p,operation,value,capture)
    after_recipe,after_actual=_root_recipe(p,bundle,bootstrap_observation,operation,value)
    if encode_report(after_recipe)!=encode_report(recipe) or encode_report(after_actual)!=encode_report(actual):
        _fail('OWNER_COMMAND_PREIMAGES_CHANGED')
    _queries(p,backend.query_evidence,number);assert_owned_helpers_settled()
    evidence={'schema':'RBRIDGE_ROOT_OWNER_COMMAND_EVIDENCE_V1','recipe':recipe,'bootstrap':actual,
        'comparison':comparison,'lookups':lookups,'queries':backend.query_evidence}
    raw=encode_report(evidence)
    if len(raw)>p.budget.carrier_bytes:_fail('OWNER_COMMAND_EVIDENCE_BYTE_LIMIT')
    fixture=_FixtureDirectory(p,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:fixture.write(raw);token=_RootOwnerCommandObservation(report_sha256(p),raw.decode(),str(fixture.path))
    finally:fixture.close()
    _observations[token]=(report_sha256(token),bundle,bootstrap_observation,p,operation,encode_report(value).decode())
    try:verify_root_owner_command(p,token,bundle=bundle)
    except BaseException:del _observations[token];raise
    _commands[bundle]=token;return token


def _registered(profile,token,bundle=None):
    if type(token) is not _RootOwnerCommandObservation or token not in _observations:_fail('OWNER_COMMAND_ORIGIN_UNQUALIFIED')
    pin,original,bootstrap,p,operation,value_json=_observations[token]
    if (report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile) or token.profile_sha256!=report_sha256(p)):
        _fail('OWNER_COMMAND_OBSERVATION_CHANGED')
    if bundle is not None and bundle is not original:_fail('OWNER_COMMAND_BUNDLE_ORIGIN_CHANGED')
    value=_json(value_json.encode(),p.budget.carrier_bytes)
    owner_command_recipe(p,operation,value)
    return original,bootstrap,p,operation,value


def verify_root_owner_command(profile,token,*,bundle=None):
    original,bootstrap,p,operation,value=_registered(profile,token,bundle)
    request={'python_closure_sha256':value['qualification']['python_closure_sha256']};p,_root=_context(p,request)
    recipe,actual=_root_recipe(p,original,bootstrap,operation,value)
    evidence=_json(token.evidence_json.encode(),p.budget.carrier_bytes)
    if (type(evidence) is not dict or set(evidence)!={'schema','recipe','bootstrap','comparison','lookups','queries'}
            or evidence['schema']!='RBRIDGE_ROOT_OWNER_COMMAND_EVIDENCE_V1'
            or encode_report(evidence['recipe'])!=encode_report(recipe) or encode_report(evidence['bootstrap'])!=encode_report(actual)
            or type(evidence['lookups']) is not list or len(evidence['lookups'])!=2):_fail('OWNER_COMMAND_PREIMAGES_CHANGED')
    before,after=evidence['lookups']
    if encode_report(before['issue'])!=encode_report(after['issue']):_fail('OWNER_COMMAND_REVIEW_ISSUE_CHANGED')
    capture=evidence['comparison']['capture'];issue=before['issue']
    if any(capture[k]!=issue[j] for k,j in (('issue_number','number'),('author','author'),('is_pull_request','isPullRequest'),('url','url'),('body','body'))):
        _fail('OWNER_COMMAND_REVIEW_CAPTURE_CHANGED')
    if encode_report(compare_owner_command_review(p,operation,value,capture))!=encode_report(evidence['comparison']):
        _fail('OWNER_COMMAND_REVIEW_BYTES_CHANGED')
    _queries(p,evidence['queries'],value['command_review_issue'])
    fixture=_FixtureDirectory(p,token.fixture_path,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        if os.listdir(fixture.fd)!=['evidence.json'] or fixture.read()!=token.evidence_json.encode():_fail('OWNER_COMMAND_EVIDENCE_CHANGED')
    finally:fixture.close()
    _registered(profile,token,bundle);assert_owned_helpers_settled()
    return {'schema':'RBRIDGE_ROOT_OWNER_COMMAND_OBSERVATION_V1','scope':'ROOT_AUTHENTICATED_EXACT_COMMAND_REVIEW','status':'PASS',
        'profile_sha256':token.profile_sha256,'evidence':evidence,'operation':operation,
        'may_execute':False,'service_action_authorized':False}


def reviewed_dispatch_bundle(profile,token,operation,value):
    original,_bootstrap,p,reviewed_operation,reviewed_value=_registered(profile,token)
    if operation!=reviewed_operation or encode_report(value)!=encode_report(entry_input(reviewed_value)):
        _fail('OWNER_COMMAND_DISPATCH_CHANGED')
    verify_root_owner_command(p,token,bundle=original);return original


def render_qualified_owner_command(bundle):
    token=_commands.get(bundle)
    if token is None:_fail('QUALIFICATION_REVIEWED_BOOTSTRAP_COMMAND_MISSING')
    actual=verify_root_owner_command(bundle.profile,token,bundle=bundle);recipe=actual['evidence']['recipe']
    return {'schema':'RBRIDGE_QUALIFIED_OWNER_COMMAND_V1','scope':'ROOT_EXACT_REVIEWED_COMMAND','status':'READY',
        'operation':actual['operation'],'script':recipe['script'],'pins':recipe['pins'],
        'may_execute':True,'service_action_authorized':False,'review_grants_switch_authorization':False}
