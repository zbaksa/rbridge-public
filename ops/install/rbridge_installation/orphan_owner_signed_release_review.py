"""Detached Ed25519 proof of signed DATA, never authenticated Root authority.

This module checks a canonical *review-only* approval using the system's
OpenSSL 3 EVP Ed25519 primitive from a fixed native library path. A caller
supplies BOTH the public key and signature: even cryptographically valid
bytes DO NOT establish that the key belongs to the owner. No private key is
generated/stored and no helper, filesystem mutation or service is started.

An independently authenticated, protected Root public-key trust anchor,
fresh Root challenge and anti-replay, physically verified toolkit provenance
and process-local admission capability are separate UNIMPLEMENTED gates.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from .models import InstallationError,encode_report

class OrphanOwnerSignedDataError(InstallationError):pass
def _fail(code):raise OrphanOwnerSignedDataError(code)

_CRYPTO=Path('/usr/lib/x86_64-linux-gnu/libcrypto.so.3')
_MAX=8192
_JOURNAL='helper-0b84e8af62a287a283eabcd4eef1cdb7'
_INTENT='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'
_FIELDS={
    'schema','scope','purpose','host','journal_name','intent_sha256',
    'source_sha','tree_sha','manifest_file_sha256','manifest_logical_sha256',
    'owner_key_sha256','challenge_sha256','boot_id','issued_unix_s',
    'expires_unix_s','historical_execution','service_actions',
    'production_switch_authorized','may_settle','may_launch',
    'may_resume_qualification','may_change_production'}
_FALSE=('production_switch_authorized','may_settle','may_launch',
        'may_resume_qualification','may_change_production')
_MISSING=('PINNED_PROTECTED_OWNER_PUBLIC_KEY_TRUST_ROOT',
          'FRESH_ROOT_CHALLENGE_AND_SINGLE_USE_PROOF',
          'CURRENT_TIME_AND_BOOT_VERIFIED_BY_LIVE_ROOT',
          'PHYSICALLY_VERIFIED_PUBLISHED_TOOLKIT',
          'SEPARATE_EXPLICIT_QUALIFICATION_OWNER_APPROVAL',
          'PROCESS_LOCAL_GUARD_ADMISSION')

def _hex(value,n):
    return type(value) is str and re.fullmatch('[0-9a-f]{'+str(n)+'}',value) is not None

def parse_signed_release_review_data(raw):
    """Strictly bound review payload. Caller-supplied claims are untrusted."""
    if type(raw) is not bytes or not 1<=len(raw)<=_MAX:
        _fail('ORPHAN_OWNER_REVIEW_BYTE_LIMIT')
    def unique(rows):
        out={}
        for k,v in rows:
            if k in out:_fail('ORPHAN_OWNER_REVIEW_DUPLICATE_KEY')
            out[k]=v
        return out
    def bad_constant(_):
        _fail('ORPHAN_OWNER_REVIEW_NONCANONICAL')
    try:
        value=json.loads(raw.decode('utf-8'),object_pairs_hook=unique,
                         parse_constant=bad_constant)
        if (type(value) is not dict or set(value)!=_FIELDS
                or value['schema']!='RBRIDGE_OWNER_SIGNED_RELEASE_REVIEW_V1'
                or value['scope']!='UNVERIFIED_SIGNER_DATA_ONLY'
                or value['purpose']!='REVIEW_EXACT_P2A_TOOLKIT_BYTES_ONLY'
                or value['host']!='aether-engine'
                or value['journal_name']!=_JOURNAL
                or value['intent_sha256']!=_INTENT
                or not _hex(value['source_sha'],40)
                or not _hex(value['tree_sha'],40)
                or any(not _hex(value[k],64) for k in
                       ('manifest_file_sha256','manifest_logical_sha256',
                        'owner_key_sha256','challenge_sha256'))
                or value['challenge_sha256']=='0'*64
                or type(value['boot_id']) is not str
                or re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',
                                value['boot_id']) is None
                or type(value['issued_unix_s']) is not int
                or type(value['expires_unix_s']) is not int
                or not 1600000000<=value['issued_unix_s']<=4102444800
                or not value['issued_unix_s']<value['expires_unix_s']
                        <=value['issued_unix_s']+600
                or value['historical_execution']!='UNKNOWN'
                or type(value['service_actions']) is not list
                or value['service_actions']!=[]
                or any(value[k] is not False for k in _FALSE)
                or encode_report(value)!=raw):
            _fail('ORPHAN_OWNER_REVIEW_UNQUALIFIED')
        return value
    except (ValueError,TypeError,UnicodeError,KeyError,RecursionError):
        _fail('ORPHAN_OWNER_REVIEW_NONCANONICAL')

def _native_ed25519_verify(message,public_key,signature):
    """Fixed-path OpenSSL EVP; not a trusted *owner* public-key binding."""
    if (type(message) is not bytes or type(public_key) is not bytes
            or type(signature) is not bytes
            or len(message)>_MAX or len(public_key)!=32 or len(signature)!=64):
        _fail('ORPHAN_OWNER_ED25519_INPUT_INVALID')
    try:
        for name in ('/','/usr','/usr/lib','/usr/lib/x86_64-linux-gnu'):
            s=os.lstat(name)
            if (not stat.S_ISDIR(s.st_mode) or s.st_uid!=0
                    or s.st_mode&0o022):
                _fail('ORPHAN_OWNER_NATIVE_LIBRARY_PARENT_UNQUALIFIED')
        before=os.lstat(_CRYPTO)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=0
                or before.st_gid!=0 or before.st_mode&0o022
                or not 1024<=before.st_size<=16777216):
            _fail('ORPHAN_OWNER_NATIVE_LIBRARY_UNQUALIFIED')
        lib=ctypes.CDLL(str(_CRYPTO))
        lib.OBJ_sn2nid.argtypes=[ctypes.c_char_p]
        lib.OBJ_sn2nid.restype=ctypes.c_int
        lib.EVP_PKEY_new_raw_public_key.argtypes=[
            ctypes.c_int,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t]
        lib.EVP_PKEY_new_raw_public_key.restype=ctypes.c_void_p
        lib.EVP_MD_CTX_new.argtypes=[]
        lib.EVP_MD_CTX_new.restype=ctypes.c_void_p
        lib.EVP_DigestVerifyInit.argtypes=[
            ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,
            ctypes.c_void_p,ctypes.c_void_p]
        lib.EVP_DigestVerifyInit.restype=ctypes.c_int
        lib.EVP_DigestVerify.argtypes=[
            ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t,
            ctypes.c_void_p,ctypes.c_size_t]
        lib.EVP_DigestVerify.restype=ctypes.c_int
        lib.EVP_MD_CTX_free.argtypes=[ctypes.c_void_p]
        lib.EVP_MD_CTX_free.restype=None
        lib.EVP_PKEY_free.argtypes=[ctypes.c_void_p]
        lib.EVP_PKEY_free.restype=None
        if lib.OBJ_sn2nid(b'ED25519')!=1087:
            _fail('ORPHAN_OWNER_NATIVE_ALGORITHM_UNQUALIFIED')
        pkbuf=ctypes.create_string_buffer(public_key)
        sigbuf=ctypes.create_string_buffer(signature)
        messagebuf=ctypes.create_string_buffer(message)
        pkey=lib.EVP_PKEY_new_raw_public_key(1087,None,pkbuf,len(public_key))
        if not pkey:_fail('ORPHAN_OWNER_ED25519_KEY_INVALID')
        try:
            ctx=lib.EVP_MD_CTX_new()
            if not ctx:_fail('ORPHAN_OWNER_ED25519_CONTEXT_INVALID')
            try:
                if lib.EVP_DigestVerifyInit(ctx,None,None,None,pkey)!=1:
                    _fail('ORPHAN_OWNER_ED25519_CONTEXT_INVALID')
                verified=lib.EVP_DigestVerify(
                    ctx,sigbuf,len(signature),messagebuf,len(message))
            finally:
                lib.EVP_MD_CTX_free(ctx)
        finally:
            lib.EVP_PKEY_free(pkey)
        after=os.lstat(_CRYPTO)
        if (before.st_dev,before.st_ino,before.st_size,
                before.st_mtime_ns,before.st_ctime_ns)!=(
                after.st_dev,after.st_ino,after.st_size,
                after.st_mtime_ns,after.st_ctime_ns):
            _fail('ORPHAN_OWNER_NATIVE_LIBRARY_CHANGED')
        if verified!=1:
            _fail('ORPHAN_OWNER_ED25519_SIGNATURE_INVALID')
    except (OSError,AttributeError,TypeError):
        _fail('ORPHAN_OWNER_NATIVE_CRYPTO_UNAVAILABLE')
    return True

def verify_signed_release_review_data(raw,signature,public_key):
    """Cryptographically verify a detached signature, but grant NO authority.

    Signature authenticity is relative only to supplied public_key, whose
    origin was NOT independently authenticated. TTL, challenge and boot are
    declared DATA and not checked against live Root process evidence here.
    """
    value=parse_signed_release_review_data(raw)
    if (type(public_key) is not bytes or len(public_key)!=32
            or type(signature) is not bytes or len(signature)!=64
            or hashlib.sha256(public_key).hexdigest()!=value['owner_key_sha256']):
        _fail('ORPHAN_OWNER_REVIEW_SIGNER_KEY_MISMATCH')
    _native_ed25519_verify(raw,public_key,signature)
    return {
        'schema':'RBRIDGE_OWNER_RELEASE_CRYPTO_DATA_RESULT_V1',
        'status':'SIGNATURE_VALID_ONLY_UNTRUSTED_KEY',
        'approval_sha256':hashlib.sha256(raw).hexdigest(),
        'signer_key_sha256':hashlib.sha256(public_key).hexdigest(),
        'signature_cryptographically_valid':True,
        'signer_key_authenticated':False,
        'owner_authenticated':False,
        'challenge_freshness_verified':False,
        'boot_and_time_live_verified':False,
        'source_provenance_verified':False,
        'requirements_missing':list(_MISSING),
        'may_settle':False,'may_launch':False,
        'may_resume_qualification':False,
        'may_change_production':False}
