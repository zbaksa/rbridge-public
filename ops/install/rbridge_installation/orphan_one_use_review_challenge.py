"""One-use process-bound challenge comparison DATA; never Root admission.

A nonce/signature binding alone cannot prove Root process provenance, owner
key enrollment, real current kernel identity, or owner authorization. This
module accepts untrusted process/time observations for SOURCE fixtures only.
A separately protected Root factory must collect and attest those facts
before they can become trusted. Every result denies helper/production rights.
"""
import hashlib
import re
import secrets
import time

from .models import InstallationError
from .orphan_owner_signed_release_review import (
    parse_signed_release_review_data,verify_signed_release_review_data)

class OrphanReviewChallengeError(InstallationError):pass
def _fail(reason):raise OrphanReviewChallengeError(reason)

_DURATION_S=120
_NAME='helper-0b84e8af62a287a283eabcd4eef1cdb7'
_INTENT='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'

def _hex(value,n):
    return type(value) is str and re.fullmatch('[0-9a-f]{'+str(n)+'}',value) is not None

class SingleUseReviewChallengeData:
    """An untrusted in-memory one-shot comparator, NOT a permit/capability."""
    __slots__=('_source','_tree','_file_manifest','_logical_manifest',
               '_pid','_start_ticks','_boot','_nonce','_born_mono',
               '_issued_unix','_expires_unix','_used')

    def __init__(self,source_sha,tree_sha,manifest_file_sha256,
                 manifest_logical_sha256,claimed_pid,claimed_start_ticks,
                 claimed_boot_id):
        # Claimed identity is a DATA argument, not an OS/kernel attestation.
        if (not _hex(source_sha,40) or not _hex(tree_sha,40)
                or not _hex(manifest_file_sha256,64)
                or not _hex(manifest_logical_sha256,64)
                or type(claimed_pid) is not int or not 2<=claimed_pid<=2147483647
                or type(claimed_start_ticks) is not str
                or re.fullmatch('[1-9][0-9]{0,31}',claimed_start_ticks) is None
                or type(claimed_boot_id) is not str
                or re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',
                                claimed_boot_id) is None):
            _fail('ORPHAN_REVIEW_CHALLENGE_CONTEXT_INVALID')
        nonce=secrets.token_bytes(32)
        if type(nonce) is not bytes or len(nonce)!=32:
            _fail('ORPHAN_REVIEW_CHALLENGE_RANDOM_UNAVAILABLE')
        self._source=source_sha
        self._tree=tree_sha
        self._file_manifest=manifest_file_sha256
        self._logical_manifest=manifest_logical_sha256
        self._pid=claimed_pid
        self._start_ticks=claimed_start_ticks
        self._boot=claimed_boot_id
        self._nonce=nonce
        self._born_mono=time.monotonic()
        self._issued_unix=int(time.time())
        self._expires_unix=self._issued_unix+_DURATION_S
        self._used=False

    def __reduce_ex__(self,protocol):
        _fail('ORPHAN_REVIEW_CHALLENGE_NOT_SERIALIZABLE')

    def __copy__(self):
        _fail('ORPHAN_REVIEW_CHALLENGE_NOT_COPYABLE')

    def __deepcopy__(self,memo):
        _fail('ORPHAN_REVIEW_CHALLENGE_NOT_COPYABLE')

    def issue_data(self):
        """Nonce is public challenge data; never a transferable capability."""
        if self._used:_fail('ORPHAN_REVIEW_CHALLENGE_USED')
        return {
            'schema':'RBRIDGE_ORPHAN_REVIEW_CHALLENGE_DATA_V1',
            'status':'UNVERIFIED_PROCESS_CHALLENGE_DATA',
            'nonce_hex':self._nonce.hex(),
            'challenge_sha256':hashlib.sha256(self._nonce).hexdigest(),
            'claimed_pid':self._pid,
            'claimed_start_ticks':self._start_ticks,
            'claimed_boot_id':self._boot,
            'issued_unix_s':self._issued_unix,
            'expires_unix_s':self._expires_unix,
            'process_origin_verified':False,
            'owner_authenticated':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,
            'may_change_production':False}

    def consume_signed_review_data(
            self,signed_payload,signature,public_key,*,observed_pid,
            observed_start_ticks,observed_boot_id,observed_monotonic,
            observed_unix_s):
        """Consume exactly once (also on failure), returning DATA-only facts.

        Caller-supplied observed_* arguments are not trusted kernel evidence.
        They must never grant a privileged Root exception.
        """
        if self._used:_fail('ORPHAN_REVIEW_CHALLENGE_USED')
        self._used=True
        if (type(observed_pid) is not int or observed_pid!=self._pid
                or type(observed_start_ticks) is not str
                or observed_start_ticks!=self._start_ticks
                or type(observed_boot_id) is not str
                or observed_boot_id!=self._boot
                or type(observed_monotonic) not in (float,int)
                or type(observed_unix_s) is not int
                or not self._born_mono<=observed_monotonic
                         <=self._born_mono+_DURATION_S
                or not self._issued_unix<=observed_unix_s<=self._expires_unix):
            _fail('ORPHAN_REVIEW_CHALLENGE_PROCESS_OR_TIME_DRIFT')
        signed=parse_signed_release_review_data(signed_payload)
        if (signed['journal_name']!=_NAME
                or signed['intent_sha256']!=_INTENT
                or signed['source_sha']!=self._source
                or signed['tree_sha']!=self._tree
                or signed['manifest_file_sha256']!=self._file_manifest
                or signed['manifest_logical_sha256']!=self._logical_manifest
                or signed['challenge_sha256']!=hashlib.sha256(self._nonce).hexdigest()
                or signed['boot_id']!=self._boot
                or signed['issued_unix_s']!=self._issued_unix
                or signed['expires_unix_s']!=self._expires_unix):
            _fail('ORPHAN_REVIEW_CHALLENGE_SIGNED_BINDING_MISMATCH')
        result=verify_signed_release_review_data(
            signed_payload,signature,public_key)
        if (result['status']!='SIGNATURE_VALID_ONLY_UNTRUSTED_KEY'
                or result['signer_key_authenticated'] is not False
                or result['owner_authenticated'] is not False
                or result['source_provenance_verified'] is not False
                or any(result.get(k) is not False for k in
                       ('may_settle','may_launch','may_resume_qualification',
                        'may_change_production'))):
            _fail('ORPHAN_REVIEW_CHALLENGE_CRYPTO_UNQUALIFIED')
        return {
            'schema':'RBRIDGE_ORPHAN_ONE_USE_REVIEW_DATA_RESULT_V1',
            'status':'ONE_USE_SIGNED_CHALLENGE_DATA_ONLY',
            'signed_payload_sha256':result['approval_sha256'],
            'challenge_sha256':hashlib.sha256(self._nonce).hexdigest(),
            'nonce_reuse_within_object_blocked':True,
            'owner_key_trust_verified':False,
            'owner_authenticated':False,
            'process_origin_verified':False,
            'kernel_freshness_verified':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,
            'may_change_production':False}
