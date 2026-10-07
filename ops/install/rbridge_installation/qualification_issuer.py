"""Issue preparation authority only from genuine reviewed Root material.

The private bundle retains the identical material/review observations and full
protected evidence. After issuance, verification preserves those historical
facts and current immutable material; it never repeats the fixture's old
production fingerprint after our own authorized transaction. This module
issues neither a reviewed owner command nor production switch permission.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import weakref
from .artifact_collector import _closure
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .material_review_collector import (material_review_pins,verify_root_material_review,preserve_root_material_review,
    _registered as _review_registered)
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile
from .protected_copy import PublishedArtifact
from .qualification import _QualifiedBundle,_bundle_pin,_qualified,verify_qualification_bundle
from .qualification_collector import (verify_root_qualification_material,preserve_root_qualification_material,
    _registered as _material_registered)
from .readonly_helper import _json


class QualificationIssuerError(InstallationError):pass
def _fail(reason):raise QualificationIssuerError(reason)


_origins=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/qualification_issuer.py'):
        _fail('QUALIFICATION_ISSUER_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _materials(p,root,runtime_manifest,toolkit_manifest,request):
    _closure(p,root,runtime_manifest,toolkit_manifest,request)
    required={'ops/install/rbridge_installation/qualification_issuer.py',
        'ops/install/rbridge_installation/material_review_collector.py'}
    if not required<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('QUALIFICATION_ISSUER_ENTRY_UNQUALIFIED')


def _evidence(p,material,review):
    # Composition is data only. Callers must concretely verify both private
    # origins before using these bytes to register preparation authority.
    pins=material_review_pins(p,material)
    if (review['schema']!='RBRIDGE_ROOT_MATERIAL_REVIEW_OBSERVATION_V1'
            or review['scope']!='ROOT_AUTHENTICATED_OWNER_MATERIAL_REVIEW' or review['status']!='PASS'
            or review['profile_sha256']!=report_sha256(p) or review['review_scope']!='PREPARATION_ONLY'
            or review['may_execute'] is not False or review['service_action_authorized'] is not False
            or encode_report(review['evidence']['comparison']['receipt']['pins'])!=encode_report(pins)):
        _fail('QUALIFICATION_ISSUER_REVIEW_CHANGED')
    value={'schema':'RBRIDGE_ROOT_ISSUED_QUALIFICATION_EVIDENCE_V1','profile_sha256':report_sha256(p),
        'base_profile_sha256':material['base_profile_sha256'],'material_evidence_sha256':material['evidence_sha256'],
        'material':material['evidence'],'review':review,'preparation_pins':pins,
        'reviewed_owner_command':'NOT_ISSUED','service_action_authorized':False}
    if len(encode_report(value))>p.budget.carrier_bytes:_fail('QUALIFICATION_ISSUER_EVIDENCE_BYTE_LIMIT')
    return value


def _registered(profile,bundle):
    if type(bundle) is not _QualifiedBundle or bundle not in _origins:_fail('QUALIFICATION_ISSUER_ORIGIN_UNQUALIFIED')
    row=_origins[bundle]
    if type(row) is not tuple or len(row)!=10:_fail('QUALIFICATION_ISSUER_ORIGIN_CHANGED')
    pin,material,review,p,runtime_manifest,toolkit_manifest,artifact,request_json,evidence_json,fixture_path=row
    if (report_sha256(profile)!=report_sha256(p) or report_sha256(bundle.profile)!=report_sha256(p)
            or _bundle_pin(bundle)!=pin or bundle.runtime_manifest is not runtime_manifest
            or bundle.toolkit_manifest is not toolkit_manifest or bundle.runtime_artifact is not artifact):
        _fail('QUALIFICATION_ISSUER_ORIGIN_CHANGED')
    request=_json(request_json.encode(),65536)
    if encode_report(request).decode()!=request_json:_fail('QUALIFICATION_ISSUER_ORIGIN_CHANGED')
    _original,_base,_p,rm,tm=_material_registered(p,material,request)
    if rm is not runtime_manifest or tm is not toolkit_manifest:_fail('QUALIFICATION_ISSUER_ORIGIN_CHANGED')
    _review_registered(p,review,request,material)
    return row,request


def issue_root_qualification_bundle(profile,material_observation,review_observation,qualification_request):
    p,root=_context(profile,qualification_request)
    request=_json(encode_report(qualification_request),65536)
    _original,_base,_p,runtime_manifest,toolkit_manifest=_material_registered(p,material_observation,request)
    _review_registered(p,review_observation,request,material_observation)
    _materials(p,root,runtime_manifest,toolkit_manifest,request)
    material=verify_root_qualification_material(p,material_observation,request)
    review=verify_root_material_review(p,review_observation,request,material_observation=material_observation)
    evidence=_evidence(p,material,review);raw=encode_report(evidence)
    value=material['evidence'];pins=evidence['preparation_pins']
    canary=base64.b64decode(value['canary_base64'],validate=True)
    if base64.b64encode(canary).decode()!=value['canary_base64']:_fail('QUALIFICATION_ISSUER_CANARY_CHANGED')
    # This metadata represents material just verified through the actual Root
    # descriptor publication/complete immutable tree checks, never a scope label.
    artifact=PublishedArtifact(Path(p.paths.release_parent)/p.runtime.source_sha,
        runtime_manifest.sha256,runtime_manifest.source_sha,'ROOT_DESCRIPTOR_PUBLICATION')
    bundle=_QualifiedBundle(p,artifact,runtime_manifest,toolkit_manifest,pins['readers_sha256'],
        pins['reader_context_sha256'],pins['helper_sha256'],canary,pins['python_closure_sha256'],hashlib.sha256(raw).hexdigest())
    pin=_bundle_pin(bundle);fixture=_FixtureDirectory(p,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        fixture.write(raw)
        if fixture.read()!=raw:_fail('QUALIFICATION_ISSUER_EVIDENCE_CHANGED')
        after=verify_root_qualification_material(p,material_observation,request)
        after_review=verify_root_material_review(p,review_observation,request,material_observation=material_observation)
        if encode_report(_evidence(p,after,after_review))!=raw:_fail('QUALIFICATION_ISSUER_COMPONENT_CHANGED')
        _materials(p,root,runtime_manifest,toolkit_manifest,request);assert_owned_helpers_settled();fixture.check()
        _origins[bundle]=(pin,material_observation,review_observation,p,runtime_manifest,toolkit_manifest,artifact,
            encode_report(request).decode(),raw.decode(),str(fixture.path))
        _qualified[bundle]=pin
        try:return verify_qualification_bundle(p,bundle)
        except BaseException:
            _origins.pop(bundle,None);_qualified.pop(bundle,None);raise
    finally:fixture.close()


def verify_root_bundle_origin(profile,bundle):
    """Preserve original qualification, including after our own START_ATTEMPTED.

    Original producer objects, protected full evidence and current immutable
    closures remain mandatory. No serialized bundle or cold PASS reconstitutes
    these live private origins.
    """
    if type(bundle) is _QualifiedBundle and bundle not in _origins:
        from .qualification_custody import verify_root_custody_origin
        return verify_root_custody_origin(profile,bundle)
    row,request=_registered(profile,bundle)
    _pin,material,review,p,runtime_manifest,toolkit_manifest,_artifact,request_json,evidence_json,fixture_path=row
    p,root=_context(p,request);_materials(p,root,runtime_manifest,toolkit_manifest,request)
    fixture=_FixtureDirectory(p,fixture_path,prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        raw=fixture.read()
        if (raw.decode()!=evidence_json or hashlib.sha256(raw).hexdigest()!=bundle.evidence_sha256
                or encode_report(_json(raw,p.budget.carrier_bytes))!=raw):_fail('QUALIFICATION_ISSUER_EVIDENCE_CHANGED')
        original=preserve_root_qualification_material(p,material,request)
        original_review=preserve_root_material_review(p,review,request,material_observation=material)
        if encode_report(_evidence(p,original,original_review))!=raw:_fail('QUALIFICATION_ISSUER_COMPONENT_CHANGED')
        _registered(profile,bundle);assert_owned_helpers_settled();fixture.check()
        return bundle
    finally:fixture.close()
