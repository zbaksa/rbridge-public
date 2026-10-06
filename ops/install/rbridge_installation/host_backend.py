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

PROPERTIES=('ExecStart','User','Group','FragmentPath','DropInPaths','EnvironmentFiles','Environment','UnsetEnvironment','CPUQuotaPerSecUSec','Restart','NoNewPrivileges','ProtectSystem','ProtectHome','ReadWritePaths','ControlGroup','MainPID','ActiveState','SubState','InvocationID')

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

def validate_kernel_namespace_evidence(value):
    """Pure predicate; only the concrete capture below observes a kernel view."""
    def fail():raise PauseError('HOST_KERNEL_NAMESPACE_UNQUALIFIED')
    keys={'pid','self_link','self_status','pid1_status','uid_map','gid_map','namespaces','mountinfo'}
    if (type(value) is not dict or set(value)!=keys or type(value['pid']) is not int or not 2<=value['pid']<=2147483647
            or any(type(value[k]) is not str or len(value[k].encode())>1048576 for k in keys-{'pid','namespaces'})
            or value['self_link']!=str(value['pid'])):fail()
    for key,pid in (('self_status',value['pid']),('pid1_status',1)):
        pids=re.findall(r'^Pid:\s*([0-9]+)$',value[key],re.M)
        namespace_pids=re.findall(r'^NSpid:\s*([0-9 \t]+)$',value[key],re.M)
        if pids!=[str(pid)] or len(namespace_pids)!=1 or namespace_pids[0].split()!=[str(pid)]:fail()
    for key in ('uid_map','gid_map'):
        if [row.split() for row in value[key].splitlines() if row.strip()]!=[['0','0','4294967295']]:fail()
    kinds=('pid','mnt','user','cgroup');namespaces=value['namespaces']
    if type(namespaces) is not dict or set(namespaces)!=set(kinds):fail()
    for kind,links in namespaces.items():
        if (type(links) is not list or len(links)!=2 or links[0]!=links[1] or type(links[0]) is not str
                or not re.fullmatch(re.escape(kind)+r':\[[1-9][0-9]{0,19}\]',links[0])):fail()
    required={'/proc':'proc','/sys/fs/cgroup':'cgroup2'};found={}
    for row in value['mountinfo'].splitlines():
        fields=row.split()
        if len(fields)<10 or fields.count('-')!=1:fail()
        separator=fields.index('-')
        if separator<6 or len(fields)-separator!=4:fail()
        point=fields[4]
        if point in required:
            if point in found or fields[3]!='/' or fields[separator+1]!=required[point]:fail()
            found[point]=fields[separator+1]
    if found!=required:fail()


def _assert_kernel_namespace():
    try:
        # Numeric PID paths must identify this process namespace, never a host view.
        if os.readlink('/proc/self')!=str(os.getpid()):raise PauseError('HOST_KERNEL_NAMESPACE_UNQUALIFIED')
        def links():return {kind:[os.readlink('/proc/self/ns/'+kind),os.readlink('/proc/1/ns/'+kind)] for kind in ('pid','mnt','user','cgroup')}
        before=links()
        value={'pid':os.getpid(),'self_link':os.readlink('/proc/self'),
            'self_status':_kernel_bytes('/proc/self/status').decode('ascii'),
            'pid1_status':_kernel_bytes('/proc/1/status').decode('ascii'),
            'uid_map':_kernel_bytes('/proc/self/uid_map').decode('ascii'),
            'gid_map':_kernel_bytes('/proc/self/gid_map').decode('ascii'),
            'namespaces':before,'mountinfo':_kernel_bytes('/proc/self/mountinfo',1048576).decode('utf-8',errors='strict')}
        validate_kernel_namespace_evidence(value)
        if before!=links():raise PauseError('HOST_KERNEL_NAMESPACE_UNQUALIFIED')
    except (OSError,UnicodeError):raise PauseError('HOST_KERNEL_NAMESPACE_UNQUALIFIED') from None

def validate_candidate_facts(profile,rows,facts,node_sha256):
    """Pure identity predicate; calling it does not mint an observed host proof."""
    p=profile;argv=(p.runtime.node_path,p.paths.current_link+'/dist/server/server/remoteBridgeMain.js')
    try:
        if (rows['ActiveState']!='active' or rows['SubState']!='running' or not re.fullmatch('[0-9a-f]{32}',rows['InvocationID']) or not re.fullmatch('[1-9][0-9]*',rows['MainPID']) or int(rows['MainPID'])<2 or rows['ControlGroup']!='/system.slice/rbridge.service' or facts['identity']['pid']!=int(rows['MainPID']) or facts['Uid']!=(p.binding.uid,)*4 or facts['Gid']!=(p.binding.gid,)*4 or tuple(sorted(set(facts['Groups'])-{p.binding.gid}))!=p.binding.supplementary_gids or 0 in facts['Groups'] or facts['PPid']!=(1,) or facts['identity']['exe']!=p.runtime.node_path or facts['identity']['cmdlineSha256']!=hashlib.sha256(('\0'.join(argv)+'\0').encode()).hexdigest() or facts['cgroup_sha256']!=hashlib.sha256(('0::'+rows['ControlGroup']+'\n').encode()).hexdigest() or node_sha256!=p.runtime.node_sha256):raise PauseError('HOST_CANDIDATE_IDENTITY_UNQUALIFIED')
    except (KeyError,TypeError,ValueError,AttributeError):raise PauseError('HOST_CANDIDATE_IDENTITY_UNQUALIFIED') from None

def _run_fixed_tool(pin,args,timeout_ms,limit=262144,env=None):
    from .owned_process import run_owned_process
    raw,_errors,proof=run_owned_process(pin,args,timeout_ms,limit,env=env)
    if proof['status']!='PASS' or proof['exit_code']!=0:raise PauseError('HOST_COMMAND_FAILED')
    return raw

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
            if unit in self.cgroups and self.cgroups[unit]!=cgroup:raise PauseError('HOST_CGROUP_CHANGED')
            self.cgroups[unit]=cgroup
        return result
    def _config(self,rows):
        from .configuration import normalize_owned_rows
        rows=normalize_owned_rows(self,rows)
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
    def reload_configuration(self):
        self._run(('daemon-reload',),self.profile.budget.stop_ms,65536)
    def start_candidate(self,prepared):
        from .transaction import _validate,_authorization
        _assert_kernel_namespace();_validate(prepared,self);_authorization(prepared,prepared.authorization)
        if getattr(self,'current_installation',None) is not prepared or prepared.ledger.read().entries[-1].marker!='START_ATTEMPTED' or prepared.profile_sha256!=report_sha256(self.profile):raise PauseError('HOST_CANDIDATE_START_UNQUALIFIED')
        prepared.lease.check();prepared.pointer.session.check()
        if prepared.config.session.observed()!=prepared.config.after_sha256:raise PauseError('HOST_CANDIDATE_CONFIG_CHANGED')
        self._run(('start','rbridge.service'),self.profile.budget.stop_ms,65536)
    def observe_candidate(self,prepared):
        from .transaction import _validate
        from .readonly_helper import _facts
        _assert_kernel_namespace();_validate(prepared,self);prepared.lease.check_exclusion();prepared.pointer.session.check()
        if prepared.profile_sha256!=report_sha256(self.profile) or prepared.config.session.observed()!=prepared.config.after_sha256:raise PauseError('HOST_CANDIDATE_CONFIG_CHANGED')
        rows=self._show('rbridge.service');config=self._config(rows)
        if report_sha256(config)!=self.profile.service.identity_sha256 or not re.fullmatch('[1-9][0-9]*',rows['MainPID']):raise PauseError('HOST_CANDIDATE_CONFIG_CHANGED')
        pid=int(rows['MainPID']);pidfd=None
        try:
            pidfd=os.pidfd_open(pid);facts=_facts(pid)
            fd=os.open('/proc/'+str(pid)+'/exe',os.O_RDONLY|os.O_CLOEXEC)
            try:
                before=os.fstat(fd);sha=hashlib.sha256();total=0
                if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_mode&0o6022 or before.st_nlink!=1 or before.st_size>268435456:raise PauseError('HOST_CANDIDATE_NODE_UNQUALIFIED')
                while True:
                    chunk=os.read(fd,1048576)
                    if not chunk:break
                    sha.update(chunk);total+=len(chunk)
                    if total>before.st_size:raise PauseError('HOST_CANDIDATE_NODE_CHANGED')
                if total!=before.st_size or _identity(before)!=_identity(os.fstat(fd)):raise PauseError('HOST_CANDIDATE_NODE_CHANGED')
            finally:os.close(fd)
            if sha.hexdigest()!=hashlib.sha256(_protected_bytes(self.profile.runtime.node_path,268435456)).hexdigest():raise PauseError('HOST_CANDIDATE_NODE_CHANGED')
            validate_candidate_facts(self.profile,rows,facts,sha.hexdigest())
            if _facts(pid)!=facts or self._show('rbridge.service')!=rows:raise PauseError('HOST_CANDIDATE_INVOCATION_CHANGED')
            selector=selectors.DefaultSelector()
            try:
                selector.register(pidfd,selectors.EVENT_READ)
                if selector.select(0):raise PauseError('HOST_CANDIDATE_PROCESS_EXITED')
            finally:selector.close()
            _validate(prepared,self);prepared.lease.check_exclusion();prepared.pointer.session.check()
            return {'scope':'QUALIFIED_INSTALLED_INVOCATION','status':'PASS','profile_sha256':prepared.profile_sha256,'runtime_manifest_sha256':prepared.runtime_manifest.sha256,'config_sha256':prepared.config.after_sha256,'pointer_sha256':prepared.pointer.after_sha256,'invocation_sha256':report_sha256({'process':facts,'node_sha256':sha.hexdigest(),'invocation_id':rows['InvocationID'],'effective_config_sha256':prepared.config.after_sha256}),'process':facts,'node_sha256':sha.hexdigest(),'invocation_id':rows['InvocationID']}
        except (OSError,AttributeError):raise PauseError('HOST_CANDIDATE_OBSERVATION_UNKNOWN') from None
        finally:
            if pidfd is not None:os.close(pidfd)
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
