"""Protected issuer custody for cold preparation, never serialized PASS authority.

Only a genuine live Root issuer may seal its complete evidence with a new secret
in a fixed protected signing-key store, separate from caller-named evidence. Cold verification requires protected key and
capsule bytes, the exact locator, the domain-separated MAC, all original evidence
and current actual Root namespace/account/immutable material. Original live
objects are not reconstructed: this is a distinct private sealed-custody origin.
No custody operation observes current production eligibility or grants a switch.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import weakref
from .artifact import ArtifactEntry,ArtifactManifest,validate_manifest,_identity
from .artifact_collector import _closure
from .bootstrap_fixture_collector import _module
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .host_backend import _protected_bytes
from .models import InstallationError,encode_report,report_sha256
from .owned_process import assert_owned_helpers_settled
from .profile import parse_profile
from .protected_copy import PublishedArtifact,FILE_FLAGS,DIR_FLAGS,ProtectedParent,FilesystemAuthority,_same
from .qualification import _QualifiedBundle,_bundle_pin,_qualified,verify_qualification_bundle,_source,_artifact,_readers,_privileged
from .qualification_issuer import _registered as _issuer_registered,_evidence
from .readonly_helper import _json


class QualificationCustodyError(InstallationError):pass
def _fail(reason):raise QualificationCustodyError(reason)


DOMAIN=b'RBRIDGE_ROOT_QUALIFICATION_CUSTODY_V1\x00'
_origins=weakref.WeakKeyDictionary()


def _hash(value):return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None


def _locator(p,value):
    fields={'schema','directory','profile_sha256','bundle_pin','evidence_sha256','capsule_sha256','request_sha256'}
    if (type(value) is not dict or set(value)!=fields or value['schema']!='RBRIDGE_QUALIFICATION_CUSTODY_LOCATOR_V1'
            or type(value['directory']) is not str or re.fullmatch(r'/root/\.rbridge-privileged-[0-9a-f]{32}',value['directory']) is None
            or any(not _hash(value[k]) for k in fields-{'schema','directory'})
            or value['profile_sha256']!=report_sha256(p)):_fail('QUALIFICATION_CUSTODY_LOCATOR_INVALID')
    return value


def compare_custody_bytes(profile,locator,capsule_raw,evidence_raw,key,key_identity,qualification_request):
    """Pure Source byte predicate. Caller-owned keys authenticate no Root origin."""
    p=parse_profile(json.loads(encode_report(profile)));locator=_locator(p,locator)
    if (type(key) is not bytes or len(key)!=32 or type(capsule_raw) is not bytes or not 0<len(capsule_raw)<=65536
            or type(evidence_raw) is not bytes or not 0<len(evidence_raw)<=p.budget.carrier_bytes):
        _fail('QUALIFICATION_CUSTODY_BYTES_INVALID')
    value=_json(capsule_raw,65536);evidence=_json(evidence_raw,p.budget.carrier_bytes)
    fields={'schema','scope','directory','profile_sha256','toolkit_manifest_sha256','bundle_pin','evidence_sha256',
        'qualification_request','key_sha256','key_identity','mac_sha256'}
    if (type(value) is not dict or set(value)!=fields or encode_report(value)!=capsule_raw
            or type(evidence) is not dict or encode_report(evidence)!=evidence_raw
            or value['schema']!='RBRIDGE_ROOT_QUALIFICATION_CUSTODY_V1'
            or value['scope']!='ROOT_ISSUER_CUSTODY_PREPARATION_ONLY'
            or value['toolkit_manifest_sha256']!=p.toolkit.manifest_sha256
            or any(not _hash(value[k]) for k in ('profile_sha256','bundle_pin','evidence_sha256','key_sha256','mac_sha256'))
            or type(value['key_identity']) is not list or len(value['key_identity'])!=9
            or any(type(x) is not str or re.fullmatch('0|[1-9][0-9]{0,24}',x) is None for x in value['key_identity'])
            or encode_report(value['key_identity'])!=encode_report(key_identity)
            or type(value['qualification_request']) is not dict or set(value['qualification_request'])!={'python_closure_sha256'}
            or not _hash(value['qualification_request']['python_closure_sha256'])
            or encode_report(value['qualification_request'])!=encode_report(qualification_request)
            or report_sha256(qualification_request)!=locator['request_sha256']
            or hashlib.sha256(key).hexdigest()!=value['key_sha256']
            or hashlib.sha256(capsule_raw).hexdigest()!=locator['capsule_sha256']
            or hashlib.sha256(evidence_raw).hexdigest()!=locator['evidence_sha256']
            or any(value[k]!=locator[k] for k in ('directory','profile_sha256','bundle_pin','evidence_sha256'))):
        _fail('QUALIFICATION_CUSTODY_BYTES_CHANGED')
    body={k:v for k,v in value.items() if k!='mac_sha256'}
    if not hmac.compare_digest(hmac.digest(key,DOMAIN+encode_report(body),'sha256').hex(),value['mac_sha256']):
        _fail('QUALIFICATION_CUSTODY_MAC_INVALID')
    return {'schema':'RBRIDGE_QUALIFICATION_CUSTODY_COMPARISON_V1','scope':'QUALIFICATION_CUSTODY_BYTES_ONLY',
        'status':'PASS','capsule':value,'physical_origin':'UNQUALIFIED','may_execute':False,'service_action_authorized':False}


def _write_immutable(fd,name,raw):
    """Create-only byte mechanics. This helper itself grants no Root custody."""
    if (name not in ('custody.key','custody.json') and re.fullmatch(r'custody-[0-9a-f]{64}\.key',name) is None
            or type(raw) is not bytes or not 0<len(raw)<=65536):
        _fail('QUALIFICATION_CUSTODY_FILE_INVALID')
    handle=None
    try:
        handle=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=fd)
        before=os.fstat(handle)
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.geteuid() or before.st_nlink!=1:
            _fail('QUALIFICATION_CUSTODY_FILE_UNPROTECTED')
        view=memoryview(raw)
        while view:
            count=os.write(handle,view)
            if count<=0:_fail('QUALIFICATION_CUSTODY_WRITE_FAILED')
            view=view[count:]
        os.fchmod(handle,0o400);os.fsync(handle)
        final=os.fstat(handle)
        if (not stat.S_ISREG(final.st_mode) or final.st_uid!=os.geteuid() or final.st_nlink!=1
                or final.st_mode&0o7777!=0o400 or final.st_size!=len(raw)
                or _identity(final)!=_identity(os.stat(name,dir_fd=fd,follow_symlinks=False))):
            _fail('QUALIFICATION_CUSTODY_FILE_CHANGED')
        os.fsync(fd)
    except OSError:_fail('QUALIFICATION_CUSTODY_FILE_UNAVAILABLE')
    finally:
        if handle is not None:os.close(handle)


def _read_immutable(fd,name,limit,uid):
    if (name not in ('custody.key','custody.json') and re.fullmatch(r'custody-[0-9a-f]{64}\.key',name) is None
            or type(limit) is not int or not 1<=limit<=65536):
        _fail('QUALIFICATION_CUSTODY_FILE_INVALID')
    handle=None
    try:
        handle=os.open(name,FILE_FLAGS,dir_fd=fd);before=os.fstat(handle)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=uid or before.st_nlink!=1
                or before.st_mode&0o7777!=0o400 or not 0<before.st_size<=limit):_fail('QUALIFICATION_CUSTODY_FILE_UNPROTECTED')
        raw=bytearray()
        while len(raw)<=limit:
            part=os.read(handle,min(65536,limit+1-len(raw)))
            if not part:break
            raw.extend(part)
        if (len(raw)!=before.st_size or _identity(before)!=_identity(os.fstat(handle))
                or _identity(before)!=_identity(os.stat(name,dir_fd=fd,follow_symlinks=False))):
            _fail('QUALIFICATION_CUSTODY_FILE_CHANGED')
        return bytes(raw),list(map(str,_identity(before)))
    except OSError:_fail('QUALIFICATION_CUSTODY_FILE_UNAVAILABLE')
    finally:
        if handle is not None:os.close(handle)


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/qualification_custody.py'):
        _fail('QUALIFICATION_CUSTODY_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


class _SigningKeys:
    """Fixed Root anchor outside carrier, release and maintenance inventory.

    The caller's locator cannot select a key or its parent. Only the original
    live issuer can create a new per-profile key; an existing key is never
    accepted for initialization, overwritten or exported with the evidence.
    """
    def __init__(self,profile,request,*,create=False,bundle=None):
        self.parent=None;self.fd=None;self.bundle=bundle;self.creating=create
        self.p,_root=_context(profile,request);self.request=request
        if create:
            _row,original=_issuer_registered(self.p,bundle)
            if encode_report(original)!=encode_report(request):_fail('QUALIFICATION_CUSTODY_REQUEST_CHANGED')
            verify_qualification_bundle(self.p,bundle)
        self.name='custody-'+report_sha256(self.p)+'.key'
        try:
            self.parent=ProtectedParent(FilesystemAuthority(0,self.p.binding.uid,Path('/root'),'RUNTIME'))
            if create:
                try:os.mkdir('.rbridge-qualification-keys',0o700,dir_fd=self.parent.fd);os.fsync(self.parent.fd)
                except FileExistsError:pass
            before=os.stat('.rbridge-qualification-keys',dir_fd=self.parent.fd,follow_symlinks=False)
            self.fd=os.open('.rbridge-qualification-keys',DIR_FLAGS,dir_fd=self.parent.fd);self.identity=os.fstat(self.fd)
            if not _same(before,self.identity):_fail('QUALIFICATION_CUSTODY_KEY_PARENT_CHANGED')
            self.check()
        except BaseException:self.close();raise
    def check(self):
        self.parent.check();named=os.stat('.rbridge-qualification-keys',dir_fd=self.parent.fd,follow_symlinks=False)
        row=os.fstat(self.fd)
        if (not _same(row,self.identity) or not _same(named,self.identity) or not stat.S_ISDIR(row.st_mode)
                or row.st_uid!=0 or row.st_mode&0o7777!=0o700):_fail('QUALIFICATION_CUSTODY_KEY_PARENT_CHANGED')
    def create(self,key):
        if self.creating is not True:_fail('QUALIFICATION_CUSTODY_KEY_CREATION_UNQUALIFIED')
        _context(self.p,self.request);_issuer_registered(self.p,self.bundle);verify_qualification_bundle(self.p,self.bundle)
        self.check();_write_immutable(self.fd,self.name,key);self.check()
    def read(self):
        self.check();raw,identity=_read_immutable(self.fd,self.name,32,0);self.check();return raw,identity
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None
        if self.parent is not None:self.parent.close();self.parent=None


def _manifest(value):
    try:
        result=ArtifactManifest(**{**value,'entries':tuple(ArtifactEntry(**row) for row in value['entries'])})
        validate_manifest(result);return result
    except (ValueError,TypeError,KeyError):_fail('QUALIFICATION_CUSTODY_MANIFEST_INVALID')


def _material_bundle(p,root,evidence,request):
    value=evidence['material'];runtime_manifest=_manifest(value['runtime_manifest']);toolkit_manifest=_manifest(value['toolkit_manifest'])
    _closure(p,root,runtime_manifest,toolkit_manifest,request)
    required={'ops/install/rbridge_installation/qualification_custody.py','ops/install/rbridge_installation/qualification_issuer.py'}
    if not required<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('QUALIFICATION_CUSTODY_ENTRY_UNQUALIFIED')
    material={'schema':'RBRIDGE_ROOT_QUALIFICATION_MATERIAL_V1','scope':'ROOT_PRESERVED_QUALIFICATION_MATERIAL','status':'PASS',
        'profile_sha256':report_sha256(p),'base_profile_sha256':evidence['base_profile_sha256'],
        'evidence_sha256':evidence['material_evidence_sha256'],'evidence':value,'installation_authority':False,
        'may_execute':False,'service_action_authorized':False}
    if encode_report(_evidence(p,material,evidence['review']))!=encode_report(evidence):_fail('QUALIFICATION_CUSTODY_EVIDENCE_CHANGED')
    rows=value['observations'];_source(p,rows['source_ci']['source']);_artifact(p,rows['artifact']['artifact'])
    _readers(p,rows['readers']['readers']);_privileged(parse_profile(value['base_profile']),rows['privileged']['qualification'])
    pins=evidence['preparation_pins'];helper=next(e for e in toolkit_manifest.entries if e.path=='dist/server/cli/rbridgeInstallationAudit.js')
    if helper.kind!='FILE' or helper.sha256!=pins['helper_sha256']:_fail('QUALIFICATION_CUSTODY_HELPER_CHANGED')
    canary=_protected_bytes(p.paths.canary_path,4096)
    if base64.b64encode(canary).decode()!=value['canary_base64']:_fail('QUALIFICATION_CUSTODY_CANARY_CHANGED')
    module,payload=_module(p,root,runtime_manifest,toolkit_manifest,request)
    publication=value['observations']['bootstrap_execution']['evidence']['publication']
    raw,identity=module._protected_file(Path(publication['path']),49152,0o400)
    if raw!=payload or identity!=publication['identity']:_fail('QUALIFICATION_CUSTODY_BOOTSTRAP_CHANGED')
    artifact=PublishedArtifact(Path(p.paths.release_parent)/p.runtime.source_sha,
        runtime_manifest.sha256,runtime_manifest.source_sha,'ROOT_DESCRIPTOR_PUBLICATION')
    return _QualifiedBundle(p,artifact,runtime_manifest,toolkit_manifest,pins['readers_sha256'],pins['reader_context_sha256'],
        pins['helper_sha256'],canary,pins['python_closure_sha256'],report_sha256(evidence))


def _load(profile,locator,request):
    p,root=_context(profile,request);locator=_locator(p,locator)
    fixture=_FixtureDirectory(p,locator['directory'],prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        if set(os.listdir(fixture.fd))!={'evidence.json','custody.json'}:_fail('QUALIFICATION_CUSTODY_FILE_SET_CHANGED')
        evidence_raw=fixture.read();capsule_raw,_capsule_identity=_read_immutable(fixture.fd,'custody.json',65536,0)
        keys=_SigningKeys(p,request)
        try:
            key,key_identity=keys.read()
            comparison=compare_custody_bytes(p,locator,capsule_raw,evidence_raw,key,key_identity,request)
            evidence=_json(evidence_raw,p.budget.carrier_bytes);bundle=_material_bundle(p,root,evidence,request)
            if _bundle_pin(bundle)!=comparison['capsule']['bundle_pin']:_fail('QUALIFICATION_CUSTODY_BUNDLE_CHANGED')
            assert_owned_helpers_settled();fixture.check()
            if (fixture.read()!=evidence_raw or _read_immutable(fixture.fd,'custody.json',65536,0)[0]!=capsule_raw
                    or keys.read()!=(key,key_identity)):_fail('QUALIFICATION_CUSTODY_FILE_CHANGED')
            return bundle,evidence_raw
        finally:keys.close()
    finally:fixture.close()


def seal_root_qualification_bundle(profile,bundle,qualification_request):
    p,_root=_context(profile,qualification_request);row,request=_issuer_registered(p,bundle)
    if (encode_report(request)!=encode_report(qualification_request) or set(request)!={'python_closure_sha256'}
            or request['python_closure_sha256']!=bundle.python_closure_sha256):_fail('QUALIFICATION_CUSTODY_REQUEST_CHANGED')
    verify_qualification_bundle(p,bundle)
    fixture=_FixtureDirectory(p,row[9],prefix='.rbridge-privileged-',limit=p.budget.carrier_bytes)
    try:
        if set(os.listdir(fixture.fd))!={'evidence.json'}:_fail('QUALIFICATION_CUSTODY_ALREADY_EXISTS')
        raw=fixture.read()
        if raw.decode()!=row[8] or hashlib.sha256(raw).hexdigest()!=bundle.evidence_sha256:
            _fail('QUALIFICATION_CUSTODY_EVIDENCE_CHANGED')
        keys=_SigningKeys(p,request,create=True,bundle=bundle)
        try:
            key=secrets.token_bytes(32);keys.create(key);observed,identity=keys.read()
            if observed!=key:_fail('QUALIFICATION_CUSTODY_KEY_CHANGED')
        finally:keys.close()
        body={'schema':'RBRIDGE_ROOT_QUALIFICATION_CUSTODY_V1','scope':'ROOT_ISSUER_CUSTODY_PREPARATION_ONLY',
            'directory':str(fixture.path),'profile_sha256':report_sha256(p),'toolkit_manifest_sha256':p.toolkit.manifest_sha256,
            'bundle_pin':_bundle_pin(bundle),'evidence_sha256':bundle.evidence_sha256,'qualification_request':request,
            'key_sha256':hashlib.sha256(key).hexdigest(),'key_identity':identity}
        capsule=encode_report({**body,'mac_sha256':hmac.digest(key,DOMAIN+encode_report(body),'sha256').hex()})
        _write_immutable(fixture.fd,'custody.json',capsule);fixture.check()
        locator={'schema':'RBRIDGE_QUALIFICATION_CUSTODY_LOCATOR_V1','directory':str(fixture.path),
            'profile_sha256':body['profile_sha256'],'bundle_pin':body['bundle_pin'],'evidence_sha256':body['evidence_sha256'],
            'capsule_sha256':hashlib.sha256(capsule).hexdigest(),'request_sha256':report_sha256(request)}
        _load(p,locator,request);verify_qualification_bundle(p,bundle);fixture.check()
        return locator
    finally:fixture.close()


def open_root_qualification_custody(profile,locator,qualification_request):
    bundle,raw=_load(profile,locator,qualification_request);pin=_bundle_pin(bundle)
    _origins[bundle]=(pin,bundle.profile,bundle.runtime_manifest,bundle.toolkit_manifest,bundle.runtime_artifact,
        encode_report(locator).decode(),encode_report(qualification_request).decode(),raw.decode())
    _qualified[bundle]=pin
    try:return verify_qualification_bundle(bundle.profile,bundle)
    except BaseException:
        _origins.pop(bundle,None);_qualified.pop(bundle,None);raise


def _registered(profile,bundle):
    if type(bundle) is not _QualifiedBundle or bundle not in _origins:_fail('QUALIFICATION_ISSUER_ORIGIN_UNQUALIFIED')
    row=_origins[bundle]
    if type(row) is not tuple or len(row)!=8:_fail('QUALIFICATION_CUSTODY_ORIGIN_CHANGED')
    pin,p,rm,tm,artifact,locator_json,request_json,evidence_json=row
    if (report_sha256(profile)!=report_sha256(p) or report_sha256(bundle.profile)!=report_sha256(p)
            or _bundle_pin(bundle)!=pin or bundle.runtime_manifest is not rm or bundle.toolkit_manifest is not tm
            or bundle.runtime_artifact is not artifact):_fail('QUALIFICATION_CUSTODY_ORIGIN_CHANGED')
    locator=_json(locator_json.encode(),65536);request=_json(request_json.encode(),65536)
    if (encode_report(locator).decode()!=locator_json or encode_report(request).decode()!=request_json
            or hashlib.sha256(evidence_json.encode()).hexdigest()!=bundle.evidence_sha256
            or request!={'python_closure_sha256':bundle.python_closure_sha256}
            or locator.get('bundle_pin')!=pin or locator.get('evidence_sha256')!=bundle.evidence_sha256
            or locator.get('request_sha256')!=report_sha256(request)):
        _fail('QUALIFICATION_CUSTODY_ORIGIN_CHANGED')
    _locator(p,locator)
    return row,locator,request


def verify_root_custody_origin(profile,bundle):
    row,locator,request=_registered(profile,bundle)
    pin,p,_rm,_tm,_artifact,_locator_json,_request_json,evidence_json=row
    current,raw=_load(p,locator,request)
    if _bundle_pin(current)!=pin or raw.decode()!=evidence_json or _registered(profile,bundle)[0]!=row:
        _fail('QUALIFICATION_CUSTODY_ORIGIN_CHANGED')
    return bundle
