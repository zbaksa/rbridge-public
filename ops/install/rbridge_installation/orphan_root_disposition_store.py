"""Protected Root create-once evidence for an unresolved read-only INTENT.

This is NOT settlement, process admission, owner authentication or a cutover.
The original journal remains untouched, including its missing records.
"""
import fcntl
import hashlib
import os
from pathlib import Path
import re
import stat
import sys

from .artifact import _identity
from .helper_journal import _boot_id,_read
from .models import InstallationError,encode_report,report_sha256
from .orphan_disposition_preimage import disposition_preimage
from .orphan_root_custody import build_root_custody_bundle,verify_root_custody_bytes
from .orphan_intent_review import inspect_readonly_orphan_intent
from .orphan_kernel_census import collect_root_kernel_census
from .orphan_tty_review import collect_root_tty_review_data
from .protected_copy import DIR_FLAGS,FILE_FLAGS,FilesystemAuthority,ProtectedParent

class OrphanRootStoreError(InstallationError):pass
def _fail(reason):raise OrphanRootStoreError(reason)

JOURNAL='helper-0b84e8af62a287a283eabcd4eef1cdb7'
INTENT_SHA='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'
MAINTENANCE=Path('/var/lib/rbridge-maintenance')
STORE=Path('/root/.rbridge-orphan-dispositions-r1')
_ROOT_LEAF=re.compile(r'orphan-intent-[0-9a-f]{64}\.json\Z')

def _signature(s):
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,
            s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def _root_context():
    """Require exact protected source origin; no user-writable Root imports."""
    if (os.getuid(),os.geteuid(),os.getgid(),os.getegid())!=(0,0,0,0):
        _fail('ORPHAN_ROOT_STORE_ROOT_REQUIRED')
    if (not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or os.uname().nodename.split('.')[0]!='aether-engine'):
        _fail('ORPHAN_ROOT_STORE_RUNTIME_UNQUALIFIED')
    root=Path(__file__).absolute().parents[3]
    if (root.parent!=Path('/usr/local/libexec/rbridge/releases')
            or re.fullmatch('toolkit-[0-9a-f]{40}',root.name) is None):
        _fail('ORPHAN_ROOT_STORE_CODE_ORIGIN_UNQUALIFIED')
    paths=(Path('/'),Path('/usr'),Path('/usr/local'),
           Path('/usr/local/libexec'),Path('/usr/local/libexec/rbridge'),
           Path('/usr/local/libexec/rbridge/releases'),root,
           root/'ops',root/'ops/install',
           root/'ops/install/rbridge_installation',
           Path(__file__).absolute())
    for index,p in enumerate(paths):
        row=os.lstat(p)
        kind=stat.S_ISREG if index==len(paths)-1 else stat.S_ISDIR
        if (not kind(row.st_mode) or row.st_uid!=0 or row.st_gid!=0
                or row.st_mode&0o022 or stat.S_ISLNK(row.st_mode)):
            _fail('ORPHAN_ROOT_STORE_CODE_ORIGIN_UNQUALIFIED')
    from .host_backend import _assert_kernel_namespace
    _assert_kernel_namespace()
    return root.name

def _check_journal(journal_fd,before,lock_fd,lock_before,original_signature):
    now=os.fstat(journal_fd)
    if (_signature(now)!=_signature(before)
            or sorted(os.listdir(journal_fd))!=['intent.json','journal.lock']
            or _signature(os.stat('intent.json',dir_fd=journal_fd,follow_symlinks=False))
            !=original_signature
            or _signature(os.stat('journal.lock',dir_fd=journal_fd,follow_symlinks=False))
            !=_signature(lock_before)
            or _signature(os.fstat(lock_fd))!=_signature(lock_before)):
        _fail('ORPHAN_ROOT_STORE_JOURNAL_CHANGED')

def _record(preimage,origin,original):
    """Internal Root record remains explicitly non-authorizing."""
    if (type(preimage) is not dict
            or preimage.get('schema')!='RBRIDGE_ORPHAN_PROTECTED_DISPOSITION_PREIMAGE_V1'
            or preimage.get('scope')!='SERIALIZED_PREIMAGE_ONLY'
            or preimage.get('status')!='INTENT_ONLY_UNRESOLVED_REVIEWED'
            or preimage.get('journal_name')!=JOURNAL
            or preimage.get('intent_sha256')!=INTENT_SHA
            or any(preimage.get(k) is not False for k in
                   ('owner_authenticated','root_provenance_verified',
                    'journal_settled','may_launch','may_resume_qualification',
                    'may_change_production'))):
        _fail('ORPHAN_ROOT_STORE_PREIMAGE_INVALID')
    if (type(origin) is not str
            or re.fullmatch('toolkit-[0-9a-f]{40}',origin) is None
            or type(original) is not tuple or len(original)!=9
            or any(type(x) is not int or x<0 for x in original)):
        _fail('ORPHAN_ROOT_STORE_ORIGIN_INVALID')
    return {
        'schema':'RBRIDGE_ROOT_ORPHAN_INTENT_EVIDENCE_V1',
        'status':'ROOT_RECORD_ONLY_INTENT_UNRESOLVED',
        'scope':'PROTECTED_APPEND_ONLY_DATA_NOT_AUTHORIZATION',
        'journal_name':JOURNAL,'intent_sha256':INTENT_SHA,
        'preimage_sha256':report_sha256(preimage),
        'root_source_release':origin,
        'original_intent_identity':[str(x) for x in original],
        'historical_execution':'UNKNOWN','historical_result':'UNKNOWN',
        'owner_authenticated':False,'journal_settled':False,
        'may_settle':False,'may_launch':False,
        'may_resume_qualification':False,'may_change_production':False}

def append_root_orphan_review(owner_claim):
    """New Root-only file, but never any change in helper admission policy."""
    origin=_root_context()
    maintenance=None;store=None;journal_fd=None;lock_fd=None
    try:
        maintenance=ProtectedParent(FilesystemAuthority(0,1027,MAINTENANCE,'RUNTIME'))
        observation=inspect_readonly_orphan_intent(
            maintenance.fd,JOURNAL,INTENT_SHA,production=True)
        journal_fd=os.open(JOURNAL,DIR_FLAGS,dir_fd=maintenance.fd)
        directory_before=os.fstat(journal_fd)
        original=os.stat('intent.json',dir_fd=journal_fd,follow_symlinks=False)
        if (not stat.S_ISREG(original.st_mode) or original.st_uid!=0
                or original.st_gid!=0 or stat.S_IMODE(original.st_mode)!=0o600
                or original.st_nlink!=1):
            _fail('ORPHAN_ROOT_STORE_INTENT_METADATA')
        original_signature=_signature(original)
        lock_fd=os.open('journal.lock',FILE_FLAGS,dir_fd=journal_fd)
        lock_before=os.fstat(lock_fd)
        if (not stat.S_ISREG(lock_before.st_mode)
                or lock_before.st_uid!=0 or lock_before.st_gid!=0
                or stat.S_IMODE(lock_before.st_mode)!=0o600
                or lock_before.st_size!=0):
            _fail('ORPHAN_ROOT_STORE_LOCK_METADATA')
        try:fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:_fail('ORPHAN_ROOT_STORE_LOCK_HELD')
        original_bytes,original_read=_read(journal_fd,'intent.json',0)
        if (hashlib.sha256(original_bytes).hexdigest()!=INTENT_SHA
                or _signature(original_read)!=original_signature):
            _fail('ORPHAN_ROOT_STORE_INTENT_BYTES_CHANGED')
        review=collect_root_tty_review_data(observation,owner_claim)
        census=collect_root_kernel_census()
        preimage=disposition_preimage(observation,owner_claim,review,census)
        maintenance.check()
        _check_journal(journal_fd,directory_before,lock_fd,lock_before,original_signature)
        if (_signature(os.stat('intent.json',dir_fd=journal_fd,follow_symlinks=False))
                !=original_signature or _boot_id()!=census['boot_id']):
            _fail('ORPHAN_ROOT_STORE_INTENT_OR_BOOT_CHANGED')
        record=_record(preimage,origin,original_signature)
        bundle=build_root_custody_bundle(record,observation,owner_claim,
                                         review,census,preimage)
        payload=encode_report(bundle)
        if len(payload)>16384:_fail('ORPHAN_ROOT_STORE_BYTE_LIMIT')
        digest=hashlib.sha256(payload).hexdigest()
        leaf='orphan-intent-'+digest+'.json'
        store=ProtectedParent(FilesystemAuthority(0,1027,STORE,'RUNTIME'))
        s=os.fstat(store.fd)
        if (not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_gid!=0
                or stat.S_IMODE(s.st_mode)!=0o700 or os.listdir(store.fd)):
            _fail('ORPHAN_ROOT_STORE_NOT_EMPTY_OR_PROTECTED')
        handle=None
        try:
            handle=os.open(leaf,os.O_RDWR|os.O_CREAT|os.O_EXCL|
                           os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=store.fd)
            view=memoryview(payload)
            while view:
                written=os.write(handle,view)
                if written<=0:_fail('ORPHAN_ROOT_STORE_SHORT_WRITE')
                view=view[written:]
            os.fsync(handle)
            os.fchmod(handle,0o400)
            os.fsync(handle)
            os.fsync(store.fd)
            row=os.fstat(handle)
            named=os.stat(leaf,dir_fd=store.fd,follow_symlinks=False)
            os.lseek(handle,0,os.SEEK_SET)
            readback=os.read(handle,len(payload)+1)
            if (not stat.S_ISREG(row.st_mode) or row.st_uid!=0
                    or row.st_gid!=0 or stat.S_IMODE(row.st_mode)!=0o400
                    or row.st_nlink!=1 or len(readback)!=len(payload)
                    or readback!=payload or _signature(row)!=_signature(named)
                    or sorted(os.listdir(store.fd))!=[leaf]):
                _fail('ORPHAN_ROOT_STORE_READBACK')
            custody=verify_root_custody_bytes(readback)
            if (custody['bundle_sha256']!=digest
                    or custody['record_sha256']!=report_sha256(record)):
                _fail('ORPHAN_ROOT_STORE_CUSTODY_READBACK')
            maintenance.check();store.check()
            _check_journal(journal_fd,directory_before,lock_fd,lock_before,original_signature)
            if (_signature(os.stat('intent.json',dir_fd=journal_fd,follow_symlinks=False))
                    !=original_signature):
                _fail('ORPHAN_ROOT_STORE_INTENT_CHANGED')
        finally:
            if handle is not None:os.close(handle)
        return {'schema':'RBRIDGE_ROOT_ORPHAN_STORE_RECEIPT_V2',
                'status':'ROOT_DATA_ONLY_STORED',
                'custody_status':custody['status'],
                'bundle_sha256':digest,
                'record_sha256':custody['record_sha256'],
                'file_name':leaf,
                'original_intent_unchanged':True,'historical_execution':'UNKNOWN',
                'owner_authenticated':False,'may_settle':False,'may_launch':False,
                'may_resume_qualification':False,'may_change_production':False}
    except (OSError,ValueError,TypeError,UnicodeError):
        _fail('ORPHAN_ROOT_STORE_UNQUALIFIED')
    finally:
        if lock_fd is not None:os.close(lock_fd)
        if journal_fd is not None:os.close(journal_fd)
        if store is not None:store.close()
        if maintenance is not None:maintenance.close()
