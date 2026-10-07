"""Protected Root origin for filesystem CAS against the fixed fake service.

The actual runtime UID/GID owns only the isolated empty state fixture. All
configuration files, pointer operations and evidence stay below generated Root
home paths. This one case grants no actual systemd, helper-family or bundle proof.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sys
import weakref
from .config_cas_fixture import _produce,compare_config_cas_cases,LIMIT
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .artifact_collector import _closure
from .models import InstallationError,encode_report,report_sha256
from .profile import parse_profile,assert_reader_profile_extension
from .readonly_helper import _json


class ConfigCasCollectorError(InstallationError):pass
def _fail(reason):raise ConfigCasCollectorError(reason)


@dataclass(frozen=True,eq=False)
class _RootConfigCasObservation:
    profile_sha256:str
    evidence_json:str
    fixture_path:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/config_cas_collector.py'):
        _fail('CONFIG_CAS_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _materials(profile,root,runtime_manifest,toolkit_manifest,request):
    _closure(profile,root,runtime_manifest,toolkit_manifest,request)
    needed={'ops/install/rbridge_installation/config_cas_fixture.py','ops/install/rbridge_installation/config_cas_collector.py',
        'ops/install/rbridge_installation/copy_ledger_fixture.py','ops/install/rbridge_installation/copy_ledger_collector.py',
        'ops/install/rbridge_installation/configuration.py','ops/install/rbridge_installation/pause_backup.py'}
    if not needed<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('CONFIG_CAS_COLLECTOR_ENTRY_UNQUALIFIED')


def collect_root_config_cas_cases(profile,runtime_manifest,toolkit_manifest,qualification_request):
    p,root=_context(profile,qualification_request);_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    fixture=_FixtureDirectory(p,prefix='.rbridge-config-cas-')
    try:
        def guard():
            fixture.check();_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
        output=_produce(fixture.path,p,p.binding.uid,p.binding.gid,guard);raw=encode_report(output)
        fixture.write(raw);guard()
        token=_RootConfigCasObservation(report_sha256(p),raw.decode(),str(fixture.path))
        _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest,p)
        return token
    finally:fixture.close()


def verify_root_config_cas_observation(profile,token,qualification_request):
    if type(token) is not _RootConfigCasObservation or token not in _observations:_fail('CONFIG_CAS_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,runtime_manifest,toolkit_manifest,original=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(original):_fail('CONFIG_CAS_COLLECTOR_OBSERVATION_CHANGED')
    assert_reader_profile_extension(original,profile)
    p,root=_context(original,qualification_request);target,target_root=_context(profile,qualification_request)
    _materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    _materials(target,target_root,runtime_manifest,toolkit_manifest,qualification_request)
    fixture=_FixtureDirectory(p,token.fixture_path,prefix='.rbridge-config-cas-')
    try:
        raw=fixture.read()
        if raw.decode('utf-8',errors='strict')!=token.evidence_json:_fail('CONFIG_CAS_COLLECTOR_OBSERVATION_CHANGED')
        output=_json(raw,LIMIT);compare_config_cas_cases(p,output)
        if (output['uid']!=0 or output['euid']!=0 or output['runtime_uid']!=1027 or output['runtime_gid']!=p.binding.gid):
            _fail('CONFIG_CAS_COLLECTOR_RUNTIME_IDENTITY_CHANGED')
        return {'schema':'RBRIDGE_ROOT_CONFIG_CAS_OBSERVATION_V1','scope':'ROOT_PROTECTED_CONFIG_CAS_FIXTURE_PRODUCER',
            'status':'PASS','original_profile_sha256':token.profile_sha256,'profile_sha256':report_sha256(target),
            'evidence_sha256':hashlib.sha256(raw).hexdigest(),'output':output,'case':'config_cas',
            'actual_systemd_actions':'NOT_PERFORMED','full_privileged_qualification':'INCOMPLETE',
            'may_execute':False,'service_action_authorized':False}
    finally:fixture.close()
