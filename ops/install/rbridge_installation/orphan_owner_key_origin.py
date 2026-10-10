"""Read-only protected Root public-key observer — not signer enrollment proof.

A local Root-owned Ed25519 public-key file can be read and SHA-pinned without
writes. Its existence does NOT prove *who* enrolled it or that an arbitrary
caller-supplied digest was authenticated. A valid signature relative to that
key still grants no Root helper, qualification, journal or production rights.

No key provisioning, private-key handling, subprocess or service action.
"""
import hashlib
import os
from pathlib import Path
import re
import stat
import sys

from .models import InstallationError
from .protected_copy import FILE_FLAGS,FilesystemAuthority,ProtectedParent

class OrphanOwnerKeyOriginError(InstallationError):pass
def _fail(reason):raise OrphanOwnerKeyOriginError(reason)

_PARENT=Path('/root/.rbridge-owner-trust-r1')
_LEAF='ed25519-public-key.bin'

def _sha(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None

def compare_public_key_data(public_key,claimed_sha256):
    """Only untrusted byte equality, including a claimed public-key digest."""
    if (type(public_key) is not bytes or len(public_key)!=32
            or not _sha(claimed_sha256)
            or hashlib.sha256(public_key).hexdigest()!=claimed_sha256):
        _fail('ORPHAN_OWNER_KEY_DATA_MISMATCH')
    return {'schema':'RBRIDGE_OWNER_PUBLIC_KEY_DATA_COMPARISON_V1',
            'status':'PUBLIC_KEY_DATA_MATCH_ONLY',
            'key_sha256':claimed_sha256,
            'key_enrollment_authenticated':False,
            'owner_authenticated':False,
            'root_source_provenance_verified':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,
            'may_change_production':False}

def _stat_id(s):
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,
            s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def _read_protected_owner_key(expected_key_sha256):
    """Private Root read-only helper; no absent/unsafe key is ever repaired.

    The expected SHA is EXTERNAL UNTRUSTED DATA until independently approved.
    """
    if (os.getuid(),os.geteuid(),os.getgid(),os.getegid())!=(0,0,0,0):
        _fail('ORPHAN_OWNER_KEY_ROOT_REQUIRED')
    if (not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or os.uname().nodename.split('.')[0]!='aether-engine'):
        _fail('ORPHAN_OWNER_KEY_CONTEXT_UNQUALIFIED')
    if not _sha(expected_key_sha256):
        _fail('ORPHAN_OWNER_KEY_EXPECTED_SHA_INVALID')
    from .orphan_root_disposition_store import _root_context
    _root_context()
    guard=None;fd=None
    try:
        guard=ProtectedParent(FilesystemAuthority(0,1027,_PARENT,'RUNTIME'))
        d=os.fstat(guard.fd)
        if (not stat.S_ISDIR(d.st_mode) or d.st_uid!=0 or d.st_gid!=0
                or stat.S_IMODE(d.st_mode)!=0o700
                or os.listdir(guard.fd)!=[_LEAF]):
            _fail('ORPHAN_OWNER_KEY_STORE_UNQUALIFIED')
        fd=os.open(_LEAF,FILE_FLAGS,dir_fd=guard.fd)
        before=os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=0
                or before.st_gid!=0 or before.st_nlink!=1
                or before.st_size!=32 or stat.S_IMODE(before.st_mode)!=0o400):
            _fail('ORPHAN_OWNER_KEY_FILE_UNQUALIFIED')
        raw=os.read(fd,33)
        if len(raw)!=32 or hashlib.sha256(raw).hexdigest()!=expected_key_sha256:
            _fail('ORPHAN_OWNER_KEY_BYTES_MISMATCH')
        if (_stat_id(os.fstat(fd))!=_stat_id(before)
                or _stat_id(os.stat(_LEAF,dir_fd=guard.fd,follow_symlinks=False))
                !=_stat_id(before) or os.listdir(guard.fd)!=[_LEAF]):
            _fail('ORPHAN_OWNER_KEY_FILE_CHANGED')
        guard.check()
        return raw
    except (OSError,ValueError,TypeError,UnicodeError):
        _fail('ORPHAN_OWNER_KEY_PROTECTED_READ_UNQUALIFIED')
    finally:
        if fd is not None:os.close(fd)
        if guard is not None:guard.close()

def observe_protected_owner_key(expected_key_sha256):
    """Physical Root key bytes match untrusted pin; owner identity still UNKNOWN."""
    key=_read_protected_owner_key(expected_key_sha256)
    compared=compare_public_key_data(key,expected_key_sha256)
    return {**compared,
            'schema':'RBRIDGE_OWNER_PROTECTED_PUBLIC_KEY_OBSERVATION_V1',
            'status':'ROOT_PROTECTED_KEY_BYTES_MATCH_UNTRUSTED_PIN',
            'root_public_key_bytes_observed':True,
            'key_enrollment_authenticated':False,
            'owner_authenticated':False,
            'root_source_provenance_verified':False}

def verify_signed_review_using_protected_key(
        review_payload,signature,expected_key_sha256):
    """Signed review + physical key DATA, but NO authenticated owner receipt."""
    key=_read_protected_owner_key(expected_key_sha256)
    from .orphan_owner_signed_release_review import verify_signed_release_review_data
    data=verify_signed_release_review_data(review_payload,signature,key)
    if (data['status']!='SIGNATURE_VALID_ONLY_UNTRUSTED_KEY'
            or data['signer_key_sha256']!=expected_key_sha256):
        _fail('ORPHAN_OWNER_KEY_SIGNATURE_UNQUALIFIED')
    return {**data,
            'schema':'RBRIDGE_OWNER_PROTECTED_KEY_SIGNATURE_DATA_V1',
            'status':'CRYPTO_SIGNATURE_AND_ROOT_KEY_DATA_MATCH_ONLY',
            'root_public_key_bytes_observed':True,
            'key_enrollment_authenticated':False,
            'owner_authenticated':False,
            'challenge_freshness_verified':False,
            'root_source_provenance_verified':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,
            'may_change_production':False}
