"""Strict read-only observation of an incomplete helper INTENT.

This is intentionally NOT a recovery, settlement, launch, or authorization API.
The pre-existing journal inspector and maintenance registry remain fail-closed.
"""
import fcntl
import hashlib
import os
from pathlib import Path
import re

from .artifact import _identity
from .helper_journal import _boot_id, _launch, _read, _record
from .ledger import _private
from .models import InstallationError, report_sha256
from .protected_copy import DIR_FLAGS, FILE_FLAGS, FilesystemAuthority, ProtectedParent

class OrphanIntentReviewError(InstallationError): pass

def _fail(reason):
    raise OrphanIntentReviewError(reason)

READONLY_ARGV=(
    '/usr/bin/systemctl','show','rbridge.service','--no-pager',
    '--property=ExecStart,User,Group,FragmentPath,DropInPaths,EnvironmentFiles,'
    'Environment,UnsetEnvironment,CPUQuotaPerSecUSec,Restart,NoNewPrivileges,'
    'ProtectSystem,ProtectHome,ReadWritePaths,ControlGroup,MainPID,ActiveState,'
    'SubState,InvocationID')
READONLY_EXE_SHA='848c70d7e2c2f43f4f93287897ac8946e8eda45e7daa5f2975d9728071856b1a'
READONLY_ARGV_SHA='67cfe5f5256112293c2840f40388f42a8db731123f757ffb3a5821260877a76a'
EMPTY_INPUT_SHA=hashlib.sha256(b'').hexdigest()
EMPTY_CHILD_SPECS_SHA=report_sha256([])
FIXTURE_BOOT='11111111-1111-1111-1111-111111111111'

def inspect_readonly_orphan_intent(parent_fd,name,expected_intent_sha256,*,production=True):
    """Inspect only; always return BLOCKED authority, even for an exact match.

    The caller must provide the exact previously observed intent digest. This
    routine cannot reconstruct a missing process PID or retroactively settle.
    Fixtures do not qualify as Root-origin evidence.
    """
    if (type(production) is not bool or type(name) is not str
            or re.fullmatch(r'helper-[0-9a-f]{32}',name) is None
            or type(expected_intent_sha256) is not str
            or re.fullmatch(r'[0-9a-f]{64}',expected_intent_sha256) is None):
        _fail('ORPHAN_REVIEW_INPUT_INVALID')
    owner=0 if production else os.getuid()
    guard=None;fd=None;lock=None;locked=False
    try:
        if production:
            from .host_backend import _assert_kernel_namespace
            if (os.getuid(),os.geteuid(),os.getgid(),os.getegid())!=(0,0,0,0):
                _fail('ORPHAN_REVIEW_ROOT_REQUIRED')
            _assert_kernel_namespace()
            guard=ProtectedParent(FilesystemAuthority(0,1027,Path('/var/lib/rbridge-maintenance'),'RUNTIME'),parent_fd)
        _private(os.fstat(parent_fd),owner,True)
        before=os.stat(name,dir_fd=parent_fd,follow_symlinks=False)
        _private(before,owner,True)
        fd=os.open(name,DIR_FLAGS,dir_fd=parent_fd)
        if _identity(before)!=_identity(os.fstat(fd)):
            _fail('ORPHAN_REVIEW_DIRECTORY_CHANGED')
        names=sorted(os.listdir(fd))
        if names!=['intent.json','journal.lock']:
            _fail('ORPHAN_REVIEW_NOT_INTENT_ONLY')
        lock=os.open('journal.lock',FILE_FLAGS,dir_fd=fd)
        lock_before=os.fstat(lock)
        _private(lock_before,owner)
        if lock_before.st_size!=0:
            _fail('ORPHAN_REVIEW_LOCK_UNQUALIFIED')
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            locked=True
        except OSError:
            _fail('ORPHAN_REVIEW_LOCK_HELD')
        raw,intent_before=_read(fd,'intent.json',owner)
        if hashlib.sha256(raw).hexdigest()!=expected_intent_sha256:
            _fail('ORPHAN_REVIEW_INTENT_SHA_CHANGED')
        scope='ROOT_FIXED_PROCESS_OBSERVATION' if production else 'FIXTURE_AUTHORITY_ONLY'
        intent=_record(raw,{'phase','boot_id','launch'},'0'*64,name[7:],scope)
        if intent['phase']!='INTENT':
            _fail('ORPHAN_REVIEW_INTENT_PHASE')
        _launch(intent['launch'])
        current_boot=_boot_id() if production else FIXTURE_BOOT
        if intent['boot_id']!=current_boot:
            _fail('ORPHAN_REVIEW_BOOT_CHANGED')
        launch=intent['launch']
        if (launch['argv']!=list(READONLY_ARGV)
                or report_sha256(launch['argv'])!=READONLY_ARGV_SHA
                or launch['executable_sha256']!=READONLY_EXE_SHA
                or launch['input_sha256']!=EMPTY_INPUT_SHA
                or launch['child_specs_sha256']!=EMPTY_CHILD_SPECS_SHA):
            _fail('ORPHAN_REVIEW_COMMAND_NOT_READONLY_PINNED')
        if (sorted(os.listdir(fd))!=names
                or _identity(before)!=_identity(os.fstat(fd))
                or _identity(before)!=_identity(os.stat(name,dir_fd=parent_fd,follow_symlinks=False))
                or _identity(lock_before)!=_identity(os.fstat(lock))
                or _identity(lock_before)!=_identity(os.stat('journal.lock',dir_fd=fd,follow_symlinks=False))
                or _identity(intent_before)!=_identity(os.stat('intent.json',dir_fd=fd,follow_symlinks=False))):
            _fail('ORPHAN_REVIEW_BYTES_OR_INODE_CHANGED')
        if guard:guard.check()
        return {
            'schema':'RBRIDGE_ORPHAN_READONLY_INTENT_OBSERVATION_V1',
            'status':'INTENT_ONLY_UNRESOLVED',
            'scope':'ROOT_READONLY_DATA_OBSERVATION_ONLY' if production else 'FIXTURE_DATA_ONLY',
            'name':name,
            'intent_sha256':expected_intent_sha256,
            'boot_relation':'CURRENT',
            'executable_sha256':READONLY_EXE_SHA,
            'argv_sha256':READONLY_ARGV_SHA,
            'historical_execution':'UNKNOWN',
            'historical_operation_result':'UNKNOWN',
            'original_process_identity':'UNAVAILABLE',
            'missing':['running.json','settled.json'],
            'may_settle':False,
            'may_launch':False,
            'may_resume_qualification':False,
            'may_change_production':False,
        }
    except (OSError,TypeError,KeyError,ValueError,UnicodeError) as error:
        if isinstance(error,OrphanIntentReviewError):
            raise
        _fail('ORPHAN_REVIEW_UNQUALIFIED')
    finally:
        if lock is not None:
            if locked:
                fcntl.flock(lock,fcntl.LOCK_UN)
            os.close(lock)
        if fd is not None:os.close(fd)
        if guard is not None:guard.close()
