"""Bounded foreground maintenance with durable start intent and conservative hold.

Source fixtures have a separate constructor. Production preparation requires the
concrete qualification bundle; profile approval and PASS strings grant no action.
"""
from dataclasses import dataclass
from datetime import datetime,timezone
from pathlib import Path
import hashlib
import json
import os
import re
import stat
import weakref
from .models import InstallationError,record,encode_report,report_sha256
from .profile import parse_profile
from .ledger import Ledger,LedgerError,_strict_json
from .pause_backup import maintain_pause,capture_snapshot,backup_snapshot,reacquire_exclusion
from .configuration import install_configuration,switch_pointer,OwnedChanges,restore_owned_pre_start,resume_owned_changes
from .artifact import _identity
from .protected_copy import FilesystemAuthority,verify_published,DIR_FLAGS,FILE_FLAGS
from .readonly_helper import run_paused_gates,validate_gate_bundle

class TransactionError(InstallationError):pass

@dataclass(frozen=True)
class QualificationInputs:
    bundle:object

@dataclass(frozen=True)
class SwitchAuthorization:
    purpose:str
    profile_sha256:str
    runtime_manifest_sha256:str
    toolkit_manifest_sha256:str
    readers_sha256:str
    helper_sha256:str
    transaction_id:str
    owner_present:bool
    expires_at:str

class PreparedInstallation:
    def __init__(self,profile=None,status='BLOCKED',scope='UNQUALIFIED',reason_codes=('PREPARATION_UNQUALIFIED',)):
        self.profile=profile;self.status=status;self.scope=scope;self.reason_codes=reason_codes;self.lease=None;self.ledger=None;self.evidence=None;self.config=None;self.pointer=None;self.start_call_issued=False;self.poisoned=False
        self.profile_sha256=report_sha256(profile) if profile else '0'*64;self.runtime_manifest=None;self.toolkit_manifest=None;self.artifact=None;self.bundle=None
        self.toolkit_manifest_sha256='0'*64;self.readers_sha256='0'*64;self.helper_sha256='0'*64

_prepared=weakref.WeakSet();_preparation_pins=weakref.WeakKeyDictionary()

def _preparation_pin(value):
    return report_sha256({'profile':value.profile,'scope':value.scope,'runtime_manifest':value.runtime_manifest,'toolkit_manifest':value.toolkit_manifest,'artifact':{'path':str(value.artifact.path),'manifest_sha256':value.artifact.manifest_sha256,'source_sha':value.artifact.source_sha,'scope':value.artifact.scope},'toolkit_manifest_sha256':value.toolkit_manifest_sha256,'readers_sha256':value.readers_sha256,'helper_sha256':value.helper_sha256})

def _register_preparation(value):
    _prepared.add(value);_preparation_pins[value]=_preparation_pin(value);return value

def _prepare_fixture_installation(profile,ledger,artifact,runtime_manifest):
    """Test-only source authority; never called by the production CLI."""
    if type(ledger) is not Ledger or ledger.guard is not None:raise TransactionError('FIXTURE_LEDGER_REQUIRED')
    value=PreparedInstallation(profile,'READY','FIXTURE_AUTHORITY_ONLY',());value.ledger=ledger;value.artifact=artifact;value.runtime_manifest=runtime_manifest;value.toolkit_manifest_sha256=profile.toolkit.manifest_sha256;value.readers_sha256=report_sha256(profile.readers);value.helper_sha256=profile.toolkit.manifest_sha256
    return _register_preparation(value)

def prepare_installation(profile,inputs):
    try:
        p=parse_profile(json.loads(encode_report(profile)))
        if type(inputs) is not QualificationInputs:raise TransactionError('PREPARATION_UNQUALIFIED')
        from .qualification import verify_qualification_bundle
        bundle=verify_qualification_bundle(p,inputs.bundle)
        value=PreparedInstallation(p,'READY','QUALIFIED_PREPARED_INSTALLATION',());value.bundle=bundle;value.artifact=bundle.runtime_artifact;value.runtime_manifest=bundle.runtime_manifest;value.toolkit_manifest=bundle.toolkit_manifest;value.toolkit_manifest_sha256=bundle.toolkit_manifest.sha256;value.readers_sha256=bundle.readers_sha256;value.helper_sha256=bundle.helper_sha256
        return _register_preparation(value)
    except (InstallationError,ImportError,ValueError,TypeError,AttributeError):return PreparedInstallation(reason_codes=('PREPARATION_UNQUALIFIED',))

def _result(prepared,status,code,phase,reasons=()):
    digest='0'*64
    try:
        if prepared.ledger:digest=prepared.ledger.read().sha256
    except InstallationError:pass
    return record('TransactionResult',{'status':status,'exit_code':code,'phase':phase,'ledger_sha256':digest,'reason_codes':list(dict.fromkeys(reasons))})

def _authorization(prepared,auth):
    if type(auth) is not SwitchAuthorization or auth.owner_present is not True or auth.transaction_id!=prepared.ledger.transaction_id:raise TransactionError('SWITCH_AUTHORIZATION_MISSING')
    expected={'profile_sha256':prepared.profile_sha256,'runtime_manifest_sha256':prepared.runtime_manifest.sha256,'toolkit_manifest_sha256':prepared.toolkit_manifest_sha256,'readers_sha256':prepared.readers_sha256,'helper_sha256':prepared.helper_sha256}
    if any(getattr(auth,k)!=v for k,v in expected.items()):raise TransactionError('SWITCH_AUTHORIZATION_DRIFT')
    purpose='FIXTURE_SWITCH_ONLY' if prepared.scope=='FIXTURE_AUTHORITY_ONLY' else 'OWNER_PRESENT_PRODUCTION_SWITCH'
    if auth.purpose!=purpose or type(auth.expires_at) is not str:raise TransactionError('SWITCH_AUTHORIZATION_MISSING')
    try:
        expires=datetime.fromisoformat(auth.expires_at.replace('Z','+00:00'));now=datetime.now(timezone.utc)
        if expires.tzinfo is None or expires<=now or (prepared.scope!='FIXTURE_AUTHORITY_ONLY' and (expires-now).total_seconds()>prepared.profile.budget.maintenance_ms/1000):raise ValueError()
    except ValueError:raise TransactionError('SWITCH_AUTHORIZATION_EXPIRED') from None

def _validate(prepared,backend):
    if type(prepared) is not PreparedInstallation or prepared not in _prepared or prepared.status!='READY' or prepared.poisoned or prepared.profile_sha256!=report_sha256(prepared.profile) or _preparation_pin(prepared)!=_preparation_pins[prepared]:raise TransactionError('PREPARATION_UNQUALIFIED')
    if prepared.scope=='FIXTURE_AUTHORITY_ONLY':
        if getattr(backend,'scope',None)!='FIXTURE_AUTHORITY_ONLY':raise TransactionError('TRANSACTION_BACKEND_UNQUALIFIED')
    else:
        from .host_backend import QualifiedHostBackend
        from .qualification import verify_qualification_bundle
        if type(backend) is not QualifiedHostBackend or os.getuid()!=0 or os.geteuid()!=0:raise TransactionError('TRANSACTION_BACKEND_UNQUALIFIED')
        verify_qualification_bundle(prepared.profile,prepared.bundle)
    authority=FilesystemAuthority(os.getuid(),prepared.profile.binding.uid,Path(prepared.profile.paths.release_parent),'RUNTIME',prepared.scope!='FIXTURE_AUTHORITY_ONLY',prepared.profile.runtime.manifest_sha256,prepared.profile.runtime.source_sha,prepared.profile.runtime.tree_sha)
    verify_published(prepared.artifact.path,prepared.runtime_manifest,authority)

class _PrivateEvidence:
    def __init__(self,ledger,existing=False):
        self.ledger=ledger;self.owner=ledger.uid;self.name='evidence-'+ledger.transaction_id;self.fd=None;self.sequence=0
        try:
            ledger._check()
            if not existing:os.mkdir(self.name,0o700,dir_fd=ledger.parent_fd);os.fsync(ledger.parent_fd)
            self.fd=os.open(self.name,DIR_FLAGS,dir_fd=ledger.parent_fd);s=os.fstat(self.fd)
            if s.st_uid!=self.owner or s.st_mode&0o7777!=0o700:raise TransactionError('EVIDENCE_DIRECTORY_UNQUALIFIED')
            self.identity=(s.st_dev,s.st_ino)
            if existing:
                names=sorted(os.listdir(self.fd))
                if len(names)>128 or any(not re.fullmatch(f'{i:03d}-[a-z][a-z0-9-]{{0,63}}\\.json',n) for i,n in enumerate(names,1)):raise TransactionError('EVIDENCE_DIRECTORY_UNQUALIFIED')
                self.sequence=len(names)
        except (OSError,InstallationError):
            if self.fd is not None:os.close(self.fd);self.fd=None
            raise TransactionError('EVIDENCE_DIRECTORY_UNCERTAIN') from None
    def write(self,label,value):
        if not re.fullmatch('[a-z][a-z0-9-]{0,63}',label):raise TransactionError('EVIDENCE_LABEL_INVALID')
        self.check()
        raw=encode_report(value)
        if len(raw)>67108864 or self.sequence>=128:raise TransactionError('EVIDENCE_BYTE_LIMIT')
        self.sequence+=1;name=f'{self.sequence:03d}-{label}.json';fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=self.fd)
        try:
            view=memoryview(raw)
            while view:
                n=os.write(fd,view)
                if n<=0:raise TransactionError('EVIDENCE_WRITE_FAILED')
                view=view[n:]
            os.fsync(fd)
        finally:os.close(fd)
        os.fsync(self.fd)
        if encode_report(self.read_file(name))!=raw:raise TransactionError('EVIDENCE_READBACK_FAILED')
        return hashlib.sha256(raw).hexdigest()
    def check(self):
        self.ledger._check();s=os.stat(self.name,dir_fd=self.ledger.parent_fd,follow_symlinks=False)
        if (s.st_dev,s.st_ino)!=self.identity or s.st_uid!=self.owner or s.st_mode&0o7777!=0o700:raise TransactionError('EVIDENCE_DIRECTORY_CHANGED')
        current=os.fstat(self.fd)
        if _identity(current)!=_identity(s):raise TransactionError('EVIDENCE_DIRECTORY_CHANGED')
    def read_file(self,name):
        self.check()
        if not re.fullmatch('[0-9]{3}-[a-z][a-z0-9-]{0,63}\\.json',name):raise TransactionError('EVIDENCE_LABEL_INVALID')
        handle=os.open(name,FILE_FLAGS,dir_fd=self.fd)
        try:
            before=os.fstat(handle)
            if not stat.S_ISREG(before.st_mode) or before.st_uid!=self.owner or before.st_mode&0o7777!=0o600 or before.st_nlink!=1 or before.st_size>67108864:raise TransactionError('EVIDENCE_READBACK_FAILED')
            observed=bytearray()
            while len(observed)<=before.st_size:
                chunk=os.read(handle,min(65536,before.st_size+1-len(observed)))
                if not chunk:break
                observed.extend(chunk)
            if len(observed)!=before.st_size or _identity(before)!=_identity(os.fstat(handle)) or _identity(before)!=_identity(os.stat(name,dir_fd=self.fd,follow_symlinks=False)):raise TransactionError('EVIDENCE_READBACK_FAILED')
            value=_strict_json(bytes(observed))
            if encode_report(value)!=observed:raise TransactionError('EVIDENCE_READBACK_FAILED')
            self.check();return value
        finally:os.close(handle)
    def owned_witness(self):
        names=sorted(os.listdir(self.fd));witness=None;total=0
        for name in names:
            total+=os.stat(name,dir_fd=self.fd,follow_symlinks=False).st_size
            if total>268435456:raise TransactionError('EVIDENCE_BYTE_LIMIT')
            value=self.read_file(name)
            if name.endswith(('-owned-config.json','-owned-pointer.json')):witness=value
        if names!=sorted(os.listdir(self.fd)):raise TransactionError('EVIDENCE_DIRECTORY_CHANGED')
        return witness
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None

def _token(prepared,snapshot):
    return {'transaction_id':prepared.ledger.transaction_id,'state_root_identity_sha256':report_sha256({k:v for k,v in snapshot.root_metadata.items() if k!='atime_ns'}),'tree_sha256':snapshot.tree_sha256,'entries':len(snapshot.entries),'bytes':snapshot.bytes,'pause_sha256':snapshot.pause_sha256,'captured_at':datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')}

def _gates(prepared,backend,snapshot):
    token=_token(prepared,snapshot)
    proof=backend.fixture_gates(prepared.lease,token,None) if prepared.scope=='FIXTURE_AUTHORITY_ONLY' else run_paused_gates(prepared.lease,token,prepared.toolkit_manifest)
    if proof.get('scope')!=('FIXTURE_AUTHORITY_ONLY' if prepared.scope=='FIXTURE_AUTHORITY_ONLY' else 'QUALIFIED_HOST_PAUSE'):raise TransactionError('TRANSACTION_GATES_UNQUALIFIED')
    bundle=validate_gate_bundle(proof['bundle'],token)
    if bundle['status']!='PASS':raise TransactionError('TRANSACTION_GATES_NOT_PASS')
    after=capture_snapshot(prepared.lease)
    if after.tree_sha256!=snapshot.tree_sha256 or after.reason_codes:raise TransactionError('TRANSACTION_SNAPSHOT_CHANGED')
    return proof

def _owned_evidence(prepared):
    config=prepared.config;pointer=prepared.pointer
    # No original environment contents or secret-bearing systemd property strings.
    return {'schema':'RBRIDGE_INSTALL_OWNED_EVIDENCE_V1','profile_sha256':prepared.profile_sha256,'transaction_id':prepared.ledger.transaction_id,'configuration':None if config is None else {'before_sha256':config.before_sha256,'after_sha256':config.after_sha256,'before_pointer_sha256':config.before_pointer_sha256,'owned_additions_sha256':config.owned_additions_sha256,'files':[vars(p) for p in config.files]},'pointer':None if pointer is None else {'before_sha256':pointer.before_sha256,'after_sha256':pointer.after_sha256,'before_target':pointer.before_target,'after_target':pointer.after_target,'held_before':[pointer.session.held_before[0],list(map(str,pointer.session.held_before[1])),pointer.session.held_before[2]],'backup_name':pointer.session.backup,'before_identity':list(map(str,pointer.session.before[1])),'after_identity':list(map(str,pointer.session.after[1]))}}

def _hold(prepared,backend,reason):
    prepared.poisoned=True
    if prepared.lease is None:return _result(prepared,'BLOCKED',2,'HOLD_UNSETTLED',(reason,'EXCLUSION_NOT_PROVEN'))
    try:
        prepared.lease.check_exclusion()
        try:backend.stop_unit(prepared.profile.service.unit)
        except (InstallationError,OSError):pass
        # Stop acknowledgement is insufficient. Full concrete observation follows.
        prepared.lease.observe_stopped();snapshot=capture_snapshot(prepared.lease)
        if prepared.evidence:prepared.evidence.write('post-start-hold',{'scope':prepared.scope,'reason_codes':[reason],'pause_sha256':prepared.lease.pause_sha256,'snapshot_sha256':snapshot.tree_sha256,'snapshot_reason_codes':snapshot.reason_codes})
        entries=prepared.ledger.read().entries
        if entries[-1].marker!='ROLLBACK_BLOCKED_START_ATTEMPTED':prepared.ledger.append('ROLLBACK_BLOCKED_START_ATTEMPTED',{'snapshot_sha256':snapshot.tree_sha256,'pause_sha256':prepared.lease.pause_sha256,'reason_codes':[reason]})
        return _result(prepared,'STOPPED_POST_START_HOLD',4,'ROLLBACK_BLOCKED_START_ATTEMPTED',(reason,'OLD_RESTART_FORBIDDEN'))
    except (InstallationError,OSError,ValueError):return _result(prepared,'UNKNOWN',2,'HOLD_UNSETTLED',(reason,'STOP_OR_WRITERS_UNSETTLED','OLD_RESTART_FORBIDDEN'))

def _prestart_failure(prepared,backend,reason):
    if prepared.lease is None:prepared.lease=getattr(backend,'pending_pause',None)
    # No automatic rollback when a syscall/ledger acknowledgement is uncertain.
    if reason.startswith('LEDGER_') or prepared.start_call_issued:
        prepared.poisoned=True;return _result(prepared,'UNKNOWN',2,'HOLD_UNSETTLED',(reason,'DURABLE_INTENT_UNCERTAIN'))
    try:
        if prepared.lease is None:return _result(prepared,'BLOCKED',2,'BLOCKED',(reason,))
        prepared.lease.check()
        if prepared.config is not None:
            snapshot=capture_snapshot(prepared.lease);_gates(prepared,backend,snapshot)
            from .ledger import ObservedTransactionState
            observed=ObservedTransactionState(prepared.pointer.after_sha256 if prepared.pointer else prepared.config.before_pointer_sha256,prepared.config.after_sha256,prepared.profile.service.identity_sha256,snapshot.tree_sha256,prepared.config.owned_additions_sha256,True,True,'PASS',snapshot.tree_sha256)
            proof=restore_owned_pre_start(OwnedChanges(prepared.config,prepared.pointer),observed,prepared.lease,prepared.ledger)
            if not proof.may_start_old:raise TransactionError('PRESTART_RESTORE_UNCONFIRMED')
            return _result(prepared,'RESTORED_PRE_START_STOPPED',3,'ROLLED_BACK',(reason,))
        # An incomplete owned mutation is preserved for independently verified resume.
        if getattr(backend,'owned_configuration',None) is not None or getattr(backend,'owned_pointer',None) is not None:raise TransactionError('OWNED_MUTATION_UNACKNOWLEDGED')
        prepared.ledger.append('ROLLBACK_BLOCKED',{'reason_codes':[reason]})
        return _result(prepared,'STOPPED_PRE_START_BLOCKED',2,'ROLLBACK_BLOCKED',(reason,))
    except (InstallationError,OSError,ValueError):return _result(prepared,'UNKNOWN',2,'HOLD_UNSETTLED',(reason,'PRESTART_RECOVERY_UNPROVEN'))

def apply_installation(prepared,authorization,backend):
    try:
        _validate(prepared,backend)
        if prepared.scope!='FIXTURE_AUTHORITY_ONLY' and prepared.ledger is None:
            # Opening the exact private ledger is deferred until qualification.
            from .qualification import open_qualified_transaction_ledger
            prepared.ledger=open_qualified_transaction_ledger(prepared.bundle,authorization)
        _authorization(prepared,authorization)
        if prepared.ledger.read().entries:raise TransactionError('TRANSACTION_ALREADY_STARTED_USE_RESUME')
    except (InstallationError,OSError,ValueError,ImportError):return _result(prepared,'BLOCKED',2,'BLOCKED',('SWITCH_PRECONDITIONS_NOT_QUALIFIED',))
    try:
        p=prepared.profile;ledger=prepared.ledger;prepared.authorization=authorization;backend.runtime_manifest=prepared.runtime_manifest;backend.toolkit_manifest=prepared.toolkit_manifest;backend.current_installation=prepared
        prepared.evidence=_PrivateEvidence(ledger)
        ledger.append('QUALIFIED',{'profile_sha256':prepared.profile_sha256,'runtime_manifest_sha256':prepared.runtime_manifest.sha256,'toolkit_manifest_sha256':prepared.toolkit_manifest_sha256,'readers_sha256':prepared.readers_sha256})
        _validate(prepared,backend);ledger.append('STAGED',{'runtime_manifest_sha256':prepared.runtime_manifest.sha256,'toolkit_manifest_sha256':prepared.toolkit_manifest_sha256})
        prepared.lease=maintain_pause(p,backend,ledger);snapshot=capture_snapshot(prepared.lease)
        if snapshot.reason_codes:raise TransactionError('TRANSACTION_SNAPSHOT_UNQUALIFIED')
        backup=backup_snapshot(snapshot,ledger.parent_fd);prepared.evidence.write('backup',backup)
        gates=_gates(prepared,backend,snapshot);gates_sha=prepared.evidence.write('paused-gates',gates)
        ledger.append('GATES_PASS',{'gates_sha256':gates_sha,'snapshot_sha256':snapshot.tree_sha256,'service_identity_sha256':p.service.identity_sha256})
        prepared.config=install_configuration(p,prepared.lease,ledger,backend);prepared.evidence.write('owned-config',_owned_evidence(prepared))
        prepared.pointer=switch_pointer(p,prepared.artifact,prepared.lease,ledger);prepared.evidence.write('owned-pointer',_owned_evidence(prepared))
        prepared.lease.check();_validate(prepared,backend)
        _authorization(prepared,authorization)
        if prepared.config.session.observed()!=prepared.config.after_sha256:raise TransactionError('TRANSACTION_CONFIG_DRIFT')
        prepared.pointer.session.check()
        ledger.append('START_ATTEMPTED',{'profile_sha256':prepared.profile_sha256,'runtime_manifest_sha256':prepared.runtime_manifest.sha256,'pointer_sha256':prepared.pointer.after_sha256,'config_sha256':prepared.config.after_sha256})
        prepared.start_call_issued=True;backend.start_candidate(prepared);prepared.lease.check_exclusion()
        invocation=backend.observe_candidate(prepared)
        if invocation.get('scope')!=('FIXTURE_AUTHORITY_ONLY' if prepared.scope=='FIXTURE_AUTHORITY_ONLY' else 'QUALIFIED_INSTALLED_INVOCATION') or invocation.get('status')!='PASS' or invocation.get('profile_sha256')!=prepared.profile_sha256 or invocation.get('runtime_manifest_sha256')!=prepared.runtime_manifest.sha256:raise TransactionError('CANDIDATE_INVOCATION_UNQUALIFIED')
        invocation_sha=prepared.evidence.write('new-invocation',invocation);ledger.append('NEW_STARTED',{'invocation_sha256':invocation_sha,'runtime_manifest_sha256':prepared.runtime_manifest.sha256})
        ledger.append('ACCEPTING',{'invocation_sha256':invocation_sha})
        if prepared.scope=='FIXTURE_AUTHORITY_ONLY':acceptance=backend.accept_candidate(prepared)
        else:
            from .acceptance import accept_installation,make_acceptance_context
            acceptance=accept_installation(make_acceptance_context(prepared,invocation),backend)
        acceptance_sha=prepared.evidence.write('acceptance',dict(acceptance))
        if acceptance.get('schema')!='RBRIDGE_INSTALL_ACCEPTANCE_V1' or acceptance.get('status')!='PASS':raise TransactionError('INSTALLED_ACCEPTANCE_NOT_PASS')
        prepared.lease.check_exclusion();_validate(prepared,backend)
        # Fresh actual invocation observation, not a stale acknowledgement.
        final=backend.observe_candidate(prepared)
        if prepared.scope=='FIXTURE_AUTHORITY_ONLY':
            expected_final=acceptance.get('final_invocation',invocation)
        else:
            from .acceptance import validated_acceptance_invocation
            expected_final=validated_acceptance_invocation(prepared,acceptance)
        if report_sha256(final)!=report_sha256(expected_final):raise TransactionError('CANDIDATE_INVOCATION_CHANGED')
        final_invocation_sha=prepared.evidence.write('accepted-invocation',final)
        ledger.append('ACCEPTED',{'invocation_sha256':final_invocation_sha,'readers_sha256':acceptance_sha,'runtime_manifest_sha256':prepared.runtime_manifest.sha256})
        prepared.lease.close();return _result(prepared,'ACCEPTED',0,'ACCEPTED')
    except (InstallationError,OSError,ValueError,ImportError,AttributeError) as error:
        reason=error.reason if isinstance(error,InstallationError) else 'TRANSACTION_STEP_UNCERTAIN'
        try:started=any(e.marker=='START_ATTEMPTED' for e in prepared.ledger.read().entries)
        except InstallationError:started=prepared.start_call_issued
        return _hold(prepared,backend,reason) if started else _prestart_failure(prepared,backend,reason)

def resume_installation(profile,ledger,backend):
    prepared=getattr(backend,'current_installation',None)
    if prepared is None:
        prepared=getattr(backend,'resume_preparation',None)
        try:
            _validate(prepared,backend)
            if prepared.ledger is not ledger or report_sha256(profile)!=prepared.profile_sha256:raise TransactionError('RESUME_OWNERSHIP_AND_EXCLUSION_UNQUALIFIED')
            entries=ledger.read().entries
            expected={'profile_sha256':prepared.profile_sha256,'runtime_manifest_sha256':prepared.runtime_manifest.sha256,'toolkit_manifest_sha256':prepared.toolkit_manifest_sha256,'readers_sha256':prepared.readers_sha256}
            if not entries or entries[0].marker!='QUALIFIED' or dict(entries[0].evidence)!=expected:raise TransactionError('RESUME_QUALIFICATION_DRIFT')
            if entries[-1].marker=='ACCEPTED':return _result(prepared,'BLOCKED',2,'ACCEPTED',('RESUME_ACCEPTED_REQUIRES_FRESH_ACCEPTANCE',))
            # Reacquisition is new ownership, never a claim that a dead flock survived.
            prepared.lease=reacquire_exclusion(profile,backend,ledger);backend.current_installation=prepared
            backend.runtime_manifest=prepared.runtime_manifest;backend.toolkit_manifest=prepared.toolkit_manifest
            prepared.evidence=_PrivateEvidence(ledger,existing=True)
            if any(e.marker=='CONFIG_INTENT' for e in entries):
                changes=resume_owned_changes(profile,prepared.lease,ledger,backend,prepared.evidence.owned_witness());prepared.config=changes.config;prepared.pointer=changes.pointer
            if not any(e.marker=='START_ATTEMPTED' for e in entries):
                backend.stop_unit(profile.service.unit);prepared.lease.observe_stopped()
        except (InstallationError,OSError,ValueError,TypeError,AttributeError,ImportError):
            if type(prepared) is PreparedInstallation:return _result(prepared,'UNKNOWN',2,'HOLD_UNSETTLED',('RESUME_OWNERSHIP_AND_EXCLUSION_UNQUALIFIED',))
            return record('TransactionResult',{'status':'UNKNOWN','exit_code':2,'phase':'HOLD_UNSETTLED','ledger_sha256':'0'*64,'reason_codes':['RESUME_OWNERSHIP_AND_EXCLUSION_UNQUALIFIED']})
    if type(prepared) is not PreparedInstallation or prepared not in _prepared or prepared.ledger is not ledger or report_sha256(profile)!=prepared.profile_sha256:return record('TransactionResult',{'status':'UNKNOWN','exit_code':2,'phase':'HOLD_UNSETTLED','ledger_sha256':'0'*64,'reason_codes':['RESUME_OWNERSHIP_AND_EXCLUSION_UNQUALIFIED']})
    try:
        entries=ledger.read().entries
        if not entries:return _result(prepared,'BLOCKED',2,'BLOCKED',('RESUME_EMPTY_LEDGER',))
        if entries[-1].marker=='ACCEPTED':return _result(prepared,'BLOCKED',2,'ACCEPTED',('RESUME_ACCEPTED_REQUIRES_FRESH_ACCEPTANCE',))
        if any(e.marker=='START_ATTEMPTED' for e in entries):return _hold(prepared,backend,'RESUME_POST_START_HOLD')
        return _prestart_failure(prepared,backend,'RESUME_PRE_START_OBSERVATION_REQUIRED')
    except (InstallationError,OSError,ValueError):return _result(prepared,'UNKNOWN',2,'HOLD_UNSETTLED',('RESUME_LEDGER_OR_OBSERVATION_UNQUALIFIED',))
