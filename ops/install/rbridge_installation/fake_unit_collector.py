"""Actual fixed Root fake-unit stop producer, never a production service action.

An exclusive runtime link loads only the generated test unit. There is no global
daemon reload, enablement, production stop/start or generic program. Every failed
fixture is retained; its fixed non-root worker has a 30-second manager lifetime.
"""
from dataclasses import dataclass
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import select
import stat
import sys
import time
import weakref
from .artifact import _identity
from .artifact_collector import _closure,_FixtureHome
from .configuration import _pointer
from .copy_ledger_collector import _context as _root_context,_FixtureDirectory
from .fake_unit_case import PROPERTIES,render_fake_unit,validate_fake_unit_show,capture_fake_unit_case,compare_fake_unit_case
from .host_backend import QualifiedHostBackend,_protected_bytes
from .models import InstallationError,encode_report,report_sha256
from .owned_process import run_owned_process,assert_owned_helpers_settled
from .profile import parse_profile,assert_reader_profile_extension
from .protected_copy import FILE_FLAGS,FilesystemAuthority,ProtectedParent
from .readonly_helper import _json,_facts


class FakeUnitCollectorError(InstallationError):pass
def _fail(reason):raise FakeUnitCollectorError(reason)


@dataclass(frozen=True,eq=False)
class _RootFakeUnitObservation:
    profile_sha256:str
    evidence_json:str
    fixture_path:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/fake_unit_collector.py'):
        _fail('FAKE_UNIT_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    return _root_context(p,request)


def _materials(p,root,runtime_manifest,toolkit_manifest,request):
    _closure(p,root,runtime_manifest,toolkit_manifest,request)
    needed={'dist/server/installation/fakeUnitWorker.js','dist/server/installation/types.js',
        'ops/install/rbridge_installation/fake_unit_collector.py','ops/install/rbridge_installation/fake_unit_case.py',
        'ops/install/rbridge_installation/copy_ledger_collector.py','ops/install/rbridge_installation/host_backend.py'}
    if not needed<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('FAKE_UNIT_COLLECTOR_ENTRY_UNQUALIFIED')


def _production(p,backend):
    link=Path(p.paths.current_link);guard=ProtectedParent(FilesystemAuthority(0,p.binding.uid,link.parent,'RUNTIME'))
    try:
        guard.check();target,_identity_value,digest=_pointer(guard.fd,link.name,0);guard.check()
        release=os.path.normpath(os.path.join(str(link.parent),target))
        if release!=str(Path(p.paths.release_parent)/p.runtime.old_sha):_fail('FAKE_UNIT_COLLECTOR_PRODUCTION_POINTER_CHANGED')
        return {'service':backend.capture_service(p),'current_release':release,'pointer_identity_sha256':digest}
    finally:guard.close()


def _write_unit(fixture,name,raw):
    if type(name) is not str or not re.fullmatch('rbridge-install-fixture-[0-9a-f]{32}\\.service',name):
        _fail('FAKE_UNIT_COLLECTOR_UNIT_NAME_INVALID')
    fixture.check();fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=fixture.fd)
    try:
        before=os.fstat(fd)
        if before.st_uid!=0 or before.st_nlink!=1 or not stat.S_ISREG(before.st_mode) or before.st_mode&0o7777!=0o600:
            _fail('FAKE_UNIT_COLLECTOR_UNIT_UNPROTECTED')
        view=memoryview(raw)
        while view:
            count=os.write(fd,view)
            if count<=0:_fail('FAKE_UNIT_COLLECTOR_UNIT_WRITE_FAILED')
            view=view[count:]
        os.fsync(fd)
    finally:os.close(fd)
    os.fsync(fixture.fd);fixture.check()
    if _protected_bytes(fixture.path/name,65536)!=raw:_fail('FAKE_UNIT_COLLECTOR_UNIT_CHANGED')


def _ready(home,name='ready.json'):
    if name not in ('ready.json','stopped.json'):_fail('FAKE_UNIT_COLLECTOR_READY_NAME_INVALID')
    home.check();fd=os.open(name,FILE_FLAGS,dir_fd=home.fd)
    try:
        before=os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=home.profile.binding.uid
                or before.st_gid!=home.profile.binding.gid or before.st_nlink!=1
                or before.st_mode&0o7777!=0o600 or not 0<before.st_size<=4096):_fail('FAKE_UNIT_COLLECTOR_READY_UNQUALIFIED')
        raw=os.read(fd,4097)
        if (len(raw)!=before.st_size or _identity(before)!=_identity(os.fstat(fd))
                or _identity(before)!=_identity(os.stat(name,dir_fd=home.fd,follow_symlinks=False))):
            _fail('FAKE_UNIT_COLLECTOR_READY_CHANGED')
        home.check();return raw,before
    finally:os.close(fd)


def collect_root_fake_unit_stop(profile,runtime_manifest,toolkit_manifest,qualification_request):
    p,root=_context(profile,qualification_request);_materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    backend=QualifiedHostBackend(p);before=_production(p,backend)
    fixture=_FixtureDirectory(p,prefix='.rbridge-fake-unit-',limit=p.budget.carrier_bytes)
    home=None;link_parent=None;pidfd=None;queries=[]
    deadline=time.monotonic()+min(p.budget.scan_ms,120000)/1000
    try:
        home=_FixtureHome(p);home_identity={'dev':str(home.identity.st_dev),'ino':str(home.identity.st_ino)}
        unit='rbridge-install-fixture-'+fixture.name.removeprefix('.rbridge-fake-unit-')+'.service'
        nonce=secrets.token_hex(32);text=render_fake_unit(p,unit,str(home.path),nonce,home_identity)
        file=fixture.path/unit;_write_unit(fixture,unit,text.encode())
        link_parent=ProtectedParent(FilesystemAuthority(0,p.binding.uid,Path('/run/systemd/system'),'RUNTIME'))
        link_parent.check();os.symlink(str(file),unit,dir_fd=link_parent.fd);os.fsync(link_parent.fd)
        link_identity=os.stat(unit,dir_fd=link_parent.fd,follow_symlinks=False)
        def guard():
            if time.monotonic()>=deadline:_fail('FAKE_UNIT_COLLECTOR_DEADLINE')
            fixture.check();home.check();link_parent.check()
            if (link_identity.st_uid!=0 or not stat.S_ISLNK(link_identity.st_mode) or link_identity.st_nlink!=1
                    or _identity(link_identity)!=_identity(os.stat(unit,dir_fd=link_parent.fd,follow_symlinks=False))
                    or os.readlink(unit,dir_fd=link_parent.fd)!=str(file) or _protected_bytes(file,65536)!=text.encode()):
                _fail('FAKE_UNIT_COLLECTOR_UNIT_CHANGED')
            _materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
        tool=next(t for t in p.tools if t.role=='systemctl')
        show=('show',unit,'--no-pager','--property='+','.join(PROPERTIES))
        def command(args):
            if args not in (('--version',),show,('start',unit),('stop',unit)):_fail('FAKE_UNIT_COLLECTOR_COMMAND_UNQUALIFIED')
            # Capture tools run outside the owned command's guard: launching a
            # nested helper before its predecessor settles is never permitted.
            if encode_report(_production(p,backend))!=encode_report(before):_fail('FAKE_UNIT_COLLECTOR_PRODUCTION_CHANGED')
            raw,errors,session=run_owned_process(tool,args,min(p.budget.stop_ms,15000),1048576,guard=guard)
            queries.append({'argv':[tool.path,*args],'output_base64':base64.b64encode(raw).decode(),
                'errors_base64':base64.b64encode(errors).decode(),'session':session})
            if session['exit_code']!=0:_fail('FAKE_UNIT_COLLECTOR_COMMAND_FAILED')
            if encode_report(_production(p,backend))!=encode_report(before):_fail('FAKE_UNIT_COLLECTOR_PRODUCTION_CHANGED')
            return raw.decode('utf-8',errors='strict')
        if command(('--version',)).splitlines()[0]!=tool.version:_fail('FAKE_UNIT_COLLECTOR_TOOL_VERSION_CHANGED')
        # A new generated name must resolve to precisely our loaded bytes before
        # any start. If the manager cannot load it without a global reload, stop.
        validate_fake_unit_show(p,unit,str(file),str(home.path),nonce,home_identity,command(show),False)
        command(('start',unit))
        active=command(show);rows=validate_fake_unit_show(p,unit,str(file),str(home.path),nonce,home_identity,active,True)
        pid=int(rows['MainPID']);facts=_facts(pid);pidfd=os.pidfd_open(pid)
        if _facts(pid)!=facts:_fail('FAKE_UNIT_COLLECTOR_WORKER_CHANGED')
        if backend._subtree_pids('/sys/fs/cgroup/system.slice/'+unit)!=[pid]:_fail('FAKE_UNIT_COLLECTOR_CGROUP_UNCLASSIFIED')
        ready_deadline=min(deadline,time.monotonic()+5)
        while True:
            try:ready,ready_stat=_ready(home);break
            except FileNotFoundError:
                if time.monotonic()>=ready_deadline or select.select([pidfd],[],[],0)[0]:_fail('FAKE_UNIT_COLLECTOR_READY_UNKNOWN')
                time.sleep(0.01)
        if _facts(pid)!=facts:_fail('FAKE_UNIT_COLLECTOR_WORKER_CHANGED')
        if select.select([pidfd],[],[],0)[0] or _facts(pid)!=facts:_fail('FAKE_UNIT_COLLECTOR_WORKER_CHANGED')
        command(('stop',unit))
        stopped=[];cgroups=[]
        for _ in range(2):
            stopped.append(command(show));cgroups.append(backend._subtree_pids('/sys/fs/cgroup/system.slice/'+unit))
        after_ready,after_stat=_ready(home)
        stopped_raw,stopped_stat=_ready(home,'stopped.json')
        if ready!=after_ready or _identity(ready_stat)!=_identity(after_stat):_fail('FAKE_UNIT_COLLECTOR_READY_CHANGED')
        after=_production(p,backend);guard();assert_owned_helpers_settled()
        output={'active_show':active,'stopped_show':stopped,'active_cgroup_pids':[pid],'stopped_cgroup_pids':cgroups,
            'ready_json':ready.decode(),'ready_uid':ready_stat.st_uid,'ready_mode':ready_stat.st_mode&0o7777,
            'ready_nlink':ready_stat.st_nlink,'worker_facts':facts,'pidfd_settled':bool(select.select([pidfd],[],[],0)[0]),
            'stopped_json':stopped_raw.decode(),'stopped_uid':stopped_stat.st_uid,'stopped_mode':stopped_stat.st_mode&0o7777,
            'stopped_nlink':stopped_stat.st_nlink,
            'stop_exit_code':0,'production_before':before,'production_after':after}
        case=capture_fake_unit_case(p,unit,str(file),str(home.path),nonce,home_identity,text,output)
        raw=encode_report({'case':case,'queries':queries});fixture.write(raw)
        token=_RootFakeUnitObservation(report_sha256(p),raw.decode(),str(fixture.path))
        _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest,p)
        return token
    finally:
        if pidfd is not None:os.close(pidfd)
        if link_parent is not None:link_parent.close()
        if home is not None:home.close()
        fixture.close()
        # Retain the private unit, inactive runtime link, readiness and failure
        # evidence. Never invoke disable/reload or restart any production unit.


def verify_root_fake_unit_observation(profile,token,qualification_request):
    if type(token) is not _RootFakeUnitObservation or token not in _observations:_fail('FAKE_UNIT_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,runtime_manifest,toolkit_manifest,original=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(original):_fail('FAKE_UNIT_COLLECTOR_OBSERVATION_CHANGED')
    assert_reader_profile_extension(original,profile)
    p,root=_context(original,qualification_request);target,target_root=_context(profile,qualification_request)
    _materials(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    _materials(target,target_root,runtime_manifest,toolkit_manifest,qualification_request)
    fixture=_FixtureDirectory(p,token.fixture_path,prefix='.rbridge-fake-unit-',limit=p.budget.carrier_bytes)
    try:
        raw=fixture.read()
        if raw.decode()!=token.evidence_json:_fail('FAKE_UNIT_COLLECTOR_OBSERVATION_CHANGED')
        evidence=_json(raw,p.budget.carrier_bytes);case=evidence['case'];compare_fake_unit_case(p,case)
        inputs=_json(case['input_json'].encode(),p.budget.carrier_bytes);output=_json(case['output_json'].encode(),p.budget.carrier_bytes)
        if _protected_bytes(inputs['unit_file'],65536).decode()!=inputs['unit_text']:_fail('FAKE_UNIT_COLLECTOR_UNIT_CHANGED')
        backend=QualifiedHostBackend(p)
        if encode_report(_production(p,backend))!=encode_report(output['production_after']):_fail('FAKE_UNIT_COLLECTOR_PRODUCTION_CHANGED')
        show=backend._run(('show',inputs['unit'],'--no-pager','--property='+','.join(PROPERTIES)),15000).decode()
        validate_fake_unit_show(p,inputs['unit'],inputs['unit_file'],inputs['fixture_home'],inputs['nonce'],inputs['home_identity'],show,False)
        if backend._subtree_pids('/sys/fs/cgroup/system.slice/'+inputs['unit']):_fail('FAKE_UNIT_COLLECTOR_CGROUP_UNCLASSIFIED')
        assert_owned_helpers_settled()
        return {'schema':'RBRIDGE_ROOT_FAKE_UNIT_OBSERVATION_V1','scope':'ROOT_PROTECTED_FAKE_UNIT_STOP_OBSERVATION',
            'status':'PASS','original_profile_sha256':token.profile_sha256,'profile_sha256':report_sha256(target),
            'evidence_sha256':hashlib.sha256(raw).hexdigest(),'output':evidence,'case':'fake_unit_stop',
            'full_privileged_qualification':'INCOMPLETE','may_execute':False,'service_action_authorized':False}
    finally:fixture.close()
