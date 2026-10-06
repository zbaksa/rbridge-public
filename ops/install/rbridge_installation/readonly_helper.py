"""Fixed protected non-root validator protocol under one concrete maintained pause."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import select
import signal
import stat
import subprocess
import sys
import time
from .artifact import _identity, validate_manifest
from .host_backend import QualifiedHostBackend, _assert_kernel_namespace, _kernel_bytes, _protected_bytes, _run_fixed_tool
from .models import InstallationError, PauseError, encode_report, report_sha256, validate_contract
from .pause_backup import PauseLease, capture_snapshot
from .protected_copy import FilesystemAuthority, verify_published
from .process_observation import probe_kernel_process


class ReadonlyHelperError(InstallationError):
    pass


def selectors_ready(fd):
    return bool(select.select([fd],[],[],0)[0])


def _fail(reason):
    raise ReadonlyHelperError(reason)


def _json(raw, limit=67108864):
    if type(raw) is not bytes or len(raw)>limit:_fail('HELPER_OUTPUT_LIMIT')
    def pairs(rows):
        result={}
        for key,value in rows:
            if key in result:_fail('HELPER_DUPLICATE_JSON_KEY')
            result[key]=value
        return result
    try:
        value=json.loads(raw.decode('utf-8',errors='strict'),object_pairs_hook=pairs,
                         parse_constant=lambda _v:(_ for _ in ()).throw(ValueError()))
        encode_report(value)
        return value
    except (ValueError,TypeError,UnicodeError,RecursionError):_fail('HELPER_JSON_INVALID')


def _fields(value, names):
    if type(value) is not dict or set(value)!=set(names):_fail('HELPER_PACKET_INVALID')
    return value


def _hash(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None


def parse_helper_ready(raw, nonce):
    if not _hash(nonce) or type(raw) is not bytes or not raw.endswith(b'\n') or b'\n' in raw[:-1]:_fail('HELPER_READY_INVALID')
    row=_fields(_json(raw,4096),('schema','pid','nonce'))
    try:validate_contract(row,'HelperReady')
    except (ValueError,TypeError,KeyError):_fail('HELPER_READY_INVALID')
    if row['schema']!='RBRIDGE_INSTALL_HELPER_READY_V1' or row['nonce']!=nonce or type(row['pid']) is not int or not 2<=row['pid']<=2147483647:_fail('HELPER_READY_INVALID')
    return row['pid']


def validate_discovery(value, profile, token):
    row=_fields(value,('schema','scope','status','reason_codes','profile_sha256','snapshot_sha256','core_absence_sha256','issue_numbers','process_targets'))
    try:validate_contract(row,'DiscoveryResult')
    except (ValueError,TypeError,KeyError):_fail('HELPER_DISCOVERY_IDENTITY_INVALID')
    if (row['schema']!='RBRIDGE_INSTALL_DISCOVERY_RESULT_V1' or row['scope']!='READONLY_PROBE_TARGETS_ONLY' or row['status']!='PASS' or row['reason_codes']!=[] or row['profile_sha256']!=report_sha256(profile) or row['snapshot_sha256']!=report_sha256(token) or not _hash(row['core_absence_sha256'])):_fail('HELPER_DISCOVERY_IDENTITY_INVALID')
    numbers=row['issue_numbers'];targets=row['process_targets'];ids=set()
    if type(numbers) is not list or len(numbers)>profile.budget.state_entries or any(type(n) is not int or not 1<=n<=2147483647 for n in numbers) or numbers!=sorted(set(numbers)):_fail('HELPER_DISCOVERY_NUMBERS_INVALID')
    if type(targets) is not list or len(targets)>profile.budget.state_entries:_fail('HELPER_DISCOVERY_TARGETS_INVALID')
    for target in targets:
        _fields(target,('session_id','pid','start_ticks','identity_sha256'))
        if (type(target['session_id']) is not str or not re.fullmatch('[0-9a-f]{32}',target['session_id']) or target['session_id'] in ids or type(target['pid']) is not int or (target['pid']!=0 and not 2<=target['pid']<=2147483647) or type(target['start_ticks']) is not str or not re.fullmatch('0|[1-9][0-9]{0,31}',target['start_ticks']) or not _hash(target['identity_sha256'])):_fail('HELPER_DISCOVERY_TARGETS_INVALID')
        ids.add(target['session_id'])
    if [t['session_id'] for t in targets]!=sorted(ids):_fail('HELPER_DISCOVERY_TARGETS_INVALID')
    return row


def validate_gate_bundle(value, token):
    try:validate_contract(value,'GateBundle')
    except (ValueError,TypeError):_fail('HELPER_GATE_SCHEMA_INVALID')
    if report_sha256(value['token'])!=report_sha256(token):_fail('HELPER_GATE_TOKEN_CHANGED')
    reports=value['reports'];gates=('LEGACY','FLOWPILOT','PROCESS','TRANSFERS','CORE')
    if len(reports)!=5 or [r['gate'] for r in reports]!=list(gates):_fail('HELPER_GATE_SET_INVALID')
    reasons=set()
    for report in reports:
        if report['snapshot_sha256']!=report_sha256(token) or (report['status']=='PASS' and report['reason_codes']):_fail('HELPER_GATE_CORRELATION_INVALID')
        reasons.update(report['reason_codes'])
    statuses={r['status'] for r in reports}
    expected=next((s for s in ('FAIL','BLOCKED','UNKNOWN') if s in statuses),'PASS')
    if value['status']!=expected or value['reason_codes']!=sorted(reasons):_fail('HELPER_GATE_VERDICT_INVALID')
    return value


def _facts(pid):
    _assert_kernel_namespace()
    def capture():
        identity=probe_kernel_process(pid)
        if identity is None:_fail('HELPER_PROCESS_ABSENT')
        raw=_kernel_bytes('/proc/'+str(pid)+'/status');facts={}
        for key in ('Uid','Gid','Groups','PPid'):
            match=re.search(('^'+key+r':\s*([0-9 \t]*)$').encode(),raw,re.M)
            if not match:_fail('HELPER_PROCESS_IDENTITY_UNKNOWN')
            facts[key]=tuple(int(v) for v in match[1].split())
        cg=_kernel_bytes('/proc/'+str(pid)+'/cgroup')
        if not re.fullmatch(rb'0::/[^\x00\r\n]*\n',cg):_fail('HELPER_CGROUP_UNKNOWN')
        return {'identity':identity,**facts,'cgroup_sha256':hashlib.sha256(cg).hexdigest()}
    before=capture();after=capture()
    if before!=after:_fail('HELPER_PROCESS_IDENTITY_CHANGED')
    return before


class _HeldReadonlyHelper:
    def __init__(self, owner, child, pid):
        self.owner=owner;self.child=child;self.pid=pid
        self.facts=_facts(pid);self.parent_facts=_facts(child.pid)
        p=owner.lease.profile;argv=(p.runtime.node_path,str(owner.entrypoint))
        if (self.facts['PPid']!=(child.pid,) or self.facts['Uid']!=(p.binding.uid,)*4 or self.facts['Gid']!=(p.binding.gid,)*4 or tuple(sorted(set(self.facts['Groups'])-{p.binding.gid}))!=p.binding.supplementary_gids or self.facts['identity']['exe']!=p.runtime.node_path or self.facts['identity']['cmdlineSha256']!=hashlib.sha256(('\0'.join(argv)+'\0').encode()).hexdigest()):_fail('HELPER_PROCESS_NOT_OWNED')
        fd=os.open('/proc/'+str(pid)+'/exe',os.O_RDONLY|os.O_CLOEXEC)
        try:
            before=os.fstat(fd);digest=hashlib.sha256();count=0
            if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_mode&0o6022 or before.st_size>268435456:_fail('HELPER_NODE_UNQUALIFIED')
            while True:
                chunk=os.read(fd,1048576)
                if not chunk:break
                count+=len(chunk);digest.update(chunk)
                if count>before.st_size:_fail('HELPER_NODE_CHANGED')
            if count!=before.st_size or digest.hexdigest()!=p.runtime.node_sha256 or _identity(before)!=_identity(os.fstat(fd)):_fail('HELPER_NODE_CHANGED')
            self.exe_identity=_identity(before)
        finally:os.close(fd)
        self.pidfd=os.pidfd_open(pid,0)
        try:self.check()
        except BaseException:
            os.close(self.pidfd);raise
    def check(self):
        if self.child.poll() is not None or _facts(self.child.pid)!=self.parent_facts or _facts(self.pid)!=self.facts:_fail('HELPER_PROCESS_IDENTITY_CHANGED')
        fd=os.open('/proc/'+str(self.pid)+'/exe',os.O_RDONLY|os.O_CLOEXEC)
        try:
            if _identity(os.fstat(fd))!=self.exe_identity:_fail('HELPER_NODE_CHANGED')
        finally:os.close(fd)
    def matches_pid(self,pid):
        self.check();return pid==self.pid


class QualifiedReadonlyAuditRunner:
    scope='QUALIFIED_FIXED_READONLY_HELPER'
    def __init__(self,lease,manifest):
        if type(lease) is not PauseLease or type(lease.backend) is not QualifiedHostBackend or lease.scope!='QUALIFIED_HOST_PAUSE' or os.getuid()!=0 or os.geteuid()!=0:_fail('HELPER_LAUNCHER_UNQUALIFIED')
        _assert_kernel_namespace();lease.check();self.lease=lease;self.manifest=manifest;validate_manifest(manifest)
        p=lease.profile
        if (manifest.kind!='TOOLKIT' or manifest.source_sha!=p.toolkit.source_sha or manifest.tree_sha!=p.toolkit.tree_sha or manifest.sha256!=p.toolkit.manifest_sha256 or manifest.node_sha256!=p.runtime.node_sha256):_fail('HELPER_TOOLKIT_UNQUALIFIED')
        self.root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha);self.entrypoint=self.root/'dist/server/cli/rbridgeInstallationAudit.js'
        if Path(__file__).resolve()!=self.root/'ops/install/rbridge_installation/readonly_helper.py' or sys.version.split()[0]!=p.toolkit.python_version or not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):_fail('HELPER_ROOT_INTERPRETER_UNQUALIFIED')
        if hashlib.sha256(_protected_bytes(p.toolkit.python_path,268435456)).hexdigest()!=p.toolkit.python_sha256 or os.path.realpath('/proc/self/exe')!=p.toolkit.python_path:_fail('HELPER_ROOT_INTERPRETER_UNQUALIFIED')
        self.authority=FilesystemAuthority(0,p.binding.uid,Path(p.paths.release_parent),'TOOLKIT',True,manifest.sha256,manifest.source_sha,manifest.tree_sha)
        self.runuser=next(t for t in p.tools if t.role=='runuser');self.helper_evidence=[];self._qualify()
    def _qualify(self):
        p=self.lease.profile;verify_published(self.root,self.manifest,self.authority)
        if not all(any(e.path==path and e.kind=='FILE' for e in self.manifest.entries) for path in ('dist/server/cli/rbridgeInstallationAudit.js','ops/install/rbridge_installation/readonly_helper.py')):_fail('HELPER_ENTRYPOINT_UNQUALIFIED')
        sidecar=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha+'.manifest.json')
        captured=_json(_protected_bytes(sidecar,33554432),33554432)
        if report_sha256(captured)!=report_sha256(self.manifest):_fail('HELPER_MANIFEST_SIDECAR_CHANGED')
        node=_protected_bytes(p.runtime.node_path,268435456)
        if hashlib.sha256(node).hexdigest()!=p.runtime.node_sha256:_fail('HELPER_NODE_UNQUALIFIED')
        if _run_fixed_tool(self.runuser,('--version',),5000,16384).decode().splitlines()[0]!=self.runuser.version:_fail('HELPER_RUNUSER_UNQUALIFIED')
    def run(self,value):
        p=self.lease.profile;self.lease.check();self._qualify()
        if type(value) is not dict or value.get('schema') not in ('RBRIDGE_INSTALL_DISCOVERY_INPUT_V1','RBRIDGE_INSTALL_AUDIT_INPUT_V1') or report_sha256(value.get('profile'))!=report_sha256(p):_fail('HELPER_FIXED_INPUT_REQUIRED')
        token=value.get('token')
        try:validate_contract(token,'SnapshotToken')
        except (ValueError,TypeError):_fail('HELPER_FIXED_INPUT_REQUIRED')
        if token['pause_sha256']!=self.lease.pause_sha256:_fail('HELPER_PAUSE_CHANGED')
        snapshot=capture_snapshot(self.lease)
        root_identity=report_sha256({k:v for k,v in snapshot.root_metadata.items() if k!='atime_ns'})
        if snapshot.tree_sha256!=token['tree_sha256'] or snapshot.bytes!=token['bytes'] or len(snapshot.entries)!=token['entries'] or root_identity!=token['state_root_identity_sha256']:_fail('HELPER_SNAPSHOT_CHANGED')
        body=encode_report(value)
        if len(body)>p.budget.carrier_bytes:_fail('HELPER_INPUT_LIMIT')
        nonce=secrets.token_hex(32);env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':p.binding.home,'USER':p.binding.account,'LOGNAME':p.binding.account,'LC_ALL':'C','RBRIDGE_INSTALL_HELPER_NONCE':nonce}
        child=subprocess.Popen([self.runuser.path,'--user','rbridge','--',p.runtime.node_path,str(self.entrypoint)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,cwd='/',start_new_session=True)
        try:parentfd=os.pidfd_open(child.pid,0)
        except OSError:
            child.kill();child.wait(timeout=p.budget.stop_ms/1000);_fail('HELPER_PARENT_IDENTITY_UNAVAILABLE')
        held=None;selector=selectors.DefaultSelector();out=bytearray();errors=bytearray();pending=memoryview(body);ready=False;deadline=min(self.lease.deadline,time.monotonic()+p.budget.scan_ms/1000)
        try:
            for stream in (child.stdin,child.stdout,child.stderr):os.set_blocking(stream.fileno(),False)
            selector.register(child.stdout,selectors.EVENT_READ);selector.register(child.stderr,selectors.EVENT_READ)
            while selector.get_map():
                remaining=deadline-time.monotonic()
                if remaining<=0:_fail('HELPER_COMMAND_DEADLINE')
                for key,_ in selector.select(min(remaining,0.2)):
                    if key.fileobj is child.stdin:
                        pending=pending[os.write(key.fd,pending):]
                        if not pending:selector.unregister(child.stdin);child.stdin.close()
                        continue
                    chunk=os.read(key.fd,65536)
                    if not chunk:selector.unregister(key.fileobj);continue
                    destination=out if key.fileobj is child.stdout else errors;destination.extend(chunk)
                    if len(out)+len(errors)>p.budget.carrier_bytes:_fail('HELPER_OUTPUT_LIMIT')
                    if key.fileobj is child.stderr and not ready:
                        if len(errors)>4096:_fail('HELPER_READY_INVALID')
                        if b'\n' in errors:
                            pid=parse_helper_ready(bytes(errors),nonce);held=_HeldReadonlyHelper(self,child,pid)
                            if not hasattr(self.lease.backend,'readonly_helpers'):self.lease.backend.readonly_helpers={}
                            self.lease.backend.readonly_helpers[pid]=held;ready=True;self.lease.check();selector.register(child.stdin,selectors.EVENT_WRITE)
                            self.helper_evidence.append({'scope':'ROOT_LAUNCHED_EXACT_READONLY_HELPER','facts':held.facts,'parent_facts':held.parent_facts,'node_sha256':p.runtime.node_sha256,'toolkit_manifest_sha256':self.manifest.sha256,'profile_sha256':report_sha256(p),'snapshot_sha256':report_sha256(token),'nonce_sha256':hashlib.sha256(nonce.encode()).hexdigest(),'input_sha256':hashlib.sha256(body).hexdigest()})
                    if held is not None and not selectors_ready(held.pidfd) and child.poll() is None:self.lease.check()
            code=child.wait(timeout=max(0.001,deadline-time.monotonic()))
            if not ready or code not in (0,2,4,5):_fail('HELPER_COMMAND_FAILED')
            result=_json(bytes(out),p.budget.carrier_bytes)
            if type(result) is not dict:_fail('HELPER_PACKET_INVALID')
            self.helper_evidence[-1].update(output_sha256=hashlib.sha256(out).hexdigest(),exit_code=code)
            if result.get('status')=='PASS' and code!=0:_fail('HELPER_EXIT_VERDICT_MISMATCH')
            if value['schema']=='RBRIDGE_INSTALL_DISCOVERY_INPUT_V1':return validate_discovery(result,p,token)
            return validate_gate_bundle(result,token)
        except (OSError,subprocess.TimeoutExpired):_fail('HELPER_COMMAND_UNAVAILABLE')
        finally:
            selector.close()
            # Signal only the exact processes held by our own pidfds; no PID-name kills.
            if held is not None:
                try:signal.pidfd_send_signal(held.pidfd,signal.SIGKILL)
                except ProcessLookupError:pass
            try:child.wait(timeout=p.budget.stop_ms/1000)
            except subprocess.TimeoutExpired:
                try:signal.pidfd_send_signal(parentfd,signal.SIGKILL)
                except ProcessLookupError:pass
                child.wait(timeout=p.budget.stop_ms/1000)
            if held is not None:
                # Twice-observed absence precedes removal of the pause exemption.
                if probe_kernel_process(held.pid) is not None:_fail('HELPER_SETTLEMENT_UNPROVEN')
                self.lease.backend.readonly_helpers.pop(held.pid,None);os.close(held.pidfd)
            os.close(parentfd)
            for stream in (child.stdin,child.stdout,child.stderr):stream.close()
            self._qualify();self.lease.check()


def run_paused_gates(lease,token,manifest):
    """Discovery, authenticated complete lookup, kernel observations, then five gates."""
    from .github_lookup import QualifiedGitHubReadBackend,lookup_issues
    from .process_observation import collect_process_observations
    if type(lease) is not PauseLease or type(lease.backend) is not QualifiedHostBackend or lease.scope!='QUALIFIED_HOST_PAUSE':_fail('HELPER_LAUNCHER_UNQUALIFIED')
    profile=lease.profile;token=json.loads(encode_report(token));validate_contract(token,'SnapshotToken');lease.check()
    runner=QualifiedReadonlyAuditRunner(lease,manifest)
    discovery=runner.run({'schema':'RBRIDGE_INSTALL_DISCOVERY_INPUT_V1','profile':profile,'token':token})
    lookup_backend=QualifiedGitHubReadBackend(profile)
    issues=lookup_issues(profile,discovery['issue_numbers'],lookup_backend);lease.check()
    if lookup_backend.capture_status!='PASS' or lookup_backend.profile_sha256!=report_sha256(profile):_fail('HELPER_AUTHENTICATED_LOOKUP_INCOMPLETE')
    observations=collect_process_observations(lease,token,discovery['process_targets']);lease.check()
    lookup={'scope':'QUALIFIED_GITHUB_READ','status':'PASS','viewer':profile.binding.author,'repository':profile.binding.repository,'profile_sha256':report_sha256(profile),'snapshot_sha256':report_sha256(token),'capture_sha256':report_sha256(issues)}
    bundle=runner.run({'schema':'RBRIDGE_INSTALL_AUDIT_INPUT_V1','profile':profile,'token':token,'issues':issues,'lookup':lookup,'observations':observations})
    after=capture_snapshot(lease)
    if after.tree_sha256!=token['tree_sha256'] or after.pause_sha256!=token['pause_sha256']:_fail('HELPER_SNAPSHOT_CHANGED')
    return {'schema':'RBRIDGE_INSTALL_PAUSED_GATES_PROOF_V1','scope':'QUALIFIED_HOST_PAUSE','profile_sha256':report_sha256(profile),'snapshot_sha256':report_sha256(token),'toolkit_manifest_sha256':manifest.sha256,'lookup_capture_sha256':lookup_backend.capture_sha256,'lookup_rate_sha256':lookup_backend.rate_sha256,'observation_sha256':report_sha256(observations),'helper_launches':runner.helper_evidence,'process_unit_evidence':lease.backend.process_unit_evidence,'bundle':bundle}
