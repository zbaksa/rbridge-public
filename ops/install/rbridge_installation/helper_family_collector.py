"""Retain genuine original-artifact helper-family observation, never relaunch it.

Only a protected actual Root collector origin can issue this case. Full session
rows and original IO are read back through a retained Root directory, pinned to
the exact artifact object. This component neither qualifies stop nor bootstrap.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sys
import weakref
from .artifact_collector import verify_root_artifact_observation
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .helper_family_case import capture_helper_family_case,compare_helper_family_case
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile,assert_reader_profile_extension
from .readonly_helper import _json


class HelperFamilyCollectorError(InstallationError):pass
def _fail(reason):raise HelperFamilyCollectorError(reason)


@dataclass(frozen=True,eq=False)
class _RootHelperFamilyObservation:
    profile_sha256:str
    artifact_sha256:str
    evidence_json:str
    fixture_path:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/helper_family_collector.py'):
        _fail('HELPER_FAMILY_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _original_case(profile,artifact,request):
    observed=verify_root_artifact_observation(profile,artifact,request)
    packet=_json(observed['evidence']['input_json'].encode(),profile.budget.carrier_bytes)
    needed={'ops/install/rbridge_installation/helper_family_collector.py','ops/install/rbridge_installation/helper_family_case.py',
        'ops/install/rbridge_installation/owned_process.py','ops/install/rbridge_installation/helper_journal.py',
        'ops/install/rbridge_installation/copy_ledger_collector.py'}
    if not needed<={e['path'] for e in packet['toolkit_manifest']['entries'] if e['kind']=='FILE'}:
        _fail('HELPER_FAMILY_COLLECTOR_ENTRY_UNQUALIFIED')
    assert_owned_helpers_settled()
    return capture_helper_family_case(profile,observed['evidence'],observed['session'],artifact.fixture_home)


def collect_root_helper_family(profile,artifact_observation,qualification_request):
    p,_root=_context(profile,qualification_request);case=_original_case(p,artifact_observation,qualification_request)
    # Declare the approved aggregate carrier ceiling before creating this new
    # evidence directory; never increase it after an actual fixture failure.
    fixture=_FixtureDirectory(p,prefix='.rbridge-helper-family-',limit=p.budget.carrier_bytes)
    try:
        raw=encode_report(case);fixture.write(raw)
        if encode_report(_original_case(p,artifact_observation,qualification_request))!=raw:
            _fail('HELPER_FAMILY_COLLECTOR_OBSERVATION_CHANGED')
        token=_RootHelperFamilyObservation(report_sha256(p),report_sha256(artifact_observation),raw.decode(),str(fixture.path))
        _observations[token]=(report_sha256(token),artifact_observation,p)
        return token
    finally:fixture.close()


def verify_root_helper_family_observation(profile,token,qualification_request,*,artifact_observation=None):
    if type(token) is not _RootHelperFamilyObservation or token not in _observations:_fail('HELPER_FAMILY_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,artifact,original=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(original):_fail('HELPER_FAMILY_COLLECTOR_OBSERVATION_CHANGED')
    if artifact_observation is not None and artifact_observation is not artifact:
        _fail('HELPER_FAMILY_COLLECTOR_ARTIFACT_ORIGIN_CHANGED')
    if report_sha256(artifact)!=token.artifact_sha256:_fail('HELPER_FAMILY_COLLECTOR_OBSERVATION_CHANGED')
    assert_reader_profile_extension(original,profile)
    p,_root=_context(original,qualification_request);target,_target_root=_context(profile,qualification_request)
    actual=_original_case(p,artifact,qualification_request)
    fixture=_FixtureDirectory(p,token.fixture_path,prefix='.rbridge-helper-family-',limit=p.budget.carrier_bytes)
    try:
        raw=fixture.read()
        if raw.decode()!=token.evidence_json or raw!=encode_report(actual):_fail('HELPER_FAMILY_COLLECTOR_OBSERVATION_CHANGED')
        case=_json(raw,p.budget.carrier_bytes);compare_helper_family_case(p,case)
        return {'schema':'RBRIDGE_ROOT_HELPER_FAMILY_OBSERVATION_V1','scope':'ROOT_PROTECTED_HELPER_FAMILY_OBSERVATION',
            'status':'PASS','original_profile_sha256':token.profile_sha256,'profile_sha256':report_sha256(target),
            'artifact_sha256':token.artifact_sha256,'evidence_sha256':hashlib.sha256(raw).hexdigest(),
            'output':case,'case':'owned_helper_family','full_privileged_qualification':'INCOMPLETE',
            'may_execute':False,'service_action_authorized':False}
    finally:fixture.close()
