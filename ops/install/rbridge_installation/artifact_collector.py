"""Concrete protected Root launcher for the isolated non-root final-artifact fixture.

Only this fixed producer registers observations. Captured JSON and caller-made
tokens remain data; even a genuine artifact observation grants no service action
and cannot substitute for readers, privileged fixtures, review or bootstrap.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import sys
import weakref
from .artifact import validate_manifest
from .models import InstallationError,encode_report,report_sha256
from .profile import parse_profile
from .protected_copy import DIR_FLAGS,FilesystemAuthority,verify_published,_same
from .qualification import verify_import_closure,_artifact
from .host_backend import _assert_kernel_namespace,_protected_bytes,_run_fixed_tool
from .owned_process import run_owned_process,assert_owned_helpers_settled
from .readonly_helper import _json,validate_readonly_ready,parse_helper_ready


class ArtifactCollectorError(InstallationError):pass
def _fail(reason):raise ArtifactCollectorError(reason)


@dataclass(frozen=True,eq=False)
class _RootArtifactObservation:
    profile_sha256:str
    evidence_json:str
    session_json:str
    fixture_home:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)))
    root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/artifact_collector.py'):
        _fail('ARTIFACT_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();verify_import_closure(root,p,request)
    return p,root


class _FixtureHome:
    def __init__(self,profile):
        self.profile=profile;self.handles=[];self.links=[];self.fd=None
        self.name='.rbridge-artifact-'+secrets.token_hex(16)
        self.path=Path(profile.binding.home)/self.name
        try:
            parent=os.open('/',DIR_FLAGS);self.handles.append(parent)
            for i,name in enumerate(Path(profile.binding.home).parts[1:]):
                before=os.stat(name,dir_fd=parent,follow_symlinks=False)
                owner=profile.binding.uid if i==len(Path(profile.binding.home).parts)-2 else 0
                if (not stat.S_ISDIR(before.st_mode) or before.st_uid!=owner or before.st_mode&0o6022
                        or owner!=0 and before.st_gid!=profile.binding.gid):_fail('ARTIFACT_COLLECTOR_HOME_UNQUALIFIED')
                child=os.open(name,DIR_FLAGS,dir_fd=parent);self.handles.append(child)
                if not _same(before,os.fstat(child)):_fail('ARTIFACT_COLLECTOR_HOME_CHANGED')
                self.links.append((parent,name,child,before));parent=child
            self.parent=parent;os.mkdir(self.name,0o700,dir_fd=parent);os.fsync(parent)
            before=os.stat(self.name,dir_fd=parent,follow_symlinks=False)
            self.fd=os.open(self.name,DIR_FLAGS,dir_fd=parent);self.handles.append(self.fd)
            if not _same(before,os.fstat(self.fd)) or before.st_uid!=0 or before.st_mode&0o7777!=0o700:
                _fail('ARTIFACT_COLLECTOR_HOME_CHANGED')
            os.fchown(self.fd,profile.binding.uid,profile.binding.gid);os.fchmod(self.fd,0o700);os.fsync(self.fd)
            self.identity=os.fstat(self.fd);self.check()
            if os.listdir(self.fd):_fail('ARTIFACT_COLLECTOR_HOME_NOT_EMPTY')
        except BaseException:self.close();raise
    def check(self):
        for parent,name,child,before in self.links:
            if not _same(before,os.fstat(child)) or not _same(before,os.stat(name,dir_fd=parent,follow_symlinks=False)):
                _fail('ARTIFACT_COLLECTOR_HOME_CHANGED')
        row=os.fstat(self.fd);named=os.stat(self.name,dir_fd=self.parent,follow_symlinks=False)
        if not _same(row,self.identity) or not _same(named,self.identity) or row.st_mode&0o7777!=0o700:
            _fail('ARTIFACT_COLLECTOR_HOME_CHANGED')
    def close(self):
        for handle in reversed(self.handles):os.close(handle)
        self.handles=[]
        # Retain the entire fixture, including every partial failure, for review.


def _closure(profile,root,runtime_manifest,toolkit_manifest,request):
    _context(profile,request)
    for manifest in (runtime_manifest,toolkit_manifest):
        validate_manifest(manifest);pin=profile.runtime if manifest.kind=='RUNTIME' else profile.toolkit
        if (manifest.sha256!=pin.manifest_sha256 or manifest.source_sha!=pin.source_sha
                or manifest.tree_sha!=pin.tree_sha or manifest.node_sha256!=profile.runtime.node_sha256):
            _fail('ARTIFACT_COLLECTOR_MANIFEST_UNQUALIFIED')
        authority=FilesystemAuthority(0,profile.binding.uid,Path(profile.paths.release_parent),manifest.kind,True,
            manifest.sha256,manifest.source_sha,manifest.tree_sha)
        path=Path(profile.paths.release_parent)/(manifest.source_sha if manifest.kind=='RUNTIME' else 'toolkit-'+manifest.source_sha)
        verify_published(path,manifest,authority)
    if runtime_manifest.kind!='RUNTIME' or toolkit_manifest.kind!='TOOLKIT':_fail('ARTIFACT_COLLECTOR_MANIFEST_UNQUALIFIED')
    required={'dist/server/cli/rbridgeArtifactQualification.js','dist/server/installation/artifactQualification.js',
        'dist/server/installation/artifactFixture.js','dist/server/installation/artifactEvidence.js',
        'ops/install/rbridge_installation/artifact_collector.py'}
    if not required<={e.path for e in toolkit_manifest.entries if e.kind=='FILE'}:_fail('ARTIFACT_COLLECTOR_ENTRY_UNQUALIFIED')
    sidecar=_json(_protected_bytes(Path(profile.paths.release_parent)/(root.name+'.manifest.json'),33554432))
    if report_sha256(sidecar)!=report_sha256(toolkit_manifest):_fail('ARTIFACT_COLLECTOR_MANIFEST_CHANGED')
    if hashlib.sha256(_protected_bytes(profile.runtime.node_path,268435456)).hexdigest()!=profile.runtime.node_sha256:
        _fail('ARTIFACT_COLLECTOR_NODE_CHANGED')


def collect_root_artifact_fixture(profile,runtime_manifest,toolkit_manifest,qualification_request):
    p,root=_context(profile,qualification_request)
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    runuser=next(t for t in p.tools if t.role=='runuser')
    if _run_fixed_tool(runuser,('--version',),5000,16384).decode().splitlines()[0]!=runuser.version:
        _fail('ARTIFACT_COLLECTOR_RUNUSER_UNQUALIFIED')
    home=_FixtureHome(p)
    try:
        runtime=Path(p.paths.release_parent)/p.runtime.source_sha
        node_args=[p.runtime.node_path,str(root/'dist/server/cli/rbridgeArtifactQualification.js')]
        parent_args=[runuser.path,'--user',p.binding.account,'--',*node_args]
        binding={'runtimeUid':p.binding.uid,'principalId':p.binding.principal_id,'targetInstanceId':p.binding.target_instance_id}
        mcp_args=[p.runtime.node_path,str(root/'dist/server/installation/artifactFixture.js'),'--stdio-client',str(runtime),
            str(home.path/'.local/state/rbridge/execution-v2'),json.dumps(binding,separators=(',',':'))]
        spec={'exe':p.runtime.node_path,'argv':node_args,'uid':p.binding.uid,'gid':p.binding.gid,
            'groups':list(p.binding.supplementary_gids),'parent_argv':parent_args,'max_count':1}
        specs=[spec,{**spec,'argv':mcp_args,'parent_argv':node_args}]
        nonce=secrets.token_hex(32);child=None
        def started(actual):
            nonlocal child
            child=actual
        def ready(raw,observed):
            if child is None:_fail('ARTIFACT_COLLECTOR_PARENT_UNQUALIFIED')
            # No SDK child may start before the fixed input is released.
            validate_readonly_ready(raw,nonce,child.pid,observed,spec)
        def guard():
            _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request);home.check()
        value={'schema':'RBRIDGE_INSTALL_ARTIFACT_INPUT_V1','profile':p,'runtime_manifest':runtime_manifest,
            'toolkit_manifest':toolkit_manifest,'isolated_home':str(home.path)}
        raw,errors,session=run_owned_process(runuser,parent_args[1:],min(p.budget.scan_ms,180000),p.budget.carrier_bytes,
            input_bytes=encode_report(value),child_specs=specs,guard=guard,started=started,ready=ready,
            env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':p.binding.home,'USER':p.binding.account,
                'LOGNAME':p.binding.account,'LC_ALL':'C','RBRIDGE_INSTALL_HELPER_NONCE':nonce})
        data=_json(raw,p.budget.carrier_bytes)
        parse_helper_ready(errors,nonce)
        if session['exit_code']!=0 or _artifact(p,data)!='PASS':_fail('ARTIFACT_COLLECTOR_FIXTURE_UNQUALIFIED')
        assert_owned_helpers_settled();home.check();guard()
        evidence={'artifact':data,'input_json':encode_report(value).decode(),'output_json':raw.decode('utf-8',errors='strict'),
            'ready_json':errors.decode('utf-8',errors='strict'),'node_sha256':p.runtime.node_sha256,
            'runtime_manifest_sha256':runtime_manifest.sha256,'toolkit_manifest_sha256':toolkit_manifest.sha256}
        token=_RootArtifactObservation(report_sha256(p),encode_report(evidence).decode(),encode_report(session).decode(),str(home.path))
        _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest)
        return token
    finally:home.close()


def verify_root_artifact_observation(profile,token,qualification_request):
    if type(token) is not _RootArtifactObservation or token not in _observations:_fail('ARTIFACT_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,runtime_manifest,toolkit_manifest=_observations[token]
    if report_sha256(token)!=pin or report_sha256(profile)!=token.profile_sha256:
        _fail('ARTIFACT_COLLECTOR_OBSERVATION_CHANGED')
    p,root=_context(profile,qualification_request)
    _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request)
    evidence=_json(token.evidence_json.encode());session=_json(token.session_json.encode())
    if (_artifact(p,evidence['artifact'])!='PASS' or session.get('status')!='PASS'
            or session.get('scope')!='ROOT_FIXED_PROCESS_OBSERVATION' or session.get('exit_code')!=0
            or session.get('live_helpers')!=[]):_fail('ARTIFACT_COLLECTOR_OBSERVATION_CHANGED')
    return {'scope':'ROOT_FINAL_ARTIFACT_OBSERVATION','artifact':evidence['artifact'],'evidence':evidence,
        'session':session,'service_action_authorized':False}
