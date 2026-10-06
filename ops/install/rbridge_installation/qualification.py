"""Qualification completeness is separate from physical Root execution authority.

Full data comparisons preserve useful source evidence without upgrading a PASS
label, rehashed document or CI Node version to a privileged proof. The concrete
physical collector must privately register a bundle before preparation can use
it; no public constructor or serialized scope string performs that registration.
"""
from dataclasses import dataclass
import base64
import hashlib
import json
from pathlib import Path
import re
from types import MappingProxyType
import weakref
from .models import InstallationError,encode_report,report_sha256,validate_contract


class QualificationError(InstallationError):pass


@dataclass(frozen=True)
class QualificationProofs:
    source:object=None
    artifact:object=None
    readers:object=None
    privileged:object=None
    imports:object=None
    review:object=None
    bootstrap:object=None


@dataclass(frozen=True)
class QualificationAssessment:
    schema:str
    status:str
    scope:str
    command_ready:bool
    profile_sha256:str
    checks:object
    reason_codes:tuple
    evidence_sha256:str


def _fail(reason):raise QualificationError(reason)


def _hash(value):return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None


def _base64(value,limit):
    if type(value) is not str or len(value)>((limit+2)//3)*4:_fail('QUALIFICATION_BYTES_INVALID')
    try:raw=base64.b64decode(value,validate=True)
    except (ValueError,TypeError):_fail('QUALIFICATION_BYTES_INVALID')
    if len(raw)>limit or base64.b64encode(raw).decode()!=value:_fail('QUALIFICATION_BYTES_INVALID')
    return raw


def _source(profile,value):
    required={'schema','scope','commit','tree','run_id','conclusion','node_version','steps','log_base64','log_sha256'}
    steps={'installation_tests','tests','typecheck','lint','build','public_scrub','tracked_clean'}
    if (type(value) is not dict or set(value)!=required or value['schema']!='RBRIDGE_SOURCE_QUALIFICATION_V1'
            or value['scope']!='SOURCE_QUALIFICATION_ONLY' or value['commit']!=profile.toolkit.source_sha
            or value['tree']!=profile.toolkit.tree_sha or type(value['run_id']) is not int or not 1<=value['run_id']<=9007199254740991
            or value['conclusion']!='success' or type(value['node_version']) is not str
            or not re.fullmatch(r'22\.[0-9]+\.[0-9]+',value['node_version'])
            or type(value['steps']) is not dict or set(value['steps'])!=steps
            or any(v!='success' for v in value['steps'].values())):_fail('QUALIFICATION_SOURCE_INVALID')
    log=_base64(value['log_base64'],67108864)
    if not log or hashlib.sha256(log).hexdigest()!=value['log_sha256']:_fail('QUALIFICATION_SOURCE_LOG_INVALID')
    log.decode('utf-8',errors='strict')
    return 'PASS'


def _artifact(profile,value):
    if type(value) is not dict or set(value)!={'report','receipts'}:_fail('QUALIFICATION_ARTIFACT_PROOF_INCOMPLETE')
    report=value['report']
    required={'schema','status','reason_codes','runtimeVersion','actualNodeSHA256','runtimeManifestSHA256',
        'toolkitManifestSHA256','sourceSHA','toolkitSHA','scope','ownerBoot','mcpBoot','executedFixture','fixtureReceiptsSHA256'}
    if (type(report) is not dict or set(report)!=required or report['schema']!='RBRIDGE_INSTALL_ARTIFACT_QUALIFICATION_V1'
            or report['status']!='PASS' or report['reason_codes']!=[]
            or report['scope']!='ISOLATED_FINAL_ARTIFACT_OWNER_IPC_MCP_HELPER'
            or report['runtimeVersion']!=profile.runtime.node_version or report['actualNodeSHA256']!=profile.runtime.node_sha256
            or report['runtimeManifestSHA256']!=profile.runtime.manifest_sha256
            or report['toolkitManifestSHA256']!=profile.toolkit.manifest_sha256
            or report['sourceSHA']!=profile.runtime.source_sha or report['toolkitSHA']!=profile.toolkit.source_sha
            or report['ownerBoot']!='PASS' or report['mcpBoot']!='PASS' or report['executedFixture'] is not True
            or report_sha256(value['receipts'])!=report['fixtureReceiptsSHA256']):_fail('QUALIFICATION_ARTIFACT_INVALID')
    return 'PASS'


def _readers(profile,value):
    if type(value) is not dict or set(value)!={'report','registry'}:_fail('QUALIFICATION_READERS_PROOF_INCOMPLETE')
    report=value['report'];registry=value['registry']
    validate_contract(report,'ReaderQualificationReport');validate_contract(registry,'ReaderRegistry')
    if (report['schema']!='RBRIDGE_READER_QUALIFICATION_V1' or report['actualAcceptance']!='PASS'
            or report['referenceAcceptance']!='PASS' or report['reason_codes']!=[]
            or encode_report(registry['readers'])!=encode_report(profile.readers)
            or not profile.readers or {r.transport for r in profile.readers}!={'GITHUB','MCP'}):
        _fail('QUALIFICATION_READERS_INVALID')
    for registration in profile.readers:
        rows=[r for r in report['invocations'] if r['reader_id']==registration.reader_id]
        cases={'C0'+str(n) for n in range(1,9)} if registration.transport=='GITHUB' else {'C09'}
        if (not rows or {r['case_id'] for r in rows}!=cases or report_sha256(rows)!=registration.qualification_sha256
                or any(r['scope']!='QUALIFIED_INSTALLED_READER' for r in rows)):_fail('QUALIFICATION_READERS_INCOMPLETE')
        for row in rows:
            for key,digest in (('input_json','input_sha256'),('verdict_json','output_sha256')):
                if hashlib.sha256(row[key].encode('utf-8',errors='strict')).hexdigest()!=row[digest]:
                    _fail('QUALIFICATION_READER_PREIMAGE_CHANGED')
    return 'PASS'


def _privileged(_profile,value):
    required={'schema','scope','status','uid','euid','runtime_uid','production_changed','cases'}
    cases={'copy','ledger_crash','config_cas','fake_unit_stop','owned_helper_family','bootstrap'}
    if (type(value) is not dict or set(value)!=required or value['schema']!='RBRIDGE_ROOT_FIXTURE_QUALIFICATION_V1'
            or value['scope']!='ISOLATED_ROOT_FIXTURES_ONLY' or value['status']!='PASS'
            or type(value['uid']) is not int or value['uid']!=0 or type(value['euid']) is not int or value['euid']!=0
            or type(value['runtime_uid']) is not int or value['runtime_uid']!=1027 or value['production_changed'] is not False
            or type(value['cases']) is not dict or set(value['cases'])!=cases):_fail('QUALIFICATION_ROOT_FIXTURES_INCOMPLETE')
    for result in value['cases'].values():
        if (type(result) is not dict or set(result)!={'status','input_json','output_json','input_sha256','output_sha256'}
                or result['status']!='PASS' or any(type(result[k]) is not str for k in ('input_json','output_json'))
                or any(hashlib.sha256(result[k].encode()).hexdigest()!=result[h]
                    for k,h in (('input_json','input_sha256'),('output_json','output_sha256')))):
            _fail('QUALIFICATION_ROOT_FIXTURE_PREIMAGE_CHANGED')
    return 'PASS'


def build_qualification(profile,proofs):
    """Bounded data assessment; collecting physical origin is a separate step."""
    if type(proofs) is not QualificationProofs:_fail('QUALIFICATION_INPUTS_UNQUALIFIED')
    checks={};reasons=[]
    predicates={'source':_source,'artifact':_artifact,'readers':_readers,'privileged':_privileged}
    for name,predicate in predicates.items():
        value=getattr(proofs,name)
        checks[name]='UNKNOWN'
        if value is not None:
            try:
                if len(encode_report(value))>67108864:_fail('QUALIFICATION_EVIDENCE_BYTE_LIMIT')
                checks[name]=predicate(profile,value)
            except (ValueError,TypeError,KeyError,AttributeError,UnicodeError,RecursionError):checks[name]='FAIL'
        if checks[name]!='PASS':reasons.append('QUALIFICATION_ACTUAL_READERS_UNKNOWN' if name=='readers' else 'QUALIFICATION_'+name.upper()+'_UNKNOWN')
    # These sections require protected interpreter/reviewed bootstrap origin.
    # Data supplied to an assessment cannot claim a qualified execution closure.
    for name in ('imports','review','bootstrap'):checks[name]='UNKNOWN';reasons.append('QUALIFICATION_'+name.upper()+'_UNKNOWN')
    reasons.append('QUALIFICATION_PHYSICAL_ORIGIN_UNQUALIFIED')
    return QualificationAssessment('RBRIDGE_INSTALL_QUALIFICATION_ASSESSMENT_V1','BLOCKED',
        'QUALIFICATION_COMPLETENESS_ONLY',False,report_sha256(profile),MappingProxyType(checks),tuple(reasons),report_sha256(proofs))


@dataclass(frozen=True,eq=False)
class _QualifiedBundle:
    profile:object
    runtime_artifact:object
    runtime_manifest:object
    toolkit_manifest:object
    readers_sha256:str
    helper_sha256:str
    canary_bytes:bytes
    evidence_sha256:str


_qualified=weakref.WeakKeyDictionary()


def verify_qualification_bundle(profile,bundle):
    # A serialized report, assessment or caller-created instance never enters
    # this registry. Only the concrete physical collector can issue a token.
    if type(bundle) is not _QualifiedBundle or bundle not in _qualified:
        _fail('QUALIFICATION_PHYSICAL_ORIGIN_UNQUALIFIED')
    from .host_backend import _assert_kernel_namespace
    from .protected_copy import verify_published,FilesystemAuthority
    import os
    if os.getuid()!=0 or os.geteuid()!=0:_fail('QUALIFICATION_ROOT_REQUIRED')
    _assert_kernel_namespace()
    if report_sha256(profile)!=report_sha256(bundle.profile) or bundle.evidence_sha256!=_qualified[bundle]:
        _fail('QUALIFICATION_BUNDLE_CHANGED')
    for manifest in (bundle.runtime_manifest,bundle.toolkit_manifest):
        name=manifest.source_sha if manifest.kind=='RUNTIME' else 'toolkit-'+manifest.source_sha
        authority=FilesystemAuthority(0,profile.binding.uid,Path(profile.paths.release_parent),manifest.kind,True,
            manifest.sha256,manifest.source_sha,manifest.tree_sha)
        verify_published(Path(profile.paths.release_parent)/name,manifest,authority)
    return bundle


def qualified_owner_command(bundle):
    verify_qualification_bundle(getattr(bundle,'profile',None),bundle)
    # The collector must additionally issue the exact reviewed bootstrap command;
    # physical artifact/reader qualification alone never grants a service switch.
    _fail('QUALIFICATION_REVIEWED_BOOTSTRAP_COMMAND_MISSING')


def _bundle_authorization(bundle,authorization):
    from datetime import datetime,timezone
    from .transaction import SwitchAuthorization
    p=bundle.profile
    if (type(authorization) is not SwitchAuthorization or authorization.purpose!='OWNER_PRESENT_PRODUCTION_SWITCH'
            or authorization.owner_present is not True or type(authorization.transaction_id) is not str
            or not re.fullmatch('[0-9a-f]{32}',authorization.transaction_id)):
        _fail('QUALIFICATION_SWITCH_AUTHORIZATION_MISSING')
    expected={'profile_sha256':report_sha256(p),'runtime_manifest_sha256':bundle.runtime_manifest.sha256,
        'toolkit_manifest_sha256':bundle.toolkit_manifest.sha256,'readers_sha256':bundle.readers_sha256,
        'helper_sha256':bundle.helper_sha256}
    if any(getattr(authorization,key)!=value for key,value in expected.items()):_fail('QUALIFICATION_SWITCH_AUTHORIZATION_DRIFT')
    try:
        expires=datetime.fromisoformat(authorization.expires_at.replace('Z','+00:00'));now=datetime.now(timezone.utc)
        if expires.tzinfo is None or not 0<(expires-now).total_seconds()<=p.budget.maintenance_ms/1000:raise ValueError()
    except (ValueError,TypeError,AttributeError):_fail('QUALIFICATION_SWITCH_AUTHORIZATION_EXPIRED')


def open_qualified_transaction_ledger(bundle,authorization):
    """Create an authorized new ledger while holding the shared foreground lock.

    This short lock protects inventory plus creation. The subsequent pause must
    reacquire it and recheck the entire registry before any service action. Death
    between these steps leaves an unfinished ledger which blocks another install.
    """
    verify_qualification_bundle(getattr(bundle,'profile',None),bundle)
    _bundle_authorization(bundle,authorization)
    import fcntl
    import os
    import stat
    from .artifact import _identity
    from .ledger import open_ledger
    from .protected_copy import ProtectedParent,FilesystemAuthority
    from .maintenance_registry import assert_no_unfinished_transactions
    p=bundle.profile
    if p.paths.ledger_parent!='/var/lib/rbridge-maintenance' or p.paths.lock_path!='/run/rbridge-installation.lock':
        _fail('QUALIFICATION_MAINTENANCE_PATHS_UNQUALIFIED')
    parent=ProtectedParent(FilesystemAuthority(0,p.binding.uid,Path(p.paths.ledger_parent),'RUNTIME'))
    lock_parent=None;handle=None;ledger=None;complete=False
    try:
        path=Path(p.paths.lock_path)
        lock_parent=ProtectedParent(FilesystemAuthority(0,p.binding.uid,path.parent,'RUNTIME'))
        flags=os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK
        try:
            handle=os.open(path.name,flags|os.O_CREAT|os.O_EXCL,0o600,dir_fd=lock_parent.fd)
            os.fsync(handle);os.fsync(lock_parent.fd)
        except FileExistsError:handle=os.open(path.name,flags,dir_fd=lock_parent.fd)
        row=os.fstat(handle)
        if not stat.S_ISREG(row.st_mode) or row.st_uid!=0 or row.st_mode&0o7777!=0o600 or row.st_nlink!=1:
            _fail('QUALIFICATION_MAINTENANCE_LOCK_UNPROTECTED')
        fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        def check():
            parent.check();lock_parent.check()
            if (_identity(row)!=_identity(os.fstat(handle))
                    or _identity(row)!=_identity(os.stat(path.name,dir_fd=lock_parent.fd,follow_symlinks=False))):
                _fail('QUALIFICATION_MAINTENANCE_LOCK_CHANGED')
        check();assert_no_unfinished_transactions(parent.fd)
        _bundle_authorization(bundle,authorization);check()
        ledger=open_ledger(parent.fd,authorization.transaction_id,mode='create_only')
        if ledger.read().entries:_fail('QUALIFICATION_NEW_LEDGER_NOT_EMPTY')
        assert_no_unfinished_transactions(parent.fd,ledger);check()
        complete=True;return ledger
    except OSError:_fail('QUALIFICATION_MAINTENANCE_OWNERSHIP_UNCERTAIN')
    finally:
        if ledger is not None and not complete:ledger.close()
        if handle is not None:os.close(handle)
        if lock_parent is not None:lock_parent.close()
        parent.close()


def open_qualified_resume_ledger(bundle,transaction_id):
    """Open the exact existing private chain; never create missing recovery state."""
    verify_qualification_bundle(getattr(bundle,'profile',None),bundle)
    if type(transaction_id) is not str or not re.fullmatch('[0-9a-f]{32}',transaction_id):_fail('QUALIFICATION_RESUME_ID_INVALID')
    from .ledger import open_ledger
    from .protected_copy import ProtectedParent,FilesystemAuthority
    p=bundle.profile
    if p.paths.ledger_parent!='/var/lib/rbridge-maintenance':_fail('QUALIFICATION_MAINTENANCE_PATHS_UNQUALIFIED')
    parent=ProtectedParent(FilesystemAuthority(0,p.binding.uid,Path(p.paths.ledger_parent),'RUNTIME'))
    ledger=None;complete=False
    try:
        ledger=open_ledger(parent.fd,transaction_id,mode='existing_only');snapshot=ledger.read()
        expected={'profile_sha256':report_sha256(p),'runtime_manifest_sha256':bundle.runtime_manifest.sha256,
            'toolkit_manifest_sha256':bundle.toolkit_manifest.sha256,'readers_sha256':bundle.readers_sha256}
        if (not snapshot.entries or snapshot.entries[0].marker!='QUALIFIED'
                or dict(snapshot.entries[0].evidence)!=expected):_fail('QUALIFICATION_RESUME_PINS_CHANGED')
        parent.check();complete=True;return ledger
    finally:
        if ledger is not None and not complete:ledger.close()
        parent.close()


def verify_import_closure(toolkit_root,profile,qualification_request):
    """Observe the running isolated interpreter and every allowed import byte.

    The closure digest is a reviewed private owner-command pin, not a hash taken
    from an untrusted file. This observation alone still grants no service action.
    """
    import os
    import sys
    from .profile import parse_profile
    from .host_backend import _assert_kernel_namespace,_protected_bytes,_kernel_bytes
    from .readonly_helper import _json
    from .python_closure import verify_python_closure_tree,validate_python_closure
    p=parse_profile(json.loads(encode_report(profile)));root=Path(toolkit_root)
    expected_root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (root!=expected_root or os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or any(k.startswith('PYTHON') and v for k,v in os.environ.items())
            or type(qualification_request) is not dict or not _hash(qualification_request.get('python_closure_sha256'))):
        _fail('QUALIFICATION_PYTHON_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();pin=qualification_request['python_closure_sha256']
    path=Path(p.paths.ledger_parent)/('python-closure-'+pin+'.json')
    raw=_protected_bytes(path,67108864);manifest=_json(raw)
    if encode_report(manifest)!=raw:_fail('QUALIFICATION_PYTHON_MANIFEST_NOT_CANONICAL')
    entries=validate_python_closure(manifest,pin)
    if (manifest['python_version']!=p.toolkit.python_version or sys.version.split()[0]!=p.toolkit.python_version
            or manifest['interpreter_path']!=p.toolkit.python_path or manifest['interpreter_sha256']!=p.toolkit.python_sha256
            or os.readlink('/proc/self/exe')!=p.toolkit.python_path
            or hashlib.sha256(_protected_bytes(p.toolkit.python_path,268435456)).hexdigest()!=p.toolkit.python_sha256):
        _fail('QUALIFICATION_PYTHON_INTERPRETER_CHANGED')
    proof=verify_python_closure_tree(manifest,pin)
    directories={path for path,row in entries.items() if row['kind']=='DIRECTORY'}
    files={path for path,row in entries.items() if row['kind']=='FILE'}
    for path in sys.path:
        if path not in directories and path not in manifest['absent_paths']:_fail('QUALIFICATION_PYTHON_IMPORT_PATH_UNQUALIFIED')
    imported=[]
    for name,module in list(sys.modules.items()):
        path=getattr(module,'__file__',None)
        if path is None:continue
        if type(path) is not str:_fail('QUALIFICATION_PYTHON_IMPORT_PATH_UNQUALIFIED')
        if (path not in files and path!=str(root)+'/ops/install/rbridge_install.py'
                and not path.startswith(str(root)+'/ops/install/rbridge_installation/')):
            _fail('QUALIFICATION_PYTHON_IMPORT_PATH_UNQUALIFIED')
        imported.append({'module':name,'path':path})
    mapped=set()
    for row in _kernel_bytes('/proc/self/maps',2097152).decode('utf-8',errors='strict').splitlines():
        fields=row.split(None,5)
        if len(fields)<5:_fail('QUALIFICATION_PYTHON_MAPPING_UNQUALIFIED')
        if len(fields)==6 and fields[5].startswith('/'):
            if fields[5] not in files:_fail('QUALIFICATION_PYTHON_MAPPING_UNQUALIFIED')
            mapped.add(fields[5])
        elif 'x' in fields[1] and (len(fields)!=6 or fields[5] not in ('[vdso]','[vsyscall]')):
            _fail('QUALIFICATION_PYTHON_MAPPING_UNQUALIFIED')
    return {**proof,'scope':'RUNNING_ROOT_INTERPRETER_OBSERVATION_ONLY','execution_qualified':False,
        'profile_sha256':report_sha256(p),'imports':sorted(imported,key=lambda r:r['module']),
        'mapped_files':sorted(mapped),'service_action_authorized':False}
