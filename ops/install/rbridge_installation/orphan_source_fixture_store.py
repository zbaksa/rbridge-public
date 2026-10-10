"""Create-once SOURCE fixture storage for UNAUTHENTICATED orphan review data.

This module cannot write Root evidence, repair journals, or authorize a helper.
A partial leaf from an interrupted write is deliberately never removed.
"""
import hashlib
import json
import os
import re
import stat

from .models import InstallationError,encode_report
from .orphan_intent_review_packet import build_orphan_review_packet

class OrphanFixtureStoreError(InstallationError):pass
def _fail(reason):raise OrphanFixtureStoreError(reason)

_OPEN=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC
_NAME=re.compile(r'orphan-review-[0-9a-f]{64}\.json\Z')
_KEYS={'schema','status','scope','journal_name','intent_sha256',
       'observation_sha256','claim_sha256','historical_execution',
       'historical_operation_result','owner_authenticated',
       'journal_settled','may_launch','may_resume_qualification',
       'may_change_production'}

def _hash(data):return hashlib.sha256(data).hexdigest()
def _same(a,b):return (a.st_dev,a.st_ino,a.st_mode,a.st_uid,a.st_gid,a.st_nlink)==(b.st_dev,b.st_ino,b.st_mode,b.st_uid,b.st_gid,b.st_nlink)

def _source_parent(fd):
    if (os.getuid()==0 or os.geteuid()==0 or os.getgid()!=os.getegid()
            or os.getuid()!=os.geteuid()):
        _fail('ORPHAN_STORE_SOURCE_ONLY')
    row=os.fstat(fd)
    if (not stat.S_ISDIR(row.st_mode) or row.st_uid!=os.getuid()
            or stat.S_IMODE(row.st_mode)!=0o700):
        _fail('ORPHAN_STORE_PARENT_UNQUALIFIED')
    return row

def _packet(value):
    if (type(value) is not dict or set(value)!=_KEYS
            or value['schema']!='RBRIDGE_ORPHAN_REVIEW_PACKET_V1'
            or value['status']!='UNVERIFIED_OWNER_CLAIM_UNRESOLVED'
            or value['scope']!='PURE_SERIALIZED_DATA_ONLY'
            or type(value['journal_name']) is not str
            or re.fullmatch('helper-[0-9a-f]{32}',value['journal_name']) is None
            or any(type(value[k]) is not str
                   or re.fullmatch('[0-9a-f]{64}',value[k]) is None
                   for k in ('intent_sha256','observation_sha256','claim_sha256'))
            or value['historical_execution']!='UNKNOWN'
            or value['historical_operation_result']!='UNKNOWN'
            or any(value[k] is not False for k in
                   ('owner_authenticated','journal_settled','may_launch',
                    'may_resume_qualification','may_change_production'))):
        _fail('ORPHAN_STORE_PACKET_UNQUALIFIED')

def _load(fd,name,pin):
    before_dir=_source_parent(fd)
    if (type(pin) is not str or re.fullmatch('[0-9a-f]{64}',pin) is None
            or type(name) is not str or _NAME.fullmatch(name) is None
            or name!='orphan-review-'+pin+'.json'):
        _fail('ORPHAN_STORE_NAME_INVALID')
    handle=None
    try:
        handle=os.open(name,_OPEN,dir_fd=fd)
        row=os.fstat(handle)
        if (not stat.S_ISREG(row.st_mode) or row.st_uid!=os.getuid()
                or row.st_gid!=os.getgid() or stat.S_IMODE(row.st_mode)!=0o600
                or row.st_nlink!=1 or not 0<row.st_size<=8192):
            _fail('ORPHAN_STORE_FILE_UNQUALIFIED')
        data=bytearray()
        while len(data)<=row.st_size:
            chunk=os.read(handle,min(8193,row.st_size+1-len(data)))
            if not chunk:break
            data.extend(chunk)
        if len(data)!=row.st_size or _hash(data)!=pin:
            _fail('ORPHAN_STORE_BYTES_CHANGED')
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:raise ValueError('duplicate')
                result[key]=value
            return result
        obj=json.loads(data,object_pairs_hook=unique)
        if encode_report(obj)!=bytes(data):_fail('ORPHAN_STORE_CANONICAL_CHANGED')
        _packet(obj)
        if (not _same(row,os.fstat(handle))
                or not _same(row,os.stat(name,dir_fd=fd,follow_symlinks=False))
                or not _same(before_dir,os.fstat(fd))):
            _fail('ORPHAN_STORE_INODE_CHANGED')
        return {'schema':'RBRIDGE_SOURCE_ORPHAN_STORE_READBACK_V1',
                'status':'STORED_UNQUALIFIED','name':name,'sha256':pin,
                'owner_authenticated':False,'may_launch':False,
                'may_resume_qualification':False,'may_change_production':False}
    except (OSError,ValueError,TypeError,KeyError,UnicodeError):
        _fail('ORPHAN_STORE_READ_UNQUALIFIED')
    finally:
        if handle is not None:os.close(handle)

def read_source_orphan_fixture(fd,name,pin):
    return _load(fd,name,pin)

def append_source_orphan_fixture(fd,observation,claim):
    """Exclusive create in an owned source fixture; no Root path is accepted."""
    parent=_source_parent(fd)
    packet=build_orphan_review_packet(observation,claim)
    _packet(packet)
    raw=encode_report(packet)
    if not 0<len(raw)<=8192:_fail('ORPHAN_STORE_SIZE_INVALID')
    pin=_hash(raw);name='orphan-review-'+pin+'.json'
    handle=None
    try:
        handle=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|
                       os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=fd)
        row=os.fstat(handle)
        if (not stat.S_ISREG(row.st_mode) or row.st_uid!=os.getuid()
                or row.st_gid!=os.getgid() or stat.S_IMODE(row.st_mode)!=0o600
                or row.st_nlink!=1 or row.st_size!=0):
            _fail('ORPHAN_STORE_NEW_FILE_UNQUALIFIED')
        view=memoryview(raw)
        while view:
            count=os.write(handle,view)
            if count<=0:_fail('ORPHAN_STORE_SHORT_WRITE')
            view=view[count:]
        os.fsync(handle)
        os.fsync(fd)
        if not _same(parent,os.fstat(fd)):
            _fail('ORPHAN_STORE_PARENT_CHANGED')
    except FileExistsError:_fail('ORPHAN_STORE_ALREADY_EXISTS')
    except (OSError,ValueError,TypeError):_fail('ORPHAN_STORE_CREATION_UNCERTAIN')
    finally:
        if handle is not None:os.close(handle)
    return _load(fd,name,pin)
