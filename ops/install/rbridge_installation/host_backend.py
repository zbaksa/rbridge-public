"""Fixed qualified systemd observations/actions; no request-selected executable."""
from pathlib import Path
import hashlib
import os
import pwd
import re
import selectors
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

class QualifiedHostBackend:
    scope='QUALIFIED_HOST_PAUSE'
    def __init__(self,profile):
        if os.getuid()!=0 or os.geteuid()!=0:raise PauseError('HOST_ROOT_REQUIRED')
        self.profile=parse_profile(__import__('json').loads(encode_report(profile)))
        if self.profile.service.unit!='rbridge.service':raise PauseError('HOST_UNIT_NOT_APPROVED')
        try:identity=pwd.getpwnam(self.profile.binding.account)
        except KeyError:raise PauseError('HOST_RUNTIME_IDENTITY_UNAVAILABLE') from None
        if (identity.pw_uid,identity.pw_gid,identity.pw_dir)!=(1027,1027,'/home/rbridge'):raise PauseError('HOST_RUNTIME_IDENTITY_MISMATCH')
        self.tool=next(t for t in self.profile.tools if t.role=='systemctl')
        self._qualify_tool();self.cgroups={}
        if self._run(('--version',),5000,16384).decode('utf-8').splitlines()[0]!=self.tool.version:raise PauseError('HOST_TOOL_VERSION_MISMATCH')
    def _qualify_tool(self):
        if hashlib.sha256(_protected_bytes(self.tool.path,16777216)).hexdigest()!=self.tool.sha256:raise PauseError('HOST_TOOL_BYTES_MISMATCH')
    def _run(self,args,timeout_ms,limit=262144):
        self._qualify_tool();child=subprocess.Popen([self.tool.path,*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/root','LC_ALL':'C'},cwd='/',start_new_session=True)
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
            self._qualify_tool();return bytes(out)
        except (OSError,subprocess.TimeoutExpired):raise PauseError('HOST_COMMAND_UNAVAILABLE') from None
        finally:
            selector.close()
            if child.poll() is None:child.kill();child.wait(timeout=5)
            child.stdout.close();child.stderr.close()
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
    def _cgroup_pids(self,unit):
        cgroup=self.cgroups.get(unit)
        if cgroup is None:raise PauseError('HOST_CGROUP_IDENTITY_MISSING')
        root=Path('/sys/fs/cgroup'+cgroup)
        try:
            parent=open_artifact_root(root)
            try:
                fd=os.open('cgroup.procs',FILE_FLAGS,dir_fd=parent)
                try:
                    raw=os.read(fd,65537)
                    if len(raw)>65536:raise PauseError('HOST_CGROUP_OBSERVATION_LIMIT')
                finally:os.close(fd)
            finally:os.close(parent)
        except FileNotFoundError:return []
        if raw and not re.fullmatch(rb'(?:[1-9][0-9]*\n)+',raw):raise PauseError('HOST_CGROUP_OBSERVATION_INVALID')
        return [int(n) for n in raw.splitlines()]
    def observe_pause(self,profile):
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
                # No same-UID process is presumed read-only from its name alone.
                writers.append(int(name))
            except FileNotFoundError:continue
            except PermissionError:raise PauseError('HOST_PROCESS_IDENTITY_UNKNOWN') from None
        return {'scope':self.scope,'service_identity_sha256':capture['identity_sha256'],'active_state':rows['ActiveState'],'main_pid':int(rows['MainPID']),'cgroup_pids':cgroup,'unclassified_same_uid':sorted(writers),'alternate_writers':alternates,'supervisors':[],'admissions_closed':rows['ActiveState']=='inactive' and rows['SubState']=='dead' and rows['MainPID']=='0','stopped_sockets':[]}
