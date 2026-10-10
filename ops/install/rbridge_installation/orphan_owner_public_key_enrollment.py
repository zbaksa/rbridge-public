"""Direct-TTY create-once Root PUBLIC key enrollment, with NO helper authority.

Not a root recovery, owner identity attestation, journal settlement, helper
admission, or production activation. Never accept or store the private key.
Only an independently approved, published and verified Root toolkit may run
the live function. No automatic directory/file recovery on partial failure.
"""
import hashlib
import hmac
import os
from pathlib import Path
import re
import stat
import sys

from .models import InstallationError
from .protected_copy import DIR_FLAGS,FILE_FLAGS

class OrphanOwnerEnrollmentError(InstallationError): pass
def _fail(reason): raise OrphanOwnerEnrollmentError(reason)

_ROOT=Path('/root')
_STORE='.rbridge-owner-trust-r1'
_LEAF='ed25519-public-key.bin'
_CONFIRM='ENROLL-ED25519-PUBLIC-KEY '

def review_public_key_enrollment_data(public_key,expected_sha256):
    """Caller-supplied key and SHA match as DATA; no owner is authenticated."""
    if (type(public_key) is not bytes or len(public_key)!=32
            or public_key==bytes(32) or type(expected_sha256) is not str
            or re.fullmatch('[0-9a-f]{64}',expected_sha256) is None
            or not hmac.compare_digest(
                hashlib.sha256(public_key).hexdigest(),expected_sha256)):
        _fail('ORPHAN_OWNER_ENROLL_PUBLIC_KEY_INVALID')
    return {
        'schema':'RBRIDGE_OWNER_ENROLLMENT_DATA_REVIEW_V1',
        'status':'PUBLIC_KEY_BYTES_MATCH_UNTRUSTED_FINGERPRINT',
        'public_key_sha256':expected_sha256,
        'public_key_bytes':32,
        'owner_key_enrolled':False,
        'owner_authenticated':False,
        'may_settle':False,
        'may_launch':False,
        'may_resume_qualification':False,
        'may_change_production':False}

def _stat_identity(s):
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,
            s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def _protected_directory_id(s):
    # Parent directory mtime/ctime are expected to change upon mkdir.
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid)

def _read_direct_owner_tty(fingerprint):
    """An attended foreground Root TTY confirms fingerprint, NOT identity."""
    tty_fd=None
    try:
        tty_fd=os.open('/dev/tty',os.O_RDWR|os.O_CLOEXEC|os.O_NOCTTY)
        row=os.fstat(tty_fd)
        if (not stat.S_ISCHR(row.st_mode) or not os.isatty(tty_fd)
                or os.tcgetpgrp(tty_fd)!=os.getpgrp()):
            _fail('ORPHAN_OWNER_ENROLL_FOREGROUND_TTY_REQUIRED')
        text=("RBridge PUBLIC KEY create-once review\n"
              "NO JOURNAL SETTLEMENT OR HELPER QUALIFICATION\n"
              "Confirm this fingerprint OUT-OF-BAND with your Windows key:\n"
              +fingerprint.upper()+"\n"
              "Type exactly: "+_CONFIRM+fingerprint.upper()+"\n> ")
        os.write(tty_fd,text.encode('ascii'))
        value=bytearray()
        while len(value)<=127:
            chunk=os.read(tty_fd,1)
            if not chunk:_fail('ORPHAN_OWNER_ENROLL_TTY_EOF')
            if chunk==b'\n':break
            if chunk!=b'\r':value.extend(chunk)
        else:_fail('ORPHAN_OWNER_ENROLL_TTY_TOO_LONG')
        if not hmac.compare_digest(
                bytes(value),(_CONFIRM+fingerprint.upper()).encode('ascii')):
            _fail('ORPHAN_OWNER_ENROLL_TTY_ACK_MISMATCH')
        return True
    except (OSError,UnicodeError):
        _fail('ORPHAN_OWNER_ENROLL_TTY_UNAVAILABLE')
    finally:
        if tty_fd is not None:os.close(tty_fd)

def enroll_owner_public_key_create_once(public_key,expected_sha256):
    """Store exactly one Root-owned 32-byte PUBLIC key, never replace.

    Source origin, names, and filesystem ancestry must be reviewed before
    running. Call the future installer only from an explicitly approved
    published immutable Root toolkit under isolated Python on the real host.
    """
    reviewed=review_public_key_enrollment_data(public_key,expected_sha256)
    if (os.getuid(),os.geteuid(),os.getgid(),os.getegid())!=(0,0,0,0):
        _fail('ORPHAN_OWNER_ENROLL_ROOT_REQUIRED')
    if (not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or os.uname().nodename.split('.')[0]!='aether-engine'):
        _fail('ORPHAN_OWNER_ENROLL_RUNTIME_UNQUALIFIED')
    from .orphan_root_disposition_store import _root_context
    origin=_root_context()
    for path in ('/', '/root'):
        row=os.lstat(path)
        if (not stat.S_ISDIR(row.st_mode) or stat.S_ISLNK(row.st_mode)
                or row.st_uid!=0 or row.st_gid!=0
                or row.st_mode&0o022):
            _fail('ORPHAN_OWNER_ENROLL_PARENT_UNPROTECTED')
    parent=None;store=None;file_fd=None
    try:
        parent=os.open(_ROOT,DIR_FLAGS)
        before=os.fstat(parent)
        if (before.st_uid!=0 or before.st_gid!=0
                or stat.S_IMODE(before.st_mode)!=0o700
                or _stat_identity(before)!=_stat_identity(os.lstat(_ROOT))):
            _fail('ORPHAN_OWNER_ENROLL_ROOT_PARENT_CHANGED')
        try:
            os.stat(_STORE,dir_fd=parent,follow_symlinks=False)
        except FileNotFoundError:pass
        else:_fail('ORPHAN_OWNER_ENROLL_ALREADY_EXISTS')
        # Approval is entered ONLY on the foreground controlling TTY.
        _read_direct_owner_tty(expected_sha256)
        if _protected_directory_id(os.fstat(parent))!=_protected_directory_id(before):
            _fail('ORPHAN_OWNER_ENROLL_ROOT_PARENT_CHANGED')
        try:
            os.stat(_STORE,dir_fd=parent,follow_symlinks=False)
        except FileNotFoundError:pass
        else:_fail('ORPHAN_OWNER_ENROLL_ALREADY_EXISTS')
        os.umask(0o077)
        # No replacement; on a crash the partial directory remains BLOCKED.
        os.mkdir(_STORE,0o700,dir_fd=parent)
        os.fsync(parent)
        store=os.open(_STORE,DIR_FLAGS,dir_fd=parent)
        row=os.fstat(store)
        if (not stat.S_ISDIR(row.st_mode) or row.st_uid!=0
                or row.st_gid!=0 or stat.S_IMODE(row.st_mode)!=0o700
                or os.listdir(store)):
            _fail('ORPHAN_OWNER_ENROLL_STORE_UNQUALIFIED')
        file_fd=os.open(_LEAF,os.O_RDWR|os.O_CREAT|os.O_EXCL|
                        os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=store)
        written=os.write(file_fd,public_key)
        if written!=32:_fail('ORPHAN_OWNER_ENROLL_SHORT_WRITE')
        os.fsync(file_fd)
        os.fchmod(file_fd,0o400)
        os.fsync(file_fd)
        os.fsync(store)
        os.lseek(file_fd,0,os.SEEK_SET)
        readback=os.read(file_fd,33)
        a=os.fstat(file_fd)
        b=os.stat(_LEAF,dir_fd=store,follow_symlinks=False)
        if (readback!=public_key or not stat.S_ISREG(a.st_mode)
                or a.st_uid!=0 or a.st_gid!=0 or a.st_nlink!=1
                or a.st_size!=32 or stat.S_IMODE(a.st_mode)!=0o400
                or _stat_identity(a)!=_stat_identity(b)
                or not hmac.compare_digest(
                    hashlib.sha256(readback).hexdigest(),expected_sha256)
                or os.listdir(store)!=[_LEAF]
                or _protected_directory_id(os.fstat(parent))
                   !=_protected_directory_id(before)):
            _fail('ORPHAN_OWNER_ENROLL_READBACK_FAILED')
        os.fsync(store)
        os.fsync(parent)
        return {
            'schema':'RBRIDGE_OWNER_PUBLIC_KEY_ENROLLMENT_RECEIPT_V1',
            'status':'ROOT_PUBLIC_KEY_DATA_STORED_NO_AUTHORIZATION',
            'public_key_sha256':reviewed['public_key_sha256'],
            'source_release':origin,
            'public_key_bytes':32,
            'store_create_once':True,
            'tty_fingerprint_acknowledged':True,
            'owner_identity_independently_authenticated':False,
            'root_qualifier_authorized':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
    except (OSError,TypeError,UnicodeError):
        _fail('ORPHAN_OWNER_ENROLL_OPERATION_UNQUALIFIED')
    finally:
        if file_fd is not None:os.close(file_fd)
        if store is not None:os.close(store)
        if parent is not None:os.close(parent)
