"""Authenticate and publish the original reviewed bootstrap, never execute it.

Publication requires the same genuine issuer/custody bundle and a fresh private
authenticated bootstrap observation. Full original bytes, captures, owned-helper
preimages and the protected create-only publication are retained. This origin
grants neither an owner command nor a production switch.
"""
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import weakref
from .artifact_collector import _closure
from .bootstrap_collector import collect_root_bootstrap_bytes,verify_root_bootstrap_observation
from .bootstrap_fixture_collector import _module
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile
from .qualification import _QualifiedBundle,_qualified,_bundle_pin,verify_qualification_bundle
from .readonly_helper import _json


class BootstrapPublicationError(InstallationError):pass
def _fail(reason):raise BootstrapPublicationError(reason)
def _hash(value):return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None


def compare_bootstrap_publication(profile,module,evidence):
    """Compare complete bytes/descriptor metadata; supplied Root labels are data."""
    p=parse_profile(json.loads(encode_report(profile)))
    fields={'schema','scope','profile_sha256','bundle_pin','bootstrap','publication','qualification_request'}
    if (len(encode_report(evidence))>p.budget.carrier_bytes or type(evidence) is not dict or set(evidence)!=fields
            or evidence['schema']!='RBRIDGE_ROOT_BOOTSTRAP_PUBLICATION_EVIDENCE_V1'
            or evidence['scope']!='ROOT_AUTHENTICATED_PUBLICATION_DATA_ONLY'
            or evidence['profile_sha256']!=report_sha256(p) or not _hash(evidence['bundle_pin'])):
        _fail('BOOTSTRAP_PUBLICATION_DATA_INVALID')
    request=evidence['qualification_request'];bootstrap=evidence['bootstrap'];publication=evidence['publication']
    if (type(request) is not dict or set(request)!={'python_closure_sha256'} or not _hash(request['python_closure_sha256'])
            or type(bootstrap) is not dict or set(bootstrap)!={'schema','scope','status','manifest','evidence','queries',
                'payload_base64','may_execute','service_action_authorized'}
            or bootstrap['schema']!='RBRIDGE_ROOT_BOOTSTRAP_OBSERVATION_V1'
            or bootstrap['scope']!='ROOT_AUTHENTICATED_BOOTSTRAP_BYTES' or bootstrap['status']!='PASS'
            or bootstrap['may_execute'] is not False or bootstrap['service_action_authorized'] is not False
            or type(publication) is not dict or type(bootstrap['payload_base64']) is not str):
        _fail('BOOTSTRAP_PUBLICATION_DATA_INVALID')
    manifest=bootstrap['manifest'];capture_evidence=bootstrap['evidence']
    if (type(manifest) is not dict or set(manifest)!={'schema','source_sha','tree_sha','payload_bytes','payload_sha256',
                'toolkit_manifest_sha256','python_closure_sha256'}
            or type(capture_evidence) is not dict or 'capture' not in capture_evidence
            or type(capture_evidence['capture']) is not dict or set(capture_evidence['capture'])!={'schema','repository','viewer',
                'author','issue_number','is_pull_request','url','body'}):_fail('BOOTSTRAP_PUBLICATION_DATA_INVALID')
    capture=capture_evidence['capture']
    if (manifest['source_sha']!=p.toolkit.source_sha or manifest['tree_sha']!=p.toolkit.tree_sha
            or manifest['toolkit_manifest_sha256']!=p.toolkit.manifest_sha256
            or manifest['python_closure_sha256']!=request['python_closure_sha256']):
        _fail('BOOTSTRAP_PUBLICATION_PINS_CHANGED')
    try:payload=base64.b64decode(bootstrap['payload_base64'],validate=True)
    except (ValueError,TypeError):_fail('BOOTSTRAP_PUBLICATION_BYTES_INVALID')
    if base64.b64encode(payload).decode()!=bootstrap['payload_base64']:_fail('BOOTSTRAP_PUBLICATION_BYTES_INVALID')
    binding={'repository':p.binding.repository,'author':p.binding.author,'issue_number':capture['issue_number']}
    proof=module.verify_bootstrap_artifact(payload,manifest,capture,binding)
    identity=publication.get('identity')
    if (type(identity) is not list or len(identity)!=9 or any(type(v) is not str or re.fullmatch('0|[1-9][0-9]{0,24}',v) is None for v in identity)
            or identity[2]!=str(stat.S_IFREG|0o400) or identity[3]!='0' or identity[5]!='1'
            or identity[6]!=str(len(payload))):_fail('BOOTSTRAP_PUBLICATION_DESCRIPTOR_INVALID')
    expected={**proof,'scope':'ROOT_PROTECTED_BYTES_ONLY','path':p.paths.ledger_parent+'/bootstrap-'+manifest['payload_sha256']+'/payload.py',
        'identity':identity}
    if p.paths.ledger_parent!='/var/lib/rbridge-maintenance' or encode_report(expected)!=encode_report(publication):
        _fail('BOOTSTRAP_PUBLICATION_BYTES_CHANGED')
    return {'schema':'RBRIDGE_BOOTSTRAP_PUBLICATION_COMPARISON_V1','status':'PASS','scope':'BOOTSTRAP_PUBLICATION_DATA_ONLY',
        'evidence_sha256':report_sha256(evidence),'physical_origin':'UNQUALIFIED','may_execute':False,'service_action_authorized':False}


@dataclass(frozen=True,eq=False)
class _RootBootstrapPublicationObservation:
    profile_sha256:str
    bundle_pin:str
    bootstrap_sha256:str
    evidence_json:str
    fixture_path:str


_observations=weakref.WeakKeyDictionary()


def _bundle_material(p,bundle,request):
    """Private retained references and bytes, before any fresh Root filesystem IO."""
    if type(bundle) is not _QualifiedBundle or bundle not in _qualified:_fail('BOOTSTRAP_PUBLICATION_BUNDLE_ORIGIN_UNQUALIFIED')
    if _bundle_pin(bundle)!=_qualified[bundle] or report_sha256(p)!=report_sha256(bundle.profile):
        _fail('BOOTSTRAP_PUBLICATION_BUNDLE_CHANGED')
    from .qualification_issuer import _origins as live,_registered as live_registered
    if bundle in live:
        row,original_request=live_registered(p,bundle);raw=row[8].encode()
    else:
        from .qualification_custody import _registered as cold_registered
        row,_locator,original_request=cold_registered(p,bundle);raw=row[7].encode()
    if encode_report(original_request)!=encode_report(request):_fail('BOOTSTRAP_PUBLICATION_REQUEST_CHANGED')
    evidence=_json(raw,p.budget.carrier_bytes)
    if encode_report(evidence)!=raw or hashlib.sha256(raw).hexdigest()!=bundle.evidence_sha256:
        _fail('BOOTSTRAP_PUBLICATION_BUNDLE_CHANGED')
    return evidence['material']['observations']['bootstrap']


def _context(p,request):
    root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/bootstrap_publication_collector.py'):
        _fail('BOOTSTRAP_PUBLICATION_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _materials(p,root,bundle,request):
    _closure(p,root,bundle.runtime_manifest,bundle.toolkit_manifest,request)
    if 'ops/install/rbridge_installation/bootstrap_publication_collector.py' not in {e.path for e in bundle.toolkit_manifest.entries if e.kind=='FILE'}:
        _fail('BOOTSTRAP_PUBLICATION_ENTRY_UNQUALIFIED')
    verify_qualification_bundle(p,bundle)


def collect_root_bootstrap_publication(profile,bundle,qualification_request):
    p=parse_profile(json.loads(encode_report(profile)));original=_bundle_material(p,bundle,qualification_request)
    p,root=_context(p,qualification_request);_materials(p,root,bundle,qualification_request)
    expected=original['manifest'];issue=original['evidence']['capture']['issue_number']
    token=collect_root_bootstrap_bytes(p,bundle.runtime_manifest,bundle.toolkit_manifest,expected,issue,qualification_request)
    observed=verify_root_bootstrap_observation(p,token,bundle.runtime_manifest,bundle.toolkit_manifest,qualification_request)
    if (encode_report(observed['evidence']['capture'])!=encode_report(original['evidence']['capture'])
            or observed['payload_base64']!=original['payload_base64']):_fail('BOOTSTRAP_PUBLICATION_ORIGINAL_CHANGED')
    module,payload=_module(p,root,bundle.runtime_manifest,bundle.toolkit_manifest,qualification_request)
    if base64.b64encode(payload).decode()!=observed['payload_base64']:_fail('BOOTSTRAP_PUBLICATION_BYTES_CHANGED')
    binding={'repository':p.binding.repository,'author':p.binding.author,'issue_number':issue}
    publication=module.publish_bootstrap_artifact(p.paths.ledger_parent,payload,expected,observed['evidence']['capture'],binding)
    evidence={'schema':'RBRIDGE_ROOT_BOOTSTRAP_PUBLICATION_EVIDENCE_V1','scope':'ROOT_AUTHENTICATED_PUBLICATION_DATA_ONLY',
        'profile_sha256':report_sha256(p),'bundle_pin':_bundle_pin(bundle),'bootstrap':observed,'publication':publication,
        'qualification_request':qualification_request}
    compare_bootstrap_publication(p,module,evidence);raw=encode_report(evidence)
    fixture=_FixtureDirectory(p,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        fixture.write(raw)
        after,identity=module._protected_file(Path(publication['path']),49152,0o400)
        if after!=payload or identity!=publication['identity']:_fail('BOOTSTRAP_PUBLICATION_BYTES_CHANGED')
        _materials(p,root,bundle,qualification_request);assert_owned_helpers_settled();fixture.check()
        observation=_RootBootstrapPublicationObservation(report_sha256(p),_bundle_pin(bundle),report_sha256(token),raw.decode(),str(fixture.path))
        _observations[observation]=(report_sha256(observation),bundle,token,p,encode_report(qualification_request).decode())
        try:verify_root_bootstrap_publication(p,observation,qualification_request,bundle=bundle)
        except BaseException:_observations.pop(observation,None);raise
        return observation
    finally:fixture.close()


def _registered(profile,token,request,bundle=None):
    if type(token) is not _RootBootstrapPublicationObservation or token not in _observations:_fail('BOOTSTRAP_PUBLICATION_ORIGIN_UNQUALIFIED')
    pin,original,bootstrap,p,request_json=_observations[token]
    if (report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile) or token.profile_sha256!=report_sha256(p)
            or report_sha256(bootstrap)!=token.bootstrap_sha256 or encode_report(request).decode()!=request_json):
        _fail('BOOTSTRAP_PUBLICATION_OBSERVATION_CHANGED')
    if bundle is not None and bundle is not original:_fail('BOOTSTRAP_PUBLICATION_BUNDLE_ORIGIN_CHANGED')
    return original,bootstrap,p


def verify_root_bootstrap_publication(profile,token,qualification_request,*,bundle=None):
    original,bootstrap,p=_registered(profile,token,qualification_request,bundle)
    retained=_bundle_material(p,original,qualification_request);p,root=_context(p,qualification_request)
    _materials(p,root,original,qualification_request)
    observed=verify_root_bootstrap_observation(p,bootstrap,original.runtime_manifest,original.toolkit_manifest,qualification_request)
    module,payload=_module(p,root,original.runtime_manifest,original.toolkit_manifest,qualification_request)
    evidence=_json(token.evidence_json.encode(),p.budget.carrier_bytes);compare_bootstrap_publication(p,module,evidence)
    if (evidence['bundle_pin']!=_bundle_pin(original) or encode_report(evidence['bootstrap'])!=encode_report(observed)
            or encode_report(observed['evidence']['capture'])!=encode_report(retained['evidence']['capture'])
            or observed['payload_base64']!=retained['payload_base64'] or base64.b64encode(payload).decode()!=observed['payload_base64']):
        _fail('BOOTSTRAP_PUBLICATION_ORIGINAL_CHANGED')
    publication=evidence['publication'];raw,identity=module._protected_file(Path(publication['path']),49152,0o400)
    if raw!=payload or identity!=publication['identity']:_fail('BOOTSTRAP_PUBLICATION_BYTES_CHANGED')
    fixture=_FixtureDirectory(p,token.fixture_path,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        if fixture.read().decode()!=token.evidence_json:_fail('BOOTSTRAP_PUBLICATION_OBSERVATION_CHANGED')
        _registered(profile,token,qualification_request,bundle);assert_owned_helpers_settled();fixture.check()
        return {'schema':'RBRIDGE_ROOT_BOOTSTRAP_PUBLICATION_OBSERVATION_V1','status':'PASS',
            'scope':'ROOT_AUTHENTICATED_PROTECTED_BOOTSTRAP_PUBLICATION','profile_sha256':token.profile_sha256,
            'bundle_pin':token.bundle_pin,'evidence':evidence,'evidence_sha256':report_sha256(evidence),
            'reviewed_owner_command':'NOT_ISSUED','may_execute':False,'service_action_authorized':False}
    finally:fixture.close()
