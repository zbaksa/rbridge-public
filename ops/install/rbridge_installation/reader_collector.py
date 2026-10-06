"""Protected fixed producer of named installed-reader invocation bytes.

Genuine Root artifact/archive observations are mandatory before any fixture open.
Only the isolated original artifact owner is resumed; SDK children read its known
IDs. Workflow adoption and non-archive Source case provenance remain separate
UNKNOWN gates even if the actual installed reader's case report passes.
"""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import weakref
from .archive_collector import verify_root_archive_for_reader_profile
from .artifact_collector import _closure,verify_root_artifact_for_reader_profile
from .host_backend import _assert_kernel_namespace,_run_fixed_tool
from .models import InstallationError,encode_report,report_sha256,validate_contract
from .owned_process import run_owned_process,assert_owned_helpers_settled
from .profile import parse_profile
from .protected_copy import DIR_FLAGS,_same
from .qualification import verify_import_closure,_artifact_preimages,_readers
from .readonly_helper import _json,validate_readonly_ready,parse_helper_ready


class ReaderCollectorError(InstallationError):pass
def _fail(reason):raise ReaderCollectorError(reason)


def _home(profile,value):
    if (type(value) is not str or Path(value).parent!=Path(profile.binding.home)
            or not re.fullmatch(r'\.rbridge-artifact-[0-9a-f]{32}',Path(value).name)
            or value!=profile.binding.home+'/'+Path(value).name):_fail('READER_COLLECTOR_HOME_INVALID')
    return value


def _prepare_reader_input(profile,registry,fixtures,archive_captures,artifact_fixture,isolated_home):
    """Pure bounded packet comparison. Caller data never registers Root origin."""
    p=parse_profile(json.loads(encode_report(profile)));_home(p,isolated_home)
    raw=encode_report({'registry':registry,'fixtures':fixtures,'archives':archive_captures,'artifact':artifact_fixture})
    if len(raw)>p.budget.carrier_bytes:_fail('READER_COLLECTOR_INPUT_LIMIT')
    validate_contract(registry,'ReaderRegistry');_artifact_preimages(p,artifact_fixture)
    if (encode_report(registry['readers'])!=encode_report(p.readers) or not p.readers
            or {r.transport for r in p.readers}!={'GITHUB','MCP'}):_fail('READER_COLLECTOR_REGISTRY_CHANGED')
    registrations={r.reader_id:r for r in p.readers};adoptions={}
    for adoption in registry['adoptions']:
        r=registrations.get(adoption['reader_id'])
        if (r is None or r.reader_id in adoptions or report_sha256(adoption)!=r.adoption_sha256
                or any(adoption[k]!=getattr(r,k) for k in ('entrypoint','source_sha256','version','trusted_context_sha256'))):
            _fail('READER_COLLECTOR_ADOPTION_CHANGED')
        adoptions[r.reader_id]=adoption
    if set(adoptions)!=set(registrations):_fail('READER_COLLECTOR_ADOPTION_INCOMPLETE')
    if (type(fixtures) is not dict or set(fixtures)!={'cases'} or type(fixtures['cases']) is not list
            or not 1<=len(fixtures['cases'])<=512 or type(archive_captures) is not list
            or not 1<=len(archive_captures)<=512):_fail('READER_COLLECTOR_CASES_INVALID')
    archives={};used=set();eras=set();ids=set()
    for capture in archive_captures:
        if type(capture) is not dict or type(capture.get('capture_sha256')) is not str:_fail('READER_COLLECTOR_ARCHIVE_INVALID')
        digest=capture['capture_sha256']
        if digest in archives:_fail('READER_COLLECTOR_ARCHIVE_INVALID')
        archives[digest]=capture
    for f in fixtures['cases']:
        if (type(f) is not dict or type(f.get('fixture_id')) is not str or not f['fixture_id'] or f['fixture_id'] in ids
                or type(f.get('expected_verdict_sha256')) is not str or not re.fullmatch('[0-9a-f]{64}',f['expected_verdict_sha256'])):
            _fail('READER_COLLECTOR_CASES_INVALID')
        ids.add(f['fixture_id'])
        if f.get('transport')=='GITHUB':
            if f.get('case_id') not in ['C0'+str(n) for n in range(1,9)]:_fail('READER_COLLECTOR_CASES_INVALID')
            if f['case_id']=='C01':
                capture=f.get('capture');expected=f.get('expected')
                if type(capture) is not dict or type(expected) is not dict:_fail('READER_COLLECTOR_ARCHIVE_INVALID')
                digest=capture.get('capture_sha256')
                if (f.get('provenance')!='AUTHENTIC_ARCHIVE' or digest not in archives
                        or encode_report(capture)!=encode_report(archives[digest]) or capture.get('scope')!='AUTHENTICATED_GITHUB_READ'
                        or expected.get('capture_sha256')!=digest or expected.get('capture_context_sha256')!=capture.get('context_sha256')
                        or any(r.trusted_context_sha256!=capture.get('context_sha256') for r in p.readers if r.transport=='GITHUB')):
                    _fail('READER_COLLECTOR_ARCHIVE_CHANGED')
                used.add(digest)
            elif f.get('provenance')!='SYNTHETIC':_fail('READER_COLLECTOR_CORE_CASE_ORIGIN_UNKNOWN')
        elif f.get('transport')=='MCP':
            if (f.get('case_id')!='C09' or f.get('provenance')!='SYNTHETIC' or f.get('era') not in ('legacy','modern')
                    or f['era'] in eras or 'isolated_root' in f or 'transcript' in f):_fail('READER_COLLECTOR_MCP_CASE_INVALID')
            eras.add(f['era'])
        else:_fail('READER_COLLECTOR_CASES_INVALID')
    if used!=set(archives) or not used or eras!={'legacy','modern'}:_fail('READER_COLLECTOR_CASES_INCOMPLETE')
    # Deep copy through the strict shared encoding before the fixed launch.
    return _json(encode_report({'schema':'RBRIDGE_READER_INPUT_V1','operation':'QUALIFY_INSTALLED_ARCHIVED_ARTIFACT',
        'profile':p,'registry':registry,'fixtures':fixtures,'isolated_home':isolated_home,'artifact_fixture':artifact_fixture}))


@dataclass(frozen=True,eq=False)
class _RootReaderObservation:
    profile_sha256:str
    input_json:str
    output_json:str
    session_json:str


_observations=weakref.WeakKeyDictionary()


def _context(profile,request):
    p=parse_profile(json.loads(encode_report(profile)));root=Path(p.paths.release_parent)/('toolkit-'+p.toolkit.source_sha)
    if (os.getuid()!=0 or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or Path(__file__).resolve()!=root/'ops/install/rbridge_installation/reader_collector.py'):
        _fail('READER_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED')
    _assert_kernel_namespace();verify_import_closure(root,p,request);return p,root


class _RetainedFixtureHome:
    def __init__(self,profile,path):
        self.handles=[];self.links=[];home=Path(_home(profile,path))
        try:
            for target in (home,home/'.local/state/rbridge/execution-v2',home/'source'):
                parent=os.open('/',DIR_FLAGS);self.handles.append(parent)
                for index,name in enumerate(target.parts[1:]):
                    owner=profile.binding.uid if index>=len(Path(profile.binding.home).parts)-2 else 0
                    row=os.stat(name,dir_fd=parent,follow_symlinks=False)
                    if (not stat.S_ISDIR(row.st_mode) or row.st_uid!=owner or row.st_mode&0o6022
                            or owner!=0 and row.st_gid!=profile.binding.gid
                            or index>=len(home.parts)-2 and row.st_mode&0o7777!=0o700):_fail('READER_COLLECTOR_HOME_UNQUALIFIED')
                    child=os.open(name,DIR_FLAGS,dir_fd=parent);self.handles.append(child)
                    if not _same(row,os.fstat(child)):_fail('READER_COLLECTOR_HOME_CHANGED')
                    self.links.append((parent,name,child,row));parent=child
            self.check()
        except BaseException:self.close();raise
    def check(self):
        for parent,name,child,row in self.links:
            if not _same(row,os.fstat(child)) or not _same(row,os.stat(name,dir_fd=parent,follow_symlinks=False)):
                _fail('READER_COLLECTOR_HOME_CHANGED')
    def close(self):
        for fd in reversed(self.handles):os.close(fd)
        self.handles=[]


def _inputs(profile,root,runtime_manifest,toolkit_manifest,registry,fixtures,archives,artifact,request):
    _closure(profile,root,runtime_manifest,toolkit_manifest,request)
    observed=verify_root_artifact_for_reader_profile(profile,artifact,request)
    captures=[verify_root_archive_for_reader_profile(profile,t,runtime_manifest,toolkit_manifest,request)['capture'] for t in archives]
    packet=_prepare_reader_input(profile,registry,fixtures,captures,observed['artifact']['receipts'],artifact.fixture_home)
    paths={e.path:e for e in toolkit_manifest.entries if e.kind=='FILE'}
    needed={'dist/server/cli/rbridgeReadResult.js','dist/server/installation/archivedReaderFixture.js',
        'dist/server/installation/readerQualification.js','dist/server/installation/rbridge-installation-client.js',
        'ops/install/rbridge_installation/reader_collector.py'}
    entry='dist/server/cli/rbridgeReadResult.js'
    if (not needed<=set(paths) or any(r.entrypoint!=str(root/entry) or r.source_sha256!=paths[entry].sha256
            or r.version!='1' for r in profile.readers)):_fail('READER_COLLECTOR_ENTRY_UNQUALIFIED')
    packet.update(runtime_manifest=_json(encode_report(runtime_manifest)),toolkit_manifest=_json(encode_report(toolkit_manifest)))
    if len(encode_report(packet))>profile.budget.carrier_bytes:_fail('READER_COLLECTOR_INPUT_LIMIT')
    return packet


def collect_root_reader_invocations(profile,runtime_manifest,toolkit_manifest,registry,fixtures,archive_observations,artifact_observation,qualification_request):
    p,root=_context(profile,qualification_request)
    if type(archive_observations) not in (tuple,list) or not 1<=len(archive_observations)<=512:_fail('READER_COLLECTOR_ARCHIVE_INVALID')
    packet=_inputs(p,root,runtime_manifest,toolkit_manifest,registry,fixtures,archive_observations,artifact_observation,qualification_request)
    runuser=next(t for t in p.tools if t.role=='runuser')
    if _run_fixed_tool(runuser,('--version',),5000,16384).decode().splitlines()[0]!=runuser.version:
        _fail('READER_COLLECTOR_RUNUSER_UNQUALIFIED')
    home=_RetainedFixtureHome(p,packet['isolated_home'])
    try:
        runtime=Path(p.paths.release_parent)/p.runtime.source_sha;state=Path(packet['isolated_home'])/'.local/state/rbridge/execution-v2'
        node_args=[p.runtime.node_path,str(root/'dist/server/cli/rbridgeReadResult.js')]
        parent_args=[runuser.path,'--user',p.binding.account,'--',*node_args]
        binding={'runtimeUid':p.binding.uid,'principalId':p.binding.principal_id,'targetInstanceId':p.binding.target_instance_id}
        sdk_args=[p.runtime.node_path,str(root/'dist/server/installation/artifactFixture.js'),'--stdio-client',str(runtime),str(state),json.dumps(binding,separators=(',',':'))]
        spec={'exe':p.runtime.node_path,'argv':node_args,'uid':p.binding.uid,'gid':p.binding.gid,
            'groups':list(p.binding.supplementary_gids),'parent_argv':parent_args,'max_count':1}
        specs=[spec,{**spec,'argv':sdk_args,'parent_argv':node_args,'max_count':2}]
        nonce=secrets.token_hex(32);child=None
        def started(actual):
            nonlocal child
            child=actual
        def ready(raw,observed):
            if child is None:_fail('READER_COLLECTOR_PARENT_UNQUALIFIED')
            validate_readonly_ready(raw,nonce,child.pid,observed,spec)
        def guard():
            _closure(p,root,runtime_manifest,toolkit_manifest,qualification_request);home.check()
        raw,errors,session=run_owned_process(runuser,parent_args[1:],p.budget.acceptance_ms,p.budget.carrier_bytes,
            input_bytes=encode_report(packet),child_specs=specs,guard=guard,started=started,ready=ready,
            env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':p.binding.home,'USER':p.binding.account,
                'LOGNAME':p.binding.account,'LC_ALL':'C','RBRIDGE_INSTALL_HELPER_NONCE':nonce})
        data=_json(raw,p.budget.carrier_bytes);validate_contract(data,'ReaderQualificationReport');parse_helper_ready(errors,nonce)
        expected=0 if data['actualAcceptance']=='PASS' else 5 if data['actualAcceptance']=='FAIL' else 2
        if session['exit_code']!=expected:_fail('READER_COLLECTOR_EXIT_INCONSISTENT')
        assert_owned_helpers_settled();guard()
        token=_RootReaderObservation(report_sha256(p),encode_report(packet).decode(),raw.decode('utf-8',errors='strict'),
            encode_report({'session':session,'ready_json':errors.decode(),'nonce':nonce}).decode())
        if len(encode_report(token))>p.budget.carrier_bytes:_fail('READER_COLLECTOR_EVIDENCE_BYTE_LIMIT')
        _observations[token]=(report_sha256(token),runtime_manifest,toolkit_manifest,tuple(archive_observations),artifact_observation)
        return token
    finally:home.close()


def verify_root_reader_observation(profile,token,qualification_request):
    if type(token) is not _RootReaderObservation or token not in _observations:_fail('READER_COLLECTOR_ORIGIN_UNQUALIFIED')
    pin,runtime_manifest,toolkit_manifest,archives,artifact=_observations[token]
    if report_sha256(token)!=pin or token.profile_sha256!=report_sha256(profile):_fail('READER_COLLECTOR_OBSERVATION_CHANGED')
    p,root=_context(profile,qualification_request);input_value=_json(token.input_json.encode());output=_json(token.output_json.encode())
    actual=_inputs(p,root,runtime_manifest,toolkit_manifest,input_value['registry'],input_value['fixtures'],archives,artifact,qualification_request)
    if encode_report(actual).decode()!=token.input_json:_fail('READER_COLLECTOR_OBSERVATION_CHANGED')
    proof=_json(token.session_json.encode());session=proof['session'];parse_helper_ready(proof['ready_json'].encode(),proof['nonce'])
    validate_contract(output,'ReaderQualificationReport')
    expected=0 if output['actualAcceptance']=='PASS' else 5 if output['actualAcceptance']=='FAIL' else 2
    if (session['status']!='PASS' or session['scope']!='ROOT_FIXED_PROCESS_OBSERVATION' or session['live_helpers']!=[]
            or session['exit_code']!=expected or session['input_sha256']!=hashlib.sha256(token.input_json.encode()).hexdigest()
            or session['output_sha256']!=hashlib.sha256(token.output_json.encode()).hexdigest()):_fail('READER_COLLECTOR_OBSERVATION_CHANGED')
    readers={'report':output,'registry':input_value['registry']};status=output['actualAcceptance']
    if status=='PASS':_readers(p,readers)
    return {'schema':'RBRIDGE_ROOT_READER_OBSERVATION_V1','scope':'ROOT_INSTALLED_READER_INVOCATIONS','status':status,
        'readers':readers,'input':input_value,'session':proof,'adoption_origin':'UNKNOWN',
        'non_archive_fixture_origin':'SYNTHETIC_SOURCE_DATA_ONLY','may_execute':False,'service_action_authorized':False}
