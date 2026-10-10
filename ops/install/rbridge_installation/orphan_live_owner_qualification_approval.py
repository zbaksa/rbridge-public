"""Fresh same-process Root Ed25519 signature for ONE P2A qualification review.

A successful challenge proves possession of the privately held key matching
the physically enrolled Root PUBLIC key, for a narrowly scoped request.
It is NOT an operational lease and NEVER relaxes either helper guard.
No service, helper launch, journal settlement, persistent write or cutover.
"""
import base64
import hashlib
import hmac
import os
import re
import secrets
import select
import stat
import sys
import threading
import time

from .models import InstallationError, encode_report
from .orphan_dual_guard_gate import ORPHAN_NAME, ORPHAN_INTENT_SHA256

class OrphanLiveOwnerApprovalError(InstallationError):pass
def _fail(reason):raise OrphanLiveOwnerApprovalError(reason)

TTL_SECONDS=180
_LIMIT=4096
_PURPOSE='APPROVE_ONCE_P2A_READONLY_ROOT_QUALIFICATION'
_KEYS={
    'schema','scope','purpose','host','journal_name','intent_sha256',
    'custody_sha256','writer_source_sha','source_sha','tree_sha',
    'manifest_file_sha256','manifest_logical_sha256','owner_key_sha256',
    'qualification_driver_sha256','boot_id','root_pid','root_start_ticks',
    'root_thread_id','nonce_hex','issued_unix_s','expires_unix_s',
    'historical_execution','requested_service_actions',
    'production_switch_authorized','may_settle','may_change_production',
}

def _hex(value,length):
    return type(value) is str and re.fullmatch('[0-9a-f]{'+str(length)+'}',value) is not None

def _strict_pairs(rows):
    value={}
    for k,v in rows:
        if k in value:_fail('ORPHAN_LIVE_APPROVAL_DUPLICATE_FIELD')
        value[k]=v
    return value

def parse_qualification_approval_bytes(raw):
    """Validate exactly scoped owner-signable bytes, not their Root origin."""
    import json
    if type(raw) is not bytes or not 1<=len(raw)<=_LIMIT:
        _fail('ORPHAN_LIVE_APPROVAL_LENGTH')
    try:
        value=json.loads(raw.decode('utf-8',errors='strict'),
                         object_pairs_hook=_strict_pairs,
                         parse_constant=lambda _: _fail('ORPHAN_LIVE_APPROVAL_NONCANONICAL'))
    except (ValueError,TypeError,UnicodeError,RecursionError):
        _fail('ORPHAN_LIVE_APPROVAL_NONCANONICAL')
    if (type(value) is not dict or set(value)!=_KEYS
            or value['schema']!='RBRIDGE_ROOT_P2A_OWNER_APPROVAL_V1'
            or value['scope']!='ONE_READONLY_QUALIFICATION_REVIEW_ONLY'
            or value['purpose']!=_PURPOSE
            or value['host']!='aether-engine'
            or value['journal_name']!=ORPHAN_NAME
            or value['intent_sha256']!=ORPHAN_INTENT_SHA256
            or any(not _hex(value[k],64) for k in
                   ('custody_sha256','manifest_file_sha256',
                    'manifest_logical_sha256','owner_key_sha256',
                    'qualification_driver_sha256','nonce_hex'))
            or value['nonce_hex']=='0'*64
            or any(not _hex(value[k],40) for k in
                   ('writer_source_sha','source_sha','tree_sha'))
            or type(value['boot_id']) is not str
            or re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',
                            value['boot_id']) is None
            or any(type(value[k]) is not int
                   or not 1<=value[k]<=2147483647 for k in
                   ('root_pid','root_thread_id'))
            or type(value['root_start_ticks']) is not str
            or re.fullmatch('[1-9][0-9]{0,31}',value['root_start_ticks']) is None
            or type(value['issued_unix_s']) is not int
            or type(value['expires_unix_s']) is not int
            or not 1600000000<=value['issued_unix_s']<=4102444800
            or value['expires_unix_s']-value['issued_unix_s']!=TTL_SECONDS
            or value['historical_execution']!='UNKNOWN'
            or type(value['requested_service_actions']) is not list
            or value['requested_service_actions']!=[]
            or value['production_switch_authorized'] is not False
            or value['may_settle'] is not False
            or value['may_change_production'] is not False
            or encode_report(value)!=raw):
        _fail('ORPHAN_LIVE_APPROVAL_UNQUALIFIED')
    return value

def verify_qualification_signature_data(raw,signature,public_key,expected):
    """A valid signature against a supplied key is DATA, never an admission."""
    if (type(expected) is not bytes or raw!=expected
            or type(public_key) is not bytes or len(public_key)!=32
            or type(signature) is not bytes or len(signature)!=64):
        _fail('ORPHAN_LIVE_APPROVAL_BINDING_CHANGED')
    data=parse_qualification_approval_bytes(raw)
    if hashlib.sha256(public_key).hexdigest()!=data['owner_key_sha256']:
        _fail('ORPHAN_LIVE_APPROVAL_KEY_MISMATCH')
    from .orphan_owner_signed_release_review import _native_ed25519_verify
    try:_native_ed25519_verify(raw,public_key,signature)
    except (ValueError,OSError,TypeError):
        _fail('ORPHAN_LIVE_APPROVAL_SIGNATURE_INVALID')
    return {
        'schema':'RBRIDGE_ROOT_P2A_OWNER_SIGNATURE_DATA_V1',
        'status':'ENROLLED_KEY_SIGNATURE_CRYPTOGRAPHICALLY_VALID_DATA_ONLY',
        'challenge_sha256':hashlib.sha256(raw).hexdigest(),
        'key_sha256':data['owner_key_sha256'],
        'signature_valid_relative_to_supplied_key':True,
        'live_root_process_verified':False,
        'protected_key_origin_verified':False,
        'physical_custody_verified':False,
        'owner_identity_independently_authenticated':False,
        'lease_issued':False,'may_settle':False,'may_launch':False,
        'may_resume_qualification':False,'may_change_production':False,
    }

def _root_process_facts():
    from .host_backend import _assert_kernel_namespace
    from .helper_journal import _boot_id
    from .owned_process import _stat
    _assert_kernel_namespace()
    pid=os.getpid()
    token=_stat(pid)
    if (type(token) is not dict or token['pid']!=pid
            or token['state']=='Z' or not re.fullmatch(
                '[1-9][0-9]{0,31}',token['start_ticks'])):
        _fail('ORPHAN_LIVE_PROCESS_UNQUALIFIED')
    return _boot_id(),pid,token['start_ticks'],threading.get_native_id()

def _exact_root_context():
    from .orphan_root_disposition_store import _root_context
    if ((os.getuid(),os.geteuid(),os.getgid(),os.getegid())!=(0,0,0,0)
            or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or not all(os.isatty(i) for i in (0,1,2))
            or dict(os.environ)!={'PATH':'/usr/bin:/bin',
                                  'HOME':'/root','LC_ALL':'C'}):
        _fail('ORPHAN_LIVE_ROOT_CONTEXT_REQUIRED')
    origin=_root_context()
    if any(os.ttyname(i)!=os.ttyname(0) for i in (1,2)):
        _fail('ORPHAN_LIVE_TTY_MIXED')
    device=os.ttyname(0)
    s=os.stat(device,follow_symlinks=False)
    if (re.fullmatch(r'/dev/pts/[0-9]{1,10}',device) is None
            or not stat.S_ISCHR(s.st_mode) or s.st_uid not in (0,1027)):
        _fail('ORPHAN_LIVE_TTY_UNQUALIFIED')
    return origin

def collect_live_root_owner_qualification_signature(
        source_sha,tree_sha,manifest_file_sha256,
        manifest_logical_sha256,custody_sha256,writer_source_sha,
        owner_key_sha256,qualification_driver_sha256):
    """One Root foreground review, no helper, service, or persistent mutation.

    On timeout or invalid reply the challenge is discarded. The return value
    is never a token that either operative guard will accept.
    """
    if (not all(_hex(x,64) for x in
                (manifest_file_sha256,manifest_logical_sha256,custody_sha256,
                 owner_key_sha256,qualification_driver_sha256))
            or not all(_hex(x,40) for x in
                       (source_sha,tree_sha,writer_source_sha))):
        _fail('ORPHAN_LIVE_OWNER_PINS_INVALID')
    origin=_exact_root_context()
    if origin!='toolkit-'+source_sha:
        _fail('ORPHAN_LIVE_OWNER_SOURCE_NOT_RUNNING')
    from .orphan_published_source_review import inspect_published_toolkit_readonly
    from .orphan_retained_custody_observer import observe_protected_retained_custody
    from .orphan_owner_key_origin import _read_protected_owner_key
    physical=inspect_published_toolkit_readonly(
        source_sha,tree_sha,manifest_file_sha256)
    if (physical['status']!='PHYSICAL_ROOT_TOOLKIT_BYTES_MATCH_UNTRUSTED_PINS'
            or physical['manifest_logical_sha256']!=manifest_logical_sha256):
        _fail('ORPHAN_LIVE_SOURCE_CHANGED')
    custody=observe_protected_retained_custody(custody_sha256,writer_source_sha)
    if custody['status']!='ROOT_PHYSICAL_CUSTODY_AND_ORIGINAL_INTENT_MATCH_DATA_ONLY':
        _fail('ORPHAN_LIVE_CUSTODY_CHANGED')
    key=_read_protected_owner_key(owner_key_sha256)
    before=_root_process_facts()
    nonce=secrets.token_hex(32)
    if not _hex(nonce,64) or nonce=='0'*64:
        _fail('ORPHAN_LIVE_NONCE_INVALID')
    issued=int(time.time())
    born=time.monotonic()
    value={
        'schema':'RBRIDGE_ROOT_P2A_OWNER_APPROVAL_V1',
        'scope':'ONE_READONLY_QUALIFICATION_REVIEW_ONLY',
        'purpose':_PURPOSE,'host':'aether-engine',
        'journal_name':ORPHAN_NAME,'intent_sha256':ORPHAN_INTENT_SHA256,
        'custody_sha256':custody_sha256,'writer_source_sha':writer_source_sha,
        'source_sha':source_sha,'tree_sha':tree_sha,
        'manifest_file_sha256':manifest_file_sha256,
        'manifest_logical_sha256':manifest_logical_sha256,
        'owner_key_sha256':owner_key_sha256,
        'qualification_driver_sha256':qualification_driver_sha256,
        'boot_id':before[0],'root_pid':before[1],
        'root_start_ticks':before[2],'root_thread_id':before[3],
        'nonce_hex':nonce,'issued_unix_s':issued,
        'expires_unix_s':issued+TTL_SECONDS,
        'historical_execution':'UNKNOWN',
        'requested_service_actions':[],
        'production_switch_authorized':False,
        'may_settle':False,'may_change_production':False,
    }
    payload=encode_report(value)
    parse_qualification_approval_bytes(payload)
    fd=None
    try:
        fd=os.open('/dev/tty',os.O_RDWR|os.O_NOCTTY|os.O_CLOEXEC)
        if not os.isatty(fd) or os.tcgetpgrp(fd)!=os.getpgrp():
            _fail('ORPHAN_LIVE_FOREGROUND_REQUIRED')
        message=('RBRIDGE OWNER: SIGN THIS ONE READONLY QUALIFICATION REVIEW.\n'
                 'NO RESTART, NO JOURNAL SETTLEMENT, NO PRODUCTION ACTION.\n'
                 'APPROVAL_BASE64='+base64.b64encode(payload).decode('ascii')
                 +'\nSIGNATURE_HEX> ').encode('ascii')
        todo=memoryview(message)
        while todo:
            n=os.write(fd,todo)
            if n<=0:_fail('ORPHAN_LIVE_TTY_OUTPUT_FAILED')
            todo=todo[n:]
        import termios
        if not termios.tcgetattr(fd)[3]&termios.ICANON:
            _fail('ORPHAN_LIVE_TTY_NOT_CANONICAL')
        readable,_,_=select.select([fd],[],[],TTL_SECONDS)
        if not readable:_fail('ORPHAN_LIVE_SIGNATURE_TIMEOUT')
        raw=os.read(fd,130)
        if not re.fullmatch(rb'[0-9a-fA-F]{128}\n',raw):
            _fail('ORPHAN_LIVE_SIGNATURE_FORMAT_INVALID')
        signature=bytes.fromhex(raw[:-1].decode('ascii'))
        if (time.monotonic()-born>TTL_SECONDS
                or int(time.time())>issued+TTL_SECONDS
                or _root_process_facts()!=before):
            _fail('ORPHAN_LIVE_CHALLENGE_EXPIRED_OR_PROCESS_CHANGED')
        result=verify_qualification_signature_data(
            payload,signature,key,payload)
        if (_root_process_facts()!=before
                or time.monotonic()-born>TTL_SECONDS):
            _fail('ORPHAN_LIVE_PROCESS_CHANGED_AFTER_VERIFY')
        # The signature does not authorize any operation. It only supplies
        # a bounded proof for a FUTURE live, one-use qualification issuer.
        return {**result,
            'schema':'RBRIDGE_ROOT_P2A_LIVE_OWNER_SIGNATURE_REVIEW_V1',
            'status':'ROOT_KEY_POSSESSION_AND_LIVE_PROCESS_REVIEW_DATA_ONLY',
            'root_process_observed':True,
            'root_source_bytes_checked':True,
            'root_custody_bytes_checked':True,
            'root_enrolled_public_key_checked':True,
            'single_challenge_consumed':True,
            'owner_identity_independently_authenticated':False,
            'lease_issued':False,'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
    finally:
        if fd is not None:os.close(fd)
