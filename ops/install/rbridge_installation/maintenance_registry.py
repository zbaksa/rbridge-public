"""Cold maintenance inventory. A dead flock never hides an unfinished ledger.

Read-only scans preserve all names/bytes. Only the caller's privately opened
current ledger may be excepted; unknown helpers, partial backups and unclassified
objects block a fresh transaction rather than being repaired or deleted.
"""
import fcntl
import hashlib
import os
from pathlib import Path
import re
import stat
import time
from .artifact import _identity
from .ledger import Ledger,_decode,_strict_json
from .models import InstallationError,encode_report,report_sha256
from .protected_copy import DIR_FLAGS,FILE_FLAGS,ProtectedParent,FilesystemAuthority


class RegistryError(InstallationError):pass


def _fail(reason):raise RegistryError(reason)


def assert_no_unfinished_transactions(parent_fd,current=None,production=True):
    owner=0 if production else os.getuid();guard=None;deadline=time.monotonic()+60;total=0
    if production:
        from .host_backend import _assert_kernel_namespace
        if os.getuid()!=0 or os.geteuid()!=0:_fail('MAINTENANCE_REGISTRY_ROOT_REQUIRED')
        _assert_kernel_namespace()
    if current is not None:
        if (type(current) is not Ledger or current.closed or current.uid!=owner
                or production and (type(current.guard) is not ProtectedParent or not current.guard.authority.production)):
            _fail('MAINTENANCE_CURRENT_LEDGER_UNQUALIFIED')
        current._check()
        if (os.fstat(parent_fd).st_dev,os.fstat(parent_fd).st_ino)!=(os.fstat(current.parent_fd).st_dev,os.fstat(current.parent_fd).st_ino):
            _fail('MAINTENANCE_CURRENT_LEDGER_UNQUALIFIED')
    def timely():
        if time.monotonic()>=deadline:_fail('MAINTENANCE_REGISTRY_DEADLINE')
    def private(row,directory=False,hardlinks=False,mode=None):
        expected=0o700 if directory else (0o600 if mode is None else mode)
        if (row.st_uid!=owner or row.st_mode&0o7777!=expected
                or not (stat.S_ISDIR(row.st_mode) if directory else stat.S_ISREG(row.st_mode))
                or not directory and (row.st_nlink<1 or not hardlinks and row.st_nlink!=1)):
            _fail('MAINTENANCE_REGISTRY_OBJECT_UNQUALIFIED')
    def read(parent,name,limit=67108864,mode=None):
        nonlocal total
        timely();fd=os.open(name,FILE_FLAGS,dir_fd=parent)
        try:
            before=os.fstat(fd);private(before,mode=mode)
            if before.st_size>limit:_fail('MAINTENANCE_REGISTRY_BYTE_LIMIT')
            raw=bytearray()
            while len(raw)<=before.st_size:
                timely();chunk=os.read(fd,min(1048576,before.st_size+1-len(raw)))
                if not chunk:break
                raw.extend(chunk)
            total+=len(raw)
            if total>536870912:_fail('MAINTENANCE_REGISTRY_BYTE_LIMIT')
            if (len(raw)!=before.st_size or _identity(before)!=_identity(os.fstat(fd))
                    or _identity(before)!=_identity(os.stat(name,dir_fd=parent,follow_symlinks=False))):
                _fail('MAINTENANCE_REGISTRY_CHANGED')
            return bytes(raw)
        finally:os.close(fd)
    def directory(parent,name):
        timely();before=os.stat(name,dir_fd=parent,follow_symlinks=False);private(before,True)
        fd=os.open(name,DIR_FLAGS,dir_fd=parent)
        if _identity(before)!=_identity(os.fstat(fd)):os.close(fd);_fail('MAINTENANCE_REGISTRY_CHANGED')
        return fd,before
    def check_named(parent,name,fd,before):
        if _identity(before)!=_identity(os.fstat(fd)) or _identity(before)!=_identity(os.stat(name,dir_fd=parent,follow_symlinks=False)):
            _fail('MAINTENANCE_REGISTRY_CHANGED')
    def evidence(name):
        fd,before=directory(parent_fd,name);rows=[]
        try:
            names=sorted(os.listdir(fd))
            if len(names)>128:_fail('MAINTENANCE_REGISTRY_EVIDENCE_UNQUALIFIED')
            for i,entry in enumerate(names,1):
                if not re.fullmatch(f'{i:03d}-[a-z][a-z0-9-]{{0,63}}\\.json',entry):_fail('MAINTENANCE_REGISTRY_EVIDENCE_UNQUALIFIED')
                raw=read(fd,entry);value=_strict_json(raw)
                if encode_report(value)!=raw:_fail('MAINTENANCE_REGISTRY_EVIDENCE_UNQUALIFIED')
                rows.append((entry,hashlib.sha256(raw).hexdigest(),value))
            if names!=sorted(os.listdir(fd)):_fail('MAINTENANCE_REGISTRY_CHANGED')
            check_named(parent_fd,name,fd,before);return rows
        finally:os.close(fd)
    def metadata_tree(fd,depth=0):
        timely()
        if depth>128:_fail('MAINTENANCE_REGISTRY_ENTRY_LIMIT')
        before=os.fstat(fd);names=sorted(os.listdir(fd))
        if len(names)>100000:_fail('MAINTENANCE_REGISTRY_ENTRY_LIMIT')
        for name in names:
            row=os.stat(name,dir_fd=fd,follow_symlinks=False)
            if stat.S_ISDIR(row.st_mode):
                child,initial=directory(fd,name)
                try:metadata_tree(child,depth+1);check_named(fd,name,child,initial)
                finally:os.close(child)
            else:private(row,hardlinks=True)
        if names!=sorted(os.listdir(fd)) or _identity(before)!=_identity(os.fstat(fd)):_fail('MAINTENANCE_REGISTRY_CHANGED')
    transactions={};proofs=[];helpers=[]
    try:
        if production:guard=ProtectedParent(FilesystemAuthority(0,1027,Path('/var/lib/rbridge-maintenance'),'RUNTIME'),parent_fd)
        before=os.fstat(parent_fd);private(before,True);names=sorted(os.listdir(parent_fd))
        if len(names)>16384:_fail('MAINTENANCE_REGISTRY_ENTRY_LIMIT')
        for name in names:
            timely()
            if re.fullmatch('[0-9a-f]{32}',name):
                fd,initial=directory(parent_fd,name);lock=None
                try:
                    if set(os.listdir(fd))!={'ledger.json','ledger.lock'}:_fail('MAINTENANCE_REGISTRY_UNFINISHED')
                    own=current is not None and current.transaction_id==name
                    if own:
                        current._check();current.read()
                    else:
                        lock=os.open('ledger.lock',FILE_FLAGS,dir_fd=fd);private(os.fstat(lock))
                        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                        except OSError:_fail('MAINTENANCE_REGISTRY_UNFINISHED')
                    raw=read(fd,'ledger.json',8388608);record=_decode(raw,name);entries=record['entries']
                    if not own and (not entries or entries[-1]['marker'] not in ('ACCEPTED','ROLLED_BACK')):
                        _fail('MAINTENANCE_REGISTRY_UNFINISHED')
                    transactions[name]=record
                    proofs.append({'name':name,'sha256':hashlib.sha256(raw).hexdigest(),'current':own})
                    check_named(parent_fd,name,fd,initial)
                finally:
                    if lock is not None:os.close(lock)
                    os.close(fd)
            elif re.fullmatch('helper-[0-9a-f]{32}',name):
                from .helper_journal import inspect_helper_journal
                helper=inspect_helper_journal(parent_fd,name,production)
                total+=helper['record_bytes']
                if total>536870912:_fail('MAINTENANCE_REGISTRY_BYTE_LIMIT')
                helpers.append(helper);proofs.append(helper)
            elif re.fullmatch('evidence-[0-9a-f]{32}',name):
                # Correlation is checked after every ledger has been captured.
                proofs.append({'name':name,'rows':evidence(name)})
            elif re.fullmatch('backup-[0-9a-f]{32}',name):
                fd,initial=directory(parent_fd,name)
                try:
                    if set(os.listdir(fd))!={'tree','manifest.json'}:_fail('MAINTENANCE_REGISTRY_UNFINISHED')
                    raw=read(fd,'manifest.json');value=_strict_json(raw)
                    if encode_report(value)!=raw:_fail('MAINTENANCE_REGISTRY_OBJECT_UNQUALIFIED')
                    child,tree=directory(fd,'tree')
                    try:metadata_tree(child);check_named(fd,'tree',child,tree)
                    finally:os.close(child)
                    proofs.append({'name':name,'manifest_sha256':hashlib.sha256(raw).hexdigest()})
                    check_named(parent_fd,name,fd,initial)
                finally:os.close(fd)
            elif re.fullmatch('bootstrap-[0-9a-f]{64}',name):
                fd,initial=directory(parent_fd,name)
                try:
                    if os.listdir(fd)!=['payload.py']:_fail('MAINTENANCE_REGISTRY_UNFINISHED')
                    raw=read(fd,'payload.py',49152,0o400)
                    if hashlib.sha256(raw).hexdigest()!=name[10:]:_fail('MAINTENANCE_REGISTRY_OBJECT_UNQUALIFIED')
                    check_named(parent_fd,name,fd,initial)
                finally:os.close(fd)
            elif re.fullmatch('(python-closure|qualification)-[0-9a-f]{64}\\.json',name):
                raw=read(parent_fd,name);value=_strict_json(raw);pin=name[-69:-5]
                if (type(value) is not dict or encode_report(value)!=raw or value.get('sha256')!=pin
                        or report_sha256({k:v for k,v in value.items() if k!='sha256'})!=pin):_fail('MAINTENANCE_REGISTRY_OBJECT_UNQUALIFIED')
            else:_fail('MAINTENANCE_REGISTRY_UNFINISHED')
        for proof in proofs:
            if proof['name'].startswith(('evidence-','backup-')) and proof['name'].split('-',1)[1] not in transactions:
                _fail('MAINTENANCE_REGISTRY_ORPHANED_EVIDENCE')
        if production:
            from .helper_journal import assert_helper_kernel_absence
            assert_helper_kernel_absence(helpers)
            for transaction,record in transactions.items():
                if current is not None and current.transaction_id==transaction:continue
                rows=next((p['rows'] for p in proofs if p['name']=='evidence-'+transaction),None)
                if not rows:_fail('MAINTENANCE_REGISTRY_EVIDENCE_UNQUALIFIED')
                if record['entries'][-1]['marker']=='ACCEPTED':
                    pins=record['entries'][-1]['evidence']
                    acceptance=next((r for r in rows if r[0].endswith('-acceptance.json')),None)
                    invocation=next((r for r in rows if r[0].endswith('-accepted-invocation.json')),None)
                    if (acceptance is None or invocation is None or acceptance[1]!=pins.get('readers_sha256')
                            or invocation[1]!=pins.get('invocation_sha256') or acceptance[2].get('accepted') is not True
                            or acceptance[2].get('scope')!='QUALIFIED_INSTALLED_ACCEPTANCE'):
                        _fail('MAINTENANCE_REGISTRY_EVIDENCE_UNQUALIFIED')
        if names!=sorted(os.listdir(parent_fd)) or _identity(before)!=_identity(os.fstat(parent_fd)):_fail('MAINTENANCE_REGISTRY_CHANGED')
        if guard:guard.check()
        return {'schema':'RBRIDGE_MAINTENANCE_REGISTRY_V1','status':'PASS',
            'scope':'ROOT_PRIVATE_HISTORY_OBSERVATION_ONLY' if production else 'FIXTURE_AUTHORITY_ONLY',
            'transactions':sorted(transactions),'inventory_sha256':report_sha256(proofs),'service_action_authorized':False}
    except (OSError,ValueError,TypeError,KeyError,AttributeError):
        _fail('MAINTENANCE_REGISTRY_UNFINISHED')
    finally:
        if guard:guard.close()
