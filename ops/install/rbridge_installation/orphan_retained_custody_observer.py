"""Independent protected Root custody readback for one unresolved helper INTENT.

A physically retained, canonical disposition records UNKNOWN history. It never
settles the original journal, authenticates the owner, provides a lease, admits
a helper, or grants production action. No persistent writes or subprocesses.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from .models import InstallationError
from .orphan_root_custody import MAX_CUSTODY_BYTES, verify_root_custody_bytes
from .orphan_root_disposition_store import (
    JOURNAL, INTENT_SHA, MAINTENANCE, STORE, _check_journal, _root_context,
    _signature)
from .helper_journal import _read
from .protected_copy import DIR_FLAGS, FILE_FLAGS, FilesystemAuthority, ProtectedParent

class OrphanRetainedCustodyError(InstallationError):pass
def _fail(reason):raise OrphanRetainedCustodyError(reason)

def _hash(text,length):
    return type(text) is str and re.fullmatch('[0-9a-f]{'+str(length)+'}',text) is not None

def compare_retained_custody_data(raw,expected_sha,writer_source,
                                  original_intent_sha256,original_identity,
                                  journal_children):
    """Strict in-memory DATA comparison; caller-provided facts are untrusted.

    This pure comparator cannot qualify Root or attest physical file origin.
    """
    if (type(raw) is not bytes or not _hash(expected_sha,64)
            or not _hash(writer_source,40)
            or not _hash(original_intent_sha256,64)
            or type(original_identity) is not tuple
            or len(original_identity)!=9
            or any(type(n) is not int or n<0 for n in original_identity)
            or type(journal_children) is not list
            or journal_children!=['intent.json','journal.lock']):
        _fail('ORPHAN_RETAINED_INPUT_UNQUALIFIED')
    result=verify_root_custody_bytes(raw)
    if (result['status']!='RETAINED_DATA_VERIFIED_ONLY'
            or result['bundle_sha256']!=expected_sha
            or original_intent_sha256!=INTENT_SHA):
        _fail('ORPHAN_RETAINED_CUSTODY_DIGEST_CHANGED')
    bundle=json.loads(raw)
    record=bundle['record']
    if (record['journal_name']!=JOURNAL
            or record['intent_sha256']!=INTENT_SHA
            or record['root_source_release']!='toolkit-'+writer_source
            or record['original_intent_identity']!=[str(n) for n in original_identity]
            or bundle['historical_execution']!='UNKNOWN'
            or bundle['historical_result']!='UNKNOWN'
            or bundle['tty_review']['tty_device_uid'] not in (0,1027)
            or any(bundle.get(key) is not False for key in
                   ('owner_authenticated','may_settle','may_launch',
                    'may_resume_qualification','may_change_production'))):
        _fail('ORPHAN_RETAINED_ORIGIN_DATA_MISMATCH')
    return {
        'schema':'RBRIDGE_ORPHAN_RETAINED_CUSTODY_COMPARISON_V1',
        'status':'CANONICAL_INTENT_AND_CUSTODY_DATA_MATCH_ONLY',
        'custody_sha256':expected_sha,
        'writer_source_sha':writer_source,
        'original_journal_data_matches':True,
        'historical_execution':'UNKNOWN','historical_result':'UNKNOWN',
        'source_provenance_verified':False,'owner_authenticated':False,
        'journal_settled':False,'may_settle':False,'may_launch':False,
        'may_resume_qualification':False,'may_change_production':False}

def observe_protected_retained_custody(expected_sha,writer_source):
    """Read physically retained Root custody and original journal; never act.

    No caller-supplied source hash or receipt is an authenticated authority.
    This routine is a ROOT DATA observer only, not an orphan disposition.
    """
    if ((os.getuid(),os.geteuid(),os.getgid(),os.getegid())!=(0,0,0,0)
            or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'):
        _fail('ORPHAN_RETAINED_ROOT_CONTEXT_REQUIRED')
    if not _hash(expected_sha,64) or not _hash(writer_source,40):
        _fail('ORPHAN_RETAINED_PINS_INVALID')
    _root_context()
    store=maintenance=None
    leaf_fd=journal_fd=lock_fd=None
    locked=False
    try:
        store=ProtectedParent(FilesystemAuthority(0,1027,STORE,'RUNTIME'))
        d=os.fstat(store.fd)
        name='orphan-intent-'+expected_sha+'.json'
        if (not stat.S_ISDIR(d.st_mode) or d.st_uid!=d.st_gid!=0
                or stat.S_IMODE(d.st_mode)!=0o700
                or os.listdir(store.fd)!=[name]):
            _fail('ORPHAN_RETAINED_STORE_UNQUALIFIED')
        leaf_fd=os.open(name,FILE_FLAGS,dir_fd=store.fd)
        before=os.fstat(leaf_fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=before.st_gid!=0
                or stat.S_IMODE(before.st_mode)!=0o400
                or before.st_nlink!=1
                or not 1<=before.st_size<=MAX_CUSTODY_BYTES):
            _fail('ORPHAN_RETAINED_LEAF_UNQUALIFIED')
        raw=os.read(leaf_fd,MAX_CUSTODY_BYTES+1)
        if (len(raw)!=before.st_size
                or _signature(os.fstat(leaf_fd))!=_signature(before)
                or _signature(os.stat(name,dir_fd=store.fd,follow_symlinks=False))
                   !=_signature(before)):
            _fail('ORPHAN_RETAINED_FILE_CHANGED')
        maintenance=ProtectedParent(FilesystemAuthority(0,1027,MAINTENANCE,'RUNTIME'))
        journal_before=os.stat(JOURNAL,dir_fd=maintenance.fd,follow_symlinks=False)
        if (not stat.S_ISDIR(journal_before.st_mode)
                or journal_before.st_uid!=journal_before.st_gid!=0
                or stat.S_IMODE(journal_before.st_mode)!=0o700):
            _fail('ORPHAN_RETAINED_JOURNAL_UNQUALIFIED')
        journal_fd=os.open(JOURNAL,DIR_FLAGS,dir_fd=maintenance.fd)
        if _signature(os.fstat(journal_fd))!=_signature(journal_before):
            _fail('ORPHAN_RETAINED_JOURNAL_CHANGED')
        members=sorted(os.listdir(journal_fd))
        if members!=['intent.json','journal.lock']:
            _fail('ORPHAN_RETAINED_JOURNAL_NOT_INTENT_ONLY')
        lock_fd=os.open('journal.lock',FILE_FLAGS,dir_fd=journal_fd)
        lock_before=os.fstat(lock_fd)
        if (not stat.S_ISREG(lock_before.st_mode) or lock_before.st_uid!=lock_before.st_gid!=0
                or stat.S_IMODE(lock_before.st_mode)!=0o600
                or lock_before.st_size!=0 or lock_before.st_nlink!=1):
            _fail('ORPHAN_RETAINED_LOCK_UNQUALIFIED')
        try:fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB);locked=True
        except OSError:_fail('ORPHAN_RETAINED_JOURNAL_LOCKED')
        intent,identity=_read(journal_fd,'intent.json',0)
        if _signature(identity)!=_signature(os.stat('intent.json',dir_fd=journal_fd,follow_symlinks=False)):
            _fail('ORPHAN_RETAINED_INTENT_CHANGED')
        comparison=compare_retained_custody_data(raw,expected_sha,writer_source,
            hashlib.sha256(intent).hexdigest(),_signature(identity),members)
        _check_journal(journal_fd,journal_before,lock_fd,lock_before,_signature(identity))
        maintenance.check();store.check()
        if (_signature(os.fstat(leaf_fd))!=_signature(before)
                or _signature(os.stat(name,dir_fd=store.fd,follow_symlinks=False))
                   !=_signature(before)
                or os.listdir(store.fd)!=[name]):
            _fail('ORPHAN_RETAINED_FILE_CHANGED_AFTER_READ')
        return {**comparison,
            'schema':'RBRIDGE_ORPHAN_PROTECTED_CUSTODY_OBSERVATION_V1',
            'status':'ROOT_PHYSICAL_CUSTODY_AND_ORIGINAL_INTENT_MATCH_DATA_ONLY',
            'protected_custody_bytes_observed':True,
            'original_journal_unmodified':True,
            'source_provenance_verified':False,
            'owner_authenticated':False,'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
    except (OSError,ValueError,TypeError,UnicodeError):
        _fail('ORPHAN_RETAINED_PHYSICAL_REVIEW_UNQUALIFIED')
    finally:
        if lock_fd is not None:
            if locked:fcntl.flock(lock_fd,fcntl.LOCK_UN)
            os.close(lock_fd)
        if journal_fd is not None:os.close(journal_fd)
        if leaf_fd is not None:os.close(leaf_fd)
        if maintenance is not None:maintenance.close()
        if store is not None:store.close()
