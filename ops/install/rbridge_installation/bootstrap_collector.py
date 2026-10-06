"""Collect authenticated exact bootstrap bytes from a fixed issue, never execute.

The Root producer preserves complete GitHub/owned-helper preimages and privately
registers their origin. Review, publication, bootstrap dispatch and the complete
qualification bundle are separate; serialized authenticated scopes grant none.
"""
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import weakref
from .artifact_collector import _closure
from .github_lookup import QualifiedGitHubReadBackend,lookup_issues
from .host_backend import _assert_kernel_namespace
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile
from .qualification import verify_import_closure
from .readonly_helper import _json


class BootstrapCollectorError(InstallationError):pass
def _fail(reason):raise BootstrapCollectorError(reason)


def _hash(value,size=64):return type(value) is str and re.fullmatch('[0-9a-f]{'+str(size)+'}',value)


def _manifest(value):
    keys={'schema','source_sha','tree_sha','payload_bytes','payload_sha256','toolkit_manifest_sha256','python_closure_sha256'}
    if (type(value) is not dict or set(value)!=keys or value['schema']!='RBRIDGE_BOOTSTRAP_MANIFEST_V1'
            or any(not _hash(value[k],40) for k in ('source_sha','tree_sha'))
            or any(not _hash(value[k]) for k in ('payload_sha256','toolkit_manifest_sha256','python_closure_sha256'))
            or type(value['payload_bytes']) is not int or not 1<=value['payload_bytes']<=49152):
        _fail('BOOTSTRAP_COLLECTOR_MANIFEST_INVALID')


def decode_bootstrap_body(body,expected_manifest):
    """Pure bounded byte comparison; does not authenticate or authorize anything."""
    _manifest(expected_manifest)
    if type(body) is not str:_fail('BOOTSTRAP_COLLECTOR_BODY_INVALID')
    try:
        raw=body.encode('utf-8',errors='strict')
        if not raw or len(raw)>65536:_fail('BOOTSTRAP_COLLECTOR_BODY_INVALID')
        value=_json(raw,65536)
        if (type(value) is not dict or set(value)!={'schema','manifest','payload_base64'}
                or value['schema']!='RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1' or value['manifest']!=expected_manifest
                or type(value['payload_base64']) is not str or len(value['payload_base64'])>((49152+2)//3)*4):
            _fail('BOOTSTRAP_COLLECTOR_BODY_INVALID')
        _manifest(value['manifest'])
        payload=base64.b64decode(value['payload_base64'],validate=True)
        if (base64.b64encode(payload).decode()!=value['payload_base64'] or len(payload)!=expected_manifest['payload_bytes']
                or hashlib.sha256(payload).hexdigest()!=expected_manifest['payload_sha256']):
            _fail('BOOTSTRAP_COLLECTOR_BYTES_MISMATCH')
        payload.decode('utf-8',errors='strict');return payload
    except (ValueError,TypeError,UnicodeError,RecursionError):_fail('BOOTSTRAP_COLLECTOR_BODY_INVALID')


@dataclass(frozen=True,eq=False)
class _RootBootstrapObservation:
    profile_sha256:str
    manifest_json:str
    capture_json:str
    queries_json:str
    payload_base64:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/bootstrap_collector.py'):
        _fail('BOOTSTRAP_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();verify_import_closure(root,p,request);return p,root


def _pins(profile,manifest,request):
    _manifest(manifest)
    if (manifest['source_sha']!=profile.toolkit.source_sha or manifest['tree_sha']!=profile.toolkit.tree_sha
            or manifest['toolkit_manifest_sha256']!=profile.toolkit.manifest_sha256
            or manifest['python_closure_sha256']!=request.get('python_closure_sha256')):
        _fail('BOOTSTRAP_COLLECTOR_EXPECTED_PINS_CHANGED')


def collect_root_bootstrap_bytes(profile,runtime_manifest,toolkit_manifest,expected_manifest,issue_number,qualification_request):
    p,root=_context(profile,qualification_request);_pins(p,expected_manifest,qualification_request)
    if type(issue_number) is not int or not 1<=issue_number<=2147483647:_fail('BOOTSTRAP_COLLECTOR_ISSUE_INVALID')
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    backend=QualifiedGitHubReadBackend(p,retain_queries=True)
    issues=lookup_issues(p,[issue_number],backend)
    if (len(issues)!=1 or backend.capture_status!='PASS' or backend.profile_sha256!=report_sha256(p)
            or len(backend.query_evidence)!=2):_fail('BOOTSTRAP_COLLECTOR_CAPTURE_INCOMPLETE')
    issue=issues[0];payload=decode_bootstrap_body(issue.body,expected_manifest)
    capture={'schema':'RBRIDGE_BOOTSTRAP_ARTIFACT_CAPTURE_V1','repository':p.binding.repository,
        'viewer':p.binding.author,'author':issue.author,'issue_number':issue.number,'is_pull_request':issue.isPullRequest,
        'url':issue.url,'body':issue.body}
    evidence={'capture':capture,'issue':issue,'capture_sha256':backend.capture_sha256,
        'rate_observations':backend.rate_observations,'rate_sha256':backend.rate_sha256}
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request);assert_owned_helpers_settled()
    token=_RootBootstrapObservation(report_sha256(p),encode_report(expected_manifest).decode(),encode_report(evidence).decode(),
        encode_report(backend.query_evidence).decode(),base64.b64encode(payload).decode())
    if len(encode_report(token))>p.budget.carrier_bytes:_fail('BOOTSTRAP_COLLECTOR_EVIDENCE_BYTE_LIMIT')
    _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest)
    return token


def verify_root_bootstrap_observation(profile,token,runtime_manifest,toolkit_manifest,qualification_request):
    if type(token) is not _RootBootstrapObservation or token not in _observations:_fail('BOOTSTRAP_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,original_runtime,original_toolkit=_observations[token]
    if (report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile)
            or report_sha256(runtime_manifest)!=report_sha256(original_runtime)
            or report_sha256(toolkit_manifest)!=report_sha256(original_toolkit)):_fail('BOOTSTRAP_COLLECTOR_OBSERVATION_CHANGED')
    p,root=_context(profile,qualification_request);_closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    manifest=_json(token.manifest_json.encode());_pins(p,manifest,qualification_request)
    evidence=_json(token.capture_json.encode());capture=evidence['capture'];queries=_json(token.queries_json.encode())
    payload=decode_bootstrap_body(capture['body'],manifest)
    if base64.b64encode(payload).decode()!=token.payload_base64:_fail('BOOTSTRAP_COLLECTOR_OBSERVATION_CHANGED')
    if (capture['repository']!=p.binding.repository or capture['viewer']!=p.binding.author or capture['author']!=p.binding.author
            or type(capture['issue_number']) is not int or capture['is_pull_request'] is not False
            or capture['url']!='https://github.com/'+p.binding.repository+'/issues/'+str(capture['issue_number'])
            or type(queries) is not list or len(queries)!=2):_fail('BOOTSTRAP_COLLECTOR_OBSERVATION_CHANGED')
    for query in queries:
        session=query['session']
        for key,digest in (('input_base64','input_sha256'),('output_base64','output_sha256')):
            raw=base64.b64decode(query[key],validate=True)
            if base64.b64encode(raw).decode()!=query[key] or hashlib.sha256(raw).hexdigest()!=session[digest]:
                _fail('BOOTSTRAP_COLLECTOR_OBSERVATION_CHANGED')
        if (session['status']!='PASS' or session['scope']!='ROOT_FIXED_PROCESS_OBSERVATION' or session['exit_code']!=0
                or session['live_helpers']!=[] or query['argv']!=session['argv']):_fail('BOOTSTRAP_COLLECTOR_OBSERVATION_CHANGED')
    return {'schema':'RBRIDGE_ROOT_BOOTSTRAP_OBSERVATION_V1','scope':'ROOT_AUTHENTICATED_BOOTSTRAP_BYTES',
        'status':'PASS','manifest':manifest,'evidence':evidence,'queries':queries,'payload_base64':token.payload_base64,
        'may_execute':False,'service_action_authorized':False}
