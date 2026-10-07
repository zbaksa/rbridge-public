"""Protected Root origin for two isolated fixture components, never a bundle.

The generated directory lives below the verified Root home, outside production
release/configuration/maintenance paths. The whole fixture and exact report are
retained on success or failure. The other four privileged cases stay UNKNOWN.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import sys
import weakref
from .artifact import _identity
from .artifact_collector import _closure
from .copy_ledger_fixture import _produce,compare_copy_ledger_cases,LIMIT
from .host_backend import _assert_kernel_namespace
from .models import InstallationError,encode_report,report_sha256
from .profile import parse_profile,assert_reader_profile_extension
from .protected_copy import DIR_FLAGS,FILE_FLAGS,FilesystemAuthority,ProtectedParent,_same
from .qualification import verify_import_closure
from .readonly_helper import _json


class CopyLedgerCollectorError(InstallationError):pass
def _fail(reason):raise CopyLedgerCollectorError(reason)


@dataclass(frozen=True,eq=False)
class _RootCopyLedgerObservation:
    profile_sha256:str
    evidence_json:str
    fixture_path:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/copy_ledger_collector.py'):
        _fail('COPY_LEDGER_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();verify_import_closure(root,p,request)
    try:account=pwd.getpwnam(p.binding.account)
    except KeyError:_fail('COPY_LEDGER_COLLECTOR_RUNTIME_IDENTITY_UNQUALIFIED')
    if (account.pw_uid!=1027 or account.pw_uid!=p.binding.uid or account.pw_gid!=p.binding.gid
            or account.pw_dir!=p.binding.home or tuple(sorted(set(os.getgrouplist(p.binding.account,p.binding.gid))-{p.binding.gid}))!=p.binding.supplementary_gids
            or 0 in os.getgrouplist(p.binding.account,p.binding.gid)):_fail('COPY_LEDGER_COLLECTOR_RUNTIME_IDENTITY_UNQUALIFIED')
    return p,root


def _materials(profile,root,runtime_manifest,toolkit_manifest,request):
    _closure(profile,root,runtime_manifest,toolkit_manifest,request)
    required={'ops/install/rbridge_installation/copy_ledger_collector.py',
        'ops/install/rbridge_installation/copy_ledger_fixture.py','ops/install/rbridge_installation/protected_copy.py',
        'ops/install/rbridge_installation/ledger.py'}
    if not required<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('COPY_LEDGER_COLLECTOR_ENTRY_UNQUALIFIED')


class _FixtureDirectory:
    def __init__(self,profile,path=None,*,prefix='.rbridge-copy-ledger-',limit=LIMIT):
        self.parent=None;self.fd=None
        try:
            if prefix not in ('.rbridge-copy-ledger-','.rbridge-config-cas-','.rbridge-helper-family-','.rbridge-fake-unit-'):_fail('COPY_LEDGER_COLLECTOR_FIXTURE_PREFIX_INVALID')
            if type(limit) is not int or not 1<=limit<=67108864:_fail('COPY_LEDGER_COLLECTOR_FIXTURE_LIMIT_INVALID')
            self.limit=limit
            self.parent=ProtectedParent(FilesystemAuthority(0,profile.binding.uid,Path('/root'),'RUNTIME'))
            if path is None:
                name=prefix+secrets.token_hex(16)
                os.mkdir(name,0o700,dir_fd=self.parent.fd);os.fsync(self.parent.fd)
            else:
                value=Path(path)
                if value.parent!=Path('/root') or re.fullmatch(re.escape(prefix)+'[0-9a-f]{32}',value.name) is None:
                    _fail('COPY_LEDGER_COLLECTOR_FIXTURE_PATH_INVALID')
                name=value.name
            self.name=name;self.path=Path('/root')/name
            before=os.stat(name,dir_fd=self.parent.fd,follow_symlinks=False)
            self.fd=os.open(name,DIR_FLAGS,dir_fd=self.parent.fd);self.identity=os.fstat(self.fd)
            if not _same(before,self.identity):_fail('COPY_LEDGER_COLLECTOR_FIXTURE_CHANGED')
            self.check()
            if path is None and os.listdir(self.fd):_fail('COPY_LEDGER_COLLECTOR_FIXTURE_NOT_EMPTY')
        except BaseException:self.close();raise
    def check(self):
        self.parent.check();named=os.stat(self.name,dir_fd=self.parent.fd,follow_symlinks=False);actual=os.fstat(self.fd)
        if (not _same(named,self.identity) or not _same(actual,self.identity) or not stat.S_ISDIR(actual.st_mode)
                or actual.st_uid!=0 or actual.st_mode&0o7777!=0o700):_fail('COPY_LEDGER_COLLECTOR_FIXTURE_CHANGED')
    def write(self,raw):
        if type(raw) is not bytes or not 0<len(raw)<=self.limit:_fail('COPY_LEDGER_COLLECTOR_EVIDENCE_BYTE_LIMIT')
        self.check();handle=os.open('evidence.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=self.fd)
        try:
            row=os.fstat(handle)
            if not stat.S_ISREG(row.st_mode) or row.st_uid!=0 or row.st_nlink!=1 or row.st_mode&0o7777!=0o600:
                _fail('COPY_LEDGER_COLLECTOR_EVIDENCE_UNPROTECTED')
            view=memoryview(raw)
            while view:
                count=os.write(handle,view)
                if count<=0:_fail('COPY_LEDGER_COLLECTOR_EVIDENCE_WRITE_FAILED')
                view=view[count:]
            os.fsync(handle)
        finally:os.close(handle)
        os.fsync(self.fd);self.check()
        if self.read()!=raw:_fail('COPY_LEDGER_COLLECTOR_EVIDENCE_CHANGED')
    def read(self):
        self.check();handle=os.open('evidence.json',FILE_FLAGS,dir_fd=self.fd)
        try:
            before=os.fstat(handle)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_nlink!=1
                    or before.st_mode&0o7777!=0o600 or not 0<before.st_size<=self.limit):_fail('COPY_LEDGER_COLLECTOR_EVIDENCE_UNPROTECTED')
            raw=bytearray()
            while len(raw)<=self.limit:
                part=os.read(handle,min(65536,self.limit+1-len(raw)))
                if not part:break
                raw.extend(part)
            if (len(raw)!=before.st_size or _identity(before)!=_identity(os.fstat(handle))
                    or _identity(before)!=_identity(os.stat('evidence.json',dir_fd=self.fd,follow_symlinks=False))):
                _fail('COPY_LEDGER_COLLECTOR_EVIDENCE_CHANGED')
            self.check();return bytes(raw)
        finally:os.close(handle)
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None
        if self.parent is not None:self.parent.close();self.parent=None
        # No cleanup: even partially written and deliberately damaged fixtures
        # belong to the retained evidence, never to a production release.


def collect_root_copy_ledger_cases(profile,runtime_manifest,toolkit_manifest,qualification_request):
    p,root=_context(profile,qualification_request);_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    fixture=_FixtureDirectory(p)
    try:
        def guard():
            fixture.check();_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
        output=_produce(fixture.path,p,p.binding.uid,True,guard)
        raw=encode_report(output);fixture.write(raw);guard()
        token=_RootCopyLedgerObservation(report_sha256(p),raw.decode(),str(fixture.path))
        _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest,p)
        return token
    finally:fixture.close()


def verify_root_copy_ledger_observation(profile,token,qualification_request):
    if type(token) is not _RootCopyLedgerObservation or token not in _observations:_fail('COPY_LEDGER_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,runtime_manifest,toolkit_manifest,original=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(original):_fail('COPY_LEDGER_COLLECTOR_OBSERVATION_CHANGED')
    assert_reader_profile_extension(original,profile)
    p,root=_context(original,qualification_request);target,target_root=_context(profile,qualification_request)
    _materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    _materials(target,target_root,runtime_manifest,toolkit_manifest,qualification_request)
    fixture=_FixtureDirectory(p,token.fixture_path)
    try:
        raw=fixture.read()
        if raw.decode('utf-8',errors='strict')!=token.evidence_json:_fail('COPY_LEDGER_COLLECTOR_OBSERVATION_CHANGED')
        output=_json(raw,LIMIT);comparison=compare_copy_ledger_cases(p,output)
        if output['uid']!=0 or output['euid']!=0 or output['runtime_uid']!=1027 or output['production_copy'] is not True:
            _fail('COPY_LEDGER_COLLECTOR_PHYSICAL_CONTEXT_CHANGED')
        return {'schema':'RBRIDGE_ROOT_COPY_LEDGER_OBSERVATION_V1','scope':'ROOT_PROTECTED_COPY_LEDGER_FIXTURE_PRODUCER',
            'status':'PASS','original_profile_sha256':token.profile_sha256,'profile_sha256':report_sha256(target),
            'evidence_sha256':hashlib.sha256(raw).hexdigest(),'output':output,'cases':comparison['cases'],
            'full_privileged_qualification':'INCOMPLETE','may_execute':False,'service_action_authorized':False}
    finally:fixture.close()
