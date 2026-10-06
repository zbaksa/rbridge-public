"""Fixed qualified systemd observations/actions; no request-selected executable."""
from pathlib import Path
import hashlib
import os
import pwd
import re
import selectors
import signal
import shlex
import stat
import subprocess
import time
from .artifact import _identity,open_artifact_root
from .models import PauseError,encode_report,report_sha256
from .profile import parse_profile
from .protected_copy import ProtectedParent,FilesystemAuthority,FILE_FLAGS

PROPERTIES=('ExecStart','User','Group','FragmentPath','DropInPaths','EnvironmentFiles','CPUQuotaPerSecUSec','Restart','NoNewPrivileges','ProtectSystem','ProtectHome','ReadWritePaths','ControlGroup','MainPID','ActiveState','SubState','InvocationID')

def normalize_exec_start(value):
    match=re.fullmatch(r'\{ path=([^;{}]+) ; argv\[\]=([^;{}]+) ; ignore_errors=(yes|no) ; [^{}]*\}',value)
    if not match:raise PauseError('HOST_EXECSTART_UNCLASSIFIED')
    return {'path':match[1].strip(),'argv':match[2].strip(),'ignore_errors':match[3]}

def _protected_bytes(path,limit):
    path=Path(path);guard=ProtectedParent(FilesystemAuthority(0,1027,path.parent,'RUNTIME'))
    try:
        fd=os.open(path.name,FILE_FLAGS,dir_fd=guard.fd)
        try:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_nlink!=1 or before.st_mode&0o6022 or before.st_size>limit:raise PauseError('HOST_FILE_UNQUALIFIED')
            data=bytearray()
            while len(data)<=limit:
                chunk=os.read(fd,min(1048576,limit+1-len(data)))
                if not chunk:break
                data.extend(chunk)
            if len(data)>limit or len(data)!=before.st_size or _identity(before)!=_identity(os.fstat(fd)) or _identity(before)!=_identity(os.stat(path.name,dir_fd=guard.fd,follow_symlinks=False)):raise PauseError('HOST_FILE_CHANGED')
            guard.check();return bytes(data)
        finally:os.close(fd)
    finally:guard.close()

def _kernel_bytes(path,limit=65536):
    fd=os.open(path,FILE_FLAGS)
    try:
        data=bytearray()
        while len(data)<=limit:
            chunk=os.read(fd,min(65536,limit+1-len(data)))
            if not chunk:break
            data.extend(chunk)
        if len(data)>limit:raise PauseError('HOST_KERNEL_OBSERVATION_LIMIT')
        return bytes(data)
    finally:os.close(fd)

def _assert_kernel_namespace():
    try:
        # Numeric PID paths must identify this process namespace, never a host view.
        if os.readlink('/proc/self')!=str(os.getpid()):raise PauseError('HOST_KERNEL_NAMESPACE_UNQUALIFIED')
        raw=_kernel_bytes('/proc/self/status')
        match=re.search(rb'^Pid:\s+([0-9]+)$',raw,re.M)
        if not match or int(match[1])!=os.getpid():raise PauseError('HOST_KERNEL_NAMESPACE_UNQUALIFIED')
    except OSError:raise PauseError('HOST_KERNEL_NAMESPACE_UNQUALIFIED') from None

def _run_fixed_tool(pin,args,timeout_ms,limit=262144,env=None):
    def qualify():
        if hashlib.sha256(_protected_bytes(pin.path,16777216)).hexdigest()!=pin.sha256:raise PauseError('HOST_TOOL_BYTES_MISMATCH')
    qualify();child=subprocess.Popen([pin.path,*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env or {'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/root','LC_ALL':'C'},cwd='/',start_new_session=True)
    selector=selectors.DefaultSelector();out=bytearray();errors=bytearray();deadline=time.monotonic()+timeout_ms/1000
    try:
        for stream in (child.stdout,child.stderr):os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ)
        while selector.get_map():
            remaining=deadline-time.monotonic()
            if remaining<=0:raise PauseError('HOST_COMMAND_DEADLINE')
            for key,_event in selector.select(min(remaining,0.2)):
                chunk=os.read(key.fd,65536)
                if not chunk:selector.unregister(key.fileobj);continue
                destination=out if key.fileobj is child.stdout else errors;destination.extend(chunk)
                if len(out)+len(errors)>limit:raise PauseError('HOST_COMMAND_OUTPUT_LIMIT')
        if child.wait(timeout=max(0.001,deadline-time.monotonic()))!=0:raise PauseError('HOST_COMMAND_FAILED')
        qualify();return bytes(out)
    except (OSError,subprocess.TimeoutExpired):raise PauseError('HOST_COMMAND_UNAVAILABLE') from None
    finally:
        selector.close()
        if child.poll() is None:
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            child.wait(timeout=5)
        child.stdout.close();child.stderr.close()

class QualifiedHostBackend:
    scope='QUALIFIED_HOST_PAUSE'
    def __init__(self,profile):
        if os.getuid()!=0 or os.geteuid()!=0:raise PauseError('HOST_ROOT_REQUIRED')
        _assert_kernel_namespace()
        self.profile=parse_profile(__import__('json').loads(encode_report(profile)))
        if self.profile.service.unit!='rbridge.service':raise PauseError('HOST_UNIT_NOT_APPROVED')
        try:identity=pwd.getpwnam(self.profile.binding.account)
        except KeyError:raise PauseError('HOST_RUNTIME_IDENTITY_UNAVAILABLE') from None
        if (identity.pw_uid,identity.pw_gid,identity.pw_dir)!=(1027,1027,'/home/rbridge'):raise PauseError('HOST_RUNTIME_IDENTITY_MISMATCH')
        self.tool=next(t for t in self.profile.tools if t.role=='systemctl')
        self._qualify_tool();self.cgroups={};self.process_unit_evidence={}
        if self._run(('--version',),5000,16384).decode('utf-8').splitlines()[0]!=self.tool.version:raise PauseError('HOST_TOOL_VERSION_MISMATCH')
    def _qualify_tool(self):
        if hashlib.sha256(_protected_bytes(self.tool.path,16777216)).hexdigest()!=self.tool.sha256:raise PauseError('HOST_TOOL_BYTES_MISMATCH')
    def _run(self,args,timeout_ms,limit=262144):
        return _run_fixed_tool(self.tool,args,timeout_ms,limit)
    def _show(self,unit):
        if unit not in (self.profile.service.unit,*self.profile.service.alternate_units):raise PauseError('HOST_UNIT_NOT_APPROVED')
        raw=self._run(('show',unit,'--no-pager','--property='+','.join(PROPERTIES)),min(self.profile.budget.stop_ms,15000)).decode('utf-8',errors='strict')
        result={}
        for row in raw.splitlines():
            key,separator,value=row.partition('=')
            if not separator or key in result:raise PauseError('HOST_SERVICE_OBSERVATION_INVALID')
            result[key]=value
        if set(result)!=set(PROPERTIES):raise PauseError('HOST_SERVICE_OBSERVATION_INVALID')
        cgroup=result['ControlGroup']
        if cgroup:
            if not cgroup.startswith('/') or cgroup=='/' or any(p in ('','.','..') for p in cgroup[1:].split('/')):raise PauseError('HOST_CGROUP_UNCLASSIFIED')
            self.cgroups[unit]=cgroup
        return result
    def _config(self,rows):
        fragment=rows['FragmentPath'];dropins=shlex.split(rows['DropInPaths'])
        if not fragment or len(dropins)>32:raise PauseError('HOST_UNIT_FILES_UNCLASSIFIED')
        files={'fragment':{'path':fragment,'sha256':hashlib.sha256(_protected_bytes(fragment,1048576)).hexdigest()},'dropins':[{'path':p,'sha256':hashlib.sha256(_protected_bytes(p,1048576)).hexdigest()} for p in dropins]}
        if report_sha256(files)!=self.profile.service.dropins_sha256:raise PauseError('HOST_DROPINS_CHANGED')
        pattern=r'(/[^\s()\x00\r\n]+) \(ignore_errors=no\)'
        parsed=re.findall(pattern,rows['EnvironmentFiles'])
        if ' '.join(p+' (ignore_errors=no)' for p in parsed)!=rows['EnvironmentFiles']:raise PauseError('HOST_ENVIRONMENT_PRECEDENCE_UNCLASSIFIED')
        expected=[e.path for e in self.profile.service.environment_files]
        if parsed!=expected:raise PauseError('HOST_ENVIRONMENT_PRECEDENCE_CHANGED')
        env=[]
        for pin in self.profile.service.environment_files:
            sha=hashlib.sha256(_protected_bytes(pin.path,1048576)).hexdigest()
            if sha!=pin.sha256:raise PauseError('HOST_ENVIRONMENT_BYTES_CHANGED')
            env.append({'path':pin.path,'sha256':sha})
        stable={k:v for k,v in rows.items() if k not in ('ControlGroup','MainPID','ActiveState','SubState','InvocationID','ExecStart')}
        stable['ExecStart']=normalize_exec_start(rows['ExecStart']);stable['files']=files;stable['environment_files']=env
        if rows['User']!=self.profile.binding.account or rows['Group'] not in ('',self.profile.binding.account):raise PauseError('HOST_SERVICE_RUNTIME_IDENTITY_CHANGED')
        stable['effective_group']=self.profile.binding.gid
        return stable
    def capture_service(self,profile):
        if report_sha256(profile)!=report_sha256(self.profile):raise PauseError('HOST_PROFILE_CHANGED')
        rows=self._show(profile.service.unit);config=self._config(rows);identity=report_sha256(config)
        if identity!=profile.service.identity_sha256:raise PauseError('HOST_SERVICE_IDENTITY_CHANGED')
        for unit in profile.service.alternate_units:self._show(unit)
        return {'scope':self.scope,'identity_sha256':identity,'config_sha256':report_sha256(config),'invocation_sha256':report_sha256({k:rows[k] for k in ('InvocationID','MainPID','ControlGroup','ActiveState','SubState')})}
    def stop_unit(self,unit):
        if unit!='rbridge.service' or unit!=self.profile.service.unit:raise PauseError('HOST_UNIT_NOT_APPROVED')
        self._run(('stop','rbridge.service'),self.profile.budget.stop_ms,65536)
    def probe_process(self,pid):
        from .process_observation import probe_kernel_process
        return probe_kernel_process(pid)
    def observe_process_unit(self,profile,session_id):
        _assert_kernel_namespace()
        if report_sha256(profile)!=report_sha256(self.profile) or not re.fullmatch('[0-9a-f]{32}',session_id):raise PauseError('HOST_PROCESS_TARGET_INVALID')
        runuser=next(t for t in self.profile.tools if t.role=='runuser')
        if _run_fixed_tool(runuser,('--version',),5000,16384).decode('utf-8').splitlines()[0]!=runuser.version:raise PauseError('HOST_TOOL_VERSION_MISMATCH')
        self._qualify_tool()
        unit='cocwin-remote-bridge-process-'+session_id+'.service'
        properties=('LoadState','ActiveState','SubState','MainPID','ControlGroup','InvocationID')
        environment={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':profile.binding.home,'USER':profile.binding.account,'LOGNAME':profile.binding.account,'LC_ALL':'C','XDG_RUNTIME_DIR':'/run/user/1027','DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/1027/bus'}
        def show():
            raw=_run_fixed_tool(runuser,('--user','rbridge','--',self.tool.path,'--user','show',unit,'--no-pager','--property='+','.join(properties)),15000,65536,environment).decode('utf-8',errors='strict')
            rows={}
            for line in raw.splitlines():
                key,sep,value=line.partition('=')
                if not sep or key in rows:raise PauseError('HOST_PROCESS_UNIT_UNKNOWN')
                rows[key]=value
            if set(rows)!=set(properties) or not re.fullmatch('0|[1-9][0-9]*',rows['MainPID']):raise PauseError('HOST_PROCESS_UNIT_UNKNOWN')
            return rows
        before=show();cgroup=before['ControlGroup'];pids=[]
        if cgroup:
            prefix='/user.slice/user-1027.slice/user@1027.service/'
            if not cgroup.startswith(prefix) or not cgroup.endswith('/'+unit) or any(p in ('','.','..') for p in cgroup[1:].split('/')):raise PauseError('HOST_PROCESS_CGROUP_UNKNOWN')
            pids=self._subtree_pids('/sys/fs/cgroup'+cgroup)
        after=show();self._qualify_tool()
        if before!=after:raise PauseError('HOST_PROCESS_UNIT_CHANGED')
        settled=before['LoadState'] in ('loaded','not-found') and before['ActiveState']=='inactive' and before['SubState']=='dead' and before['MainPID']=='0' and not pids
        # The enclosing lease also proves no unclassified same-UID process before/after.
        evidence={'unit':unit,'properties':before,'cgroup_pids':pids}
        if not hasattr(self,'process_unit_evidence'):self.process_unit_evidence={}
        self.process_unit_evidence[session_id]=evidence
        return {'unit':unit,'cgroup':cgroup,'settled':settled,'invocation_sha256':report_sha256(evidence)}
    def _subtree_pids(self,path):
        deadline=time.monotonic()+self.profile.budget.stop_ms/1000;count=0;pids=set()
        try:root=open_artifact_root(path)
        except FileNotFoundError:return []
        def walk(fd,depth):
            nonlocal count
            if depth>self.profile.budget.state_depth or time.monotonic()>=deadline:raise PauseError('HOST_CGROUP_OBSERVATION_LIMIT')
            count+=1
            if count>self.profile.budget.state_entries:raise PauseError('HOST_CGROUP_OBSERVATION_LIMIT')
            names=sorted(os.listdir(fd));before=os.fstat(fd)
            handle=os.open('cgroup.procs',FILE_FLAGS,dir_fd=fd)
            try:
                data=bytearray()
                while len(data)<=65536:
                    chunk=os.read(handle,min(65536,65537-len(data)))
                    if not chunk:break
                    data.extend(chunk)
                raw=bytes(data)
            finally:os.close(handle)
            if len(raw)>65536 or (raw and not re.fullmatch(rb'(?:[1-9][0-9]*\n)+',raw)):raise PauseError('HOST_CGROUP_OBSERVATION_INVALID')
            pids.update(int(n) for n in raw.splitlines())
            for name in names:
                entry=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISLNK(entry.st_mode):raise PauseError('HOST_CGROUP_OBSERVATION_INVALID')
                if stat.S_ISDIR(entry.st_mode):
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                    try:
                        if _identity(entry)!=_identity(os.fstat(child)):raise PauseError('HOST_CGROUP_CHANGED')
                        walk(child,depth+1)
                    finally:os.close(child)
            if names!=sorted(os.listdir(fd)) or _identity(before)!=_identity(os.fstat(fd)):raise PauseError('HOST_CGROUP_CHANGED')
        try:walk(root,0);return sorted(pids)
        except OSError:raise PauseError('HOST_CGROUP_OBSERVATION_UNAVAILABLE') from None
        finally:os.close(root)
    def _cgroup_pids(self,unit):
        cgroup=self.cgroups.get(unit)
        if cgroup is None:raise PauseError('HOST_CGROUP_IDENTITY_MISSING')
        return self._subtree_pids('/sys/fs/cgroup'+cgroup)
    def observe_pause(self,profile):
        _assert_kernel_namespace()
        capture=self.capture_service(profile);rows=self._show(profile.service.unit);alternates=[];cgroup=self._cgroup_pids(profile.service.unit)
        for unit in profile.service.alternate_units:
            alternate=self._show(unit)
            if alternate['ActiveState']!='inactive' or alternate['MainPID']!='0' or self._cgroup_pids(unit):alternates.append(unit)
        writers=[];started=time.monotonic()
        for name in os.listdir('/proc'):
            if not name.isascii() or not name.isdecimal():continue
            if time.monotonic()-started>5:raise PauseError('HOST_PROCESS_CLASSIFICATION_DEADLINE')
            try:
                status=_kernel_bytes('/proc/'+name+'/status');match=re.search(rb'^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$',status,re.M)
                if not match:raise PauseError('HOST_PROCESS_IDENTITY_UNKNOWN')
                if 1027 not in [int(n) for n in match.groups()]:continue
                # Only our concrete root-launched, immutable helper may be exempted.
                reader=getattr(self,'readonly_helpers',{}).get(int(name))
                if reader is not None:
                    from .readonly_helper import _HeldReadonlyHelper,QualifiedReadonlyAuditRunner
                    if type(reader) is not _HeldReadonlyHelper or type(reader.owner) is not QualifiedReadonlyAuditRunner or reader.owner.lease.backend is not self:raise PauseError('HOST_READONLY_HELPER_UNQUALIFIED')
                    if reader.matches_pid(int(name)):continue
                writers.append(int(name))
            except FileNotFoundError:continue
            except PermissionError:raise PauseError('HOST_PROCESS_IDENTITY_UNKNOWN') from None
        return {'scope':self.scope,'service_identity_sha256':capture['identity_sha256'],'active_state':rows['ActiveState'],'main_pid':int(rows['MainPID']),'cgroup_pids':cgroup,'unclassified_same_uid':sorted(writers),'alternate_writers':alternates,'supervisors':[],'admissions_closed':rows['ActiveState']=='inactive' and rows['SubState']=='dead' and rows['MainPID']=='0','stopped_sockets':[]}
