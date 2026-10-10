"""One signed owner-approved, process-local, single read-only systemctl audit.

No service start/stop/restart, journal settlement, old-file repair, installation,
pointer switch, extra helper, generic provider callback or production cutover.
The only possible exception is the known incomplete helper during one exact,
freshly approved 'systemctl show rbridge.service' observation. Never a general
maintenance bypass. Unissued, expired or foreign-process candidates fail closed.
"""
import hashlib
import os
import secrets
import threading
import time
import weakref

from .models import InstallationError
from .orphan_dual_guard_gate import ORPHAN_NAME
from .orphan_intent_review import READONLY_ARGV,READONLY_EXE_SHA

class OrphanReadonlyLeaseError(InstallationError):pass
def _fail(reason):raise OrphanReadonlyLeaseError(reason)

_FACTORY_SEAL=object()
_live=weakref.WeakKeyDictionary()
_guard_lock=threading.RLock()

class _OneRootReadOnlyQualificationLease:
    __slots__=('__weakref__',)
    def __init__(self,seal=None):
        if seal is not _FACTORY_SEAL:_fail('ORPHAN_READONLY_LEASE_UNISSUED')
    def __reduce_ex__(self,protocol):_fail('ORPHAN_READONLY_LEASE_NONTRANSFERABLE')
    def __copy__(self):_fail('ORPHAN_READONLY_LEASE_NONTRANSFERABLE')
    def __deepcopy__(self,memo):_fail('ORPHAN_READONLY_LEASE_NONTRANSFERABLE')

def _readonly_helper_args(pin,args,input_bytes,child_specs):
    """Exactly the original read-only command, never a service action."""
    if (getattr(pin,'path',None)!=READONLY_ARGV[0]
            or getattr(pin,'sha256',None)!=READONLY_EXE_SHA
            or type(args) not in (list,tuple)
            or list(args)!=list(READONLY_ARGV[1:])
            or type(input_bytes) is not bytes or input_bytes
            or type(child_specs) not in (list,tuple) or child_specs):
        _fail('ORPHAN_READONLY_HELPER_OPERATION_UNQUALIFIED')
    return True

def _physical_revalidate(row,*,fresh_kernel=True):
    from .orphan_live_owner_qualification_approval import (
        _exact_root_context,_root_process_facts)
    from .orphan_published_source_review import inspect_published_toolkit_readonly
    from .orphan_retained_custody_observer import observe_protected_retained_custody
    from .orphan_owner_key_origin import _read_protected_owner_key
    from .host_backend import _protected_bytes
    if (time.monotonic()>row['expires_mono']
            or _root_process_facts()!=row['facts']
            or _exact_root_context()!='toolkit-'+row['source_sha']):
        _fail('ORPHAN_READONLY_LEASE_PROCESS_OR_TIME_CHANGED')
    source=inspect_published_toolkit_readonly(
        row['source_sha'],row['tree_sha'],row['manifest_file_sha256'])
    if (source['status']!='PHYSICAL_ROOT_TOOLKIT_BYTES_MATCH_UNTRUSTED_PINS'
            or source['manifest_logical_sha256']!=row['manifest_logical_sha256']):
        _fail('ORPHAN_READONLY_LEASE_PHYSICAL_SOURCE_CHANGED')
    old=observe_protected_retained_custody(
        row['custody_sha256'],row['writer_source_sha'])
    if (old['status']!='ROOT_PHYSICAL_CUSTODY_AND_ORIGINAL_INTENT_MATCH_DATA_ONLY'
            or old['historical_execution']!='UNKNOWN'):
        _fail('ORPHAN_READONLY_LEASE_ORIGINAL_JOURNAL_CHANGED')
    public=_read_protected_owner_key(row['owner_key_sha256'])
    if hashlib.sha256(public).hexdigest()!=row['owner_key_sha256']:
        _fail('ORPHAN_READONLY_LEASE_ENROLLED_KEY_CHANGED')
    if (row['driver_sha256']!=READONLY_EXE_SHA
            or hashlib.sha256(_protected_bytes(READONLY_ARGV[0],268435456)).hexdigest()
            !=READONLY_EXE_SHA):
        _fail('ORPHAN_READONLY_LEASE_COMMAND_HASH_CHANGED')
    if fresh_kernel:
        from .orphan_kernel_census import collect_root_kernel_census
        census=collect_root_kernel_census()
        if census['status']!='NO_CURRENT_SYSTEMCTL_MATCH':
            _fail('ORPHAN_READONLY_LEASE_KERNEL_UNQUALIFIED')
    if (time.monotonic()>row['expires_mono']
            or _root_process_facts()!=row['facts']):
        _fail('ORPHAN_READONLY_LEASE_PROCESS_CHANGED_AFTER_CENSUS')

def issue_one_root_readonly_qualification_lease(signed_review):
    """Convert a consumed, protected Root in-process SIGNED review into one
    exact read-only helper workflow permit. No serialized receipt qualifies.
    """
    from .orphan_live_owner_qualification_approval import (
        _ProcessLocalApprovedReview,_approved_reviews)
    if (type(signed_review) is not _ProcessLocalApprovedReview
            or signed_review not in _approved_reviews):
        _fail('ORPHAN_READONLY_LEASE_SIGNED_REVIEW_REQUIRED')
    # Consume owner review before attempting any filesystem, process or census
    # checks. Failure always poisons this particular approval handle.
    with _guard_lock:
        data=_approved_reviews.pop(signed_review)
        if data['driver_sha256']!=READONLY_EXE_SHA:
            _fail('ORPHAN_READONLY_LEASE_OPERATION_NOT_SIGNED')
        _physical_revalidate(data,fresh_kernel=True)
        lease=_OneRootReadOnlyQualificationLease(_FACTORY_SEAL)
        _live[lease]={**data,'state':'NEW',
                      'opaque_nonce':secrets.token_bytes(32)}
        return lease

def _validate_live_lease(lease,*,guard,journal_name,
                         phase='PRECHECK',pin=None,args=None,
                         input_bytes=None,child_specs=None):
    """Private operative Root guard verifier for exactly one original orphan."""
    if (type(lease) is not _OneRootReadOnlyQualificationLease
            or lease not in _live):
        _fail('ORPHAN_READONLY_LEASE_NOT_LIVE')
    if journal_name!=ORPHAN_NAME:
        _fail('ORPHAN_READONLY_LEASE_OTHER_JOURNAL')
    if guard not in ('MAINTENANCE_REGISTRY','HELPER_JOURNAL'):
        _fail('ORPHAN_READONLY_LEASE_GUARD_INVALID')
    if phase not in ('PRECHECK','ORPHAN'):
        _fail('ORPHAN_READONLY_LEASE_PHASE_INVALID')
    with _guard_lock:
        row=_live[lease]
        if ((guard=='MAINTENANCE_REGISTRY' and row['state']!='NEW')
                or (guard=='HELPER_JOURNAL' and row['state']!='REGISTRY_OBSERVED')):
            _fail('ORPHAN_READONLY_LEASE_SEQUENCE_INVALID')
        if guard=='HELPER_JOURNAL':
            _readonly_helper_args(pin,args,input_bytes,child_specs)
        # A serialized proof cannot replace this live Root physical read.
        _physical_revalidate(row,fresh_kernel=phase=='ORPHAN')
        if phase=='ORPHAN':
            row['state']=('REGISTRY_OBSERVED' if guard=='MAINTENANCE_REGISTRY'
                          else 'CONSUMED')
        return {
            'schema':'RBRIDGE_SINGLE_ROOT_READONLY_LEASE_GUARD_RESULT_V1',
            'status':'ONE_ORIGINAL_ORPHAN_READONLY_AUDIT_ONLY',
            'journal_name':ORPHAN_NAME,
            'guard':guard,'phase':phase,
            'old_journal_settled':False,
            'owner_identity_independently_authenticated':False,
            'may_change_production':False,
            'service_action_authorized':False,
        }

def revoke_root_readonly_lease(lease):
    """Poison the one-use lease after a helper attempt, successful or not."""
    with _guard_lock:
        if type(lease) is not _OneRootReadOnlyQualificationLease:
            _fail('ORPHAN_READONLY_LEASE_NOT_LIVE')
        _live.pop(lease,None)
