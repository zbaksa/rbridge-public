"""Copied entry Source negatives and full data, never physical Root origin."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import unittest
from unittest.mock import patch
from _loader import toolkit,ROOT
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


def source_execution_data():
    p=parse_profile(valid_profile())
    python_manifest={'schema':'RBRIDGE_PYTHON_CLOSURE_V1','python_version':p.toolkit.python_version,
        'interpreter_path':p.toolkit.python_path,'interpreter_sha256':p.toolkit.python_sha256,
        'roots':[str(Path(p.toolkit.python_path).parent)],'entries':[
            {'path':str(Path(p.toolkit.python_path).parent),'kind':'DIRECTORY','mode':0o755,'size':0,'sha256':''},
            {'path':p.toolkit.python_path,'kind':'FILE','mode':0o755,'size':123,'sha256':p.toolkit.python_sha256}],
        'absent_paths':[]}
    python_manifest['sha256']=report_sha256(python_manifest);request={'python_closure_sha256':python_manifest['sha256']}
    payload=(ROOT/'ops/install/rbridge_bootstrap.py').read_bytes();digest=hashlib.sha256(payload).hexdigest()
    path='/root/.rbridge-bootstrap-fixture-'+'b'*32+'/bootstrap-'+digest+'/payload.py'
    manifest={'schema':'RBRIDGE_BOOTSTRAP_MANIFEST_V1','source_sha':p.toolkit.source_sha,'tree_sha':p.toolkit.tree_sha,
        'payload_bytes':len(payload),'payload_sha256':digest,'toolkit_manifest_sha256':p.toolkit.manifest_sha256,
        'python_closure_sha256':request['python_closure_sha256']}
    body={'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1','manifest':manifest,'payload_base64':base64.b64encode(payload).decode()}
    capture={'schema':'RBRIDGE_BOOTSTRAP_ARTIFACT_CAPTURE_V1','repository':p.binding.repository,'viewer':p.binding.author,
        'author':p.binding.author,'issue_number':17,'is_pull_request':False,
        'url':'https://github.com/'+p.binding.repository+'/issues/17','body':encode_report(body).decode()}
    spec=importlib.util.spec_from_file_location('source_bootstrap_execution_data',ROOT/'ops/install/rbridge_bootstrap.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    proof=module.verify_bootstrap_artifact(payload,manifest,capture,
        {'repository':p.binding.repository,'author':p.binding.author,'issue_number':17})
    identity=list(map(str,(1,42,stat.S_IFREG|0o400,0,0,1,len(payload),7,8)))
    publication={**proof,'scope':'ROOT_PROTECTED_BYTES_ONLY','path':path,'identity':identity}
    kernel={'pid':17,'self_link':'17','self_status':'Pid:\t17\nNSpid:\t17\n',
        'pid1_status':'Pid:\t1\nNSpid:\t1\n','uid_map':'0 0 4294967295\n','gid_map':'0 0 4294967295\n',
        'namespaces':{k:[k+':[123]',k+':[123]'] for k in ('pid','mnt','user','cgroup')},
        'mountinfo':'1 0 0:1 / /proc rw - proc proc rw\n2 0 0:2 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n'}
    closure={'schema':'RBRIDGE_PYTHON_CLOSURE_BYTES_V1','status':'PASS','scope':'RUNNING_ROOT_INTERPRETER_OBSERVATION_ONLY',
        'execution_qualified':False,'manifest_sha256':request['python_closure_sha256'],'files':1,
        'profile_sha256':report_sha256(p),'imports':[{'module':'__main__','path':path}],
        'mapped_files':[p.toolkit.python_path],'service_action_authorized':False,
        'copied_bootstrap':{'path':path,'payload_sha256':digest,'payload_bytes':len(payload),'identity':identity}}
    output={'schema':'RBRIDGE_BOOTSTRAP_EXECUTION_REPORT_V1','status':'PASS','scope':'ROOT_INTERPRETER_READONLY_PROBE',
        'operation':'QUALIFICATION_FIXTURE_ONLY','profile_sha256':report_sha256(p),
        'toolkit_manifest_sha256':p.toolkit.manifest_sha256,'python_closure_sha256':request['python_closure_sha256'],
        'payload_sha256':digest,'payload_bytes':len(payload),'payload_path':path,'payload_identity':identity,
        'kernel_namespace':kernel,'import_closure':closure,'python_manifest':python_manifest,
        'may_execute':False,'service_action_authorized':False}
    raw_input=encode_report({'profile':p,'qualification':request});raw_output=encode_report(output)+b'\n';nonce='c'*64
    stderr=encode_report({'schema':'RBRIDGE_INSTALL_HELPER_READY_V1','pid':17,'nonce':nonce})+b'\n'
    argv=[p.toolkit.python_path,'-I','-S','-B',path,'--qualification-fixture']
    process={'pid':17,'ppid':2,'session':17,'start_ticks':'123','uid':[0]*4,'gid':[0]*4,'groups':[0],
        'exe':p.toolkit.python_path,'argv':argv}
    session={'schema':'RBRIDGE_OWNED_HELPER_SESSION_V1','scope':'ROOT_FIXED_PROCESS_OBSERVATION','status':'PASS',
        'pid':17,'start_ticks':'123','argv':argv,'executable_sha256':p.toolkit.python_sha256,
        'input_sha256':hashlib.sha256(raw_input).hexdigest(),'output_sha256':hashlib.sha256(raw_output).hexdigest(),
        'processes':[process],'live_helpers':[],'exit_code':0}
    evidence={'schema':'RBRIDGE_BOOTSTRAP_EXECUTION_CAPTURE_V1','scope':'COPIED_BOOTSTRAP_EXECUTION_DATA_ONLY',
        'profile_sha256':report_sha256(p),'manifest':manifest,'capture':capture,'publication':publication,
        'nonce':nonce,'input_base64':base64.b64encode(raw_input).decode(),'output_base64':base64.b64encode(raw_output).decode(),
        'stderr_base64':base64.b64encode(stderr).decode(),'session':session}
    return p,module,request,evidence


class BootstrapExecutionDataTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation.bootstrap_execution_collector import compare_bootstrap_execution
        except ImportError:self.fail('Full copied-bootstrap execution comparison is absent')
        self.compare=compare_bootstrap_execution;self.p,self.module,self.request,self.evidence=source_execution_data()

    def test_complete_synthetic_execution_capture_is_data_only_not_bundle_authority(self):
        value=self.compare(self.p,self.module,self.evidence,self.request)
        self.assertEqual(value['status'],'PASS');self.assertEqual(value['scope'],'COPIED_BOOTSTRAP_EXECUTION_DATA_ONLY')
        self.assertFalse(value['may_execute']);self.assertEqual(value['physical_origin'],'UNQUALIFIED')
        self.assertEqual(value['evidence'],self.evidence)
        from rbridge_installation.qualification import QualificationProofs,build_qualification
        assessment=build_qualification(self.p,QualificationProofs(bootstrap=value))
        self.assertEqual(assessment.status,'BLOCKED');self.assertFalse(assessment.command_ready)

    def test_complete_rehash_cannot_substitute_profile_argv_pid_namespace_or_execute_claim(self):
        for field in ('profile','argv','pid','namespace','execute','import'):
            evidence=copy.deepcopy(self.evidence)
            if field=='argv':evidence['session']['argv'][-1]='apply';evidence['session']['processes'][0]['argv'][-1]='apply'
            else:
                report=json.loads(base64.b64decode(evidence['output_base64']))
                if field=='profile':report['profile_sha256']='d'*64
                elif field=='pid':report['kernel_namespace']['pid']=True
                elif field=='namespace':report['kernel_namespace']['uid_map']='0 0 1\n'
                elif field=='execute':report['may_execute']=True
                else:report['import_closure']['imports'].append({'module':'runtime_install','path':self.p.binding.home+'/installer.py'})
                raw=encode_report(report)+b'\n';evidence['output_base64']=base64.b64encode(raw).decode()
                evidence['session']['output_sha256']=hashlib.sha256(raw).hexdigest()
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,self.p,self.module,evidence,self.request)

    def test_missing_raw_preimage_wrong_readiness_extra_family_or_boolean_exit_refuses(self):
        for field in ('input','output','readiness','family','exit','path','identity'):
            evidence=copy.deepcopy(self.evidence)
            if field=='input':evidence['input_base64']='e30='
            elif field=='output':evidence['output_base64']='e30='
            elif field=='readiness':evidence['stderr_base64']=base64.b64encode(b'{}\n').decode()
            elif field=='family':evidence['session']['processes'].append(copy.deepcopy(evidence['session']['processes'][0]))
            elif field=='exit':evidence['session']['exit_code']=False
            elif field=='path':evidence['publication']['path']=evidence['publication']['path'].replace('/root/','/home/rbridge/')
            else:evidence['publication']['identity'][2]=str(stat.S_IFREG|0o600)
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,self.p,self.module,evidence,self.request)

    def test_foreign_capture_and_changed_closure_pin_refuse_before_any_origin(self):
        self.assertRaises(ValueError,self.compare,self.p,self.module,
            {**self.evidence,'capture':{**self.evidence['capture'],'author':'foreign'}},self.request)
        self.assertRaises(ValueError,self.compare,self.p,self.module,self.evidence,{'python_closure_sha256':'f'*64})


class BootstrapExecutionEntryTests(unittest.TestCase):
    def setUp(self):self.p,self.module,self.request,self.evidence=source_execution_data()

    def test_source_entry_and_caller_mode_refuse_before_root_open_or_readiness(self):
        context=getattr(self.module,'_fixture_context',None)
        self.assertIsNotNone(context,'Guarded copied-bootstrap execution mode is absent')
        with patch.object(self.module.os,'open',side_effect=AssertionError('Source Root open')), \
             patch.object(self.module.sys.stderr,'write',side_effect=AssertionError('Source readiness')):
            self.assertRaisesRegex(ValueError,'BOOTSTRAP_EXECUTION_CONTEXT_UNQUALIFIED',context)

    def test_actual_source_cli_isolated_fixture_mode_blocks_without_reading_input(self):
        run=subprocess.run([sys.executable,'-I','-S','-B',str(ROOT/'ops/install/rbridge_bootstrap.py'),'--qualification-fixture'],
            input=b'invalid input never consumed',stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd='/',timeout=5)
        self.assertEqual(run.returncode,2);value=json.loads(run.stdout)
        self.assertIn('BOOTSTRAP_EXECUTION_CONTEXT_UNQUALIFIED',value['reason_codes']);self.assertEqual(run.stderr,b'')
        self.assertFalse(value['may_execute'])

    def test_standalone_namespace_predicate_matches_full_host_comparison(self):
        validate=getattr(self.module,'_validate_fixture_namespace',None)
        self.assertIsNotNone(validate,'Pre-import namespace predicate is absent')
        from rbridge_installation.host_backend import validate_kernel_namespace_evidence
        kernel=json.loads(base64.b64decode(self.evidence['output_base64']))['kernel_namespace']
        for value in [kernel,{**kernel,'self_link':'18'},{**kernel,'uid_map':'0 0 1\n'},
                {**kernel,'pid':True},{**kernel,'mountinfo':kernel['mountinfo'].replace('- cgroup2','- tmpfs')}]:
            verdicts=[]
            for comparator in (validate,validate_kernel_namespace_evidence):
                try:comparator(value);verdicts.append('PASS')
                except ValueError:verdicts.append('REFUSED')
            self.assertEqual(verdicts[0],verdicts[1])


class BootstrapExecutionCollectorTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import bootstrap_execution_collector as c
        except ImportError:self.fail('Protected copied-bootstrap execution collector is absent')
        self.c=c;self.p=parse_profile(valid_profile())

    def test_source_context_blocks_auth_lookup_copy_or_spawn_before_io(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch.object(self.c,'verify_root_bootstrap_observation',side_effect=AssertionError('Source auth')), \
             patch.object(self.c,'run_owned_process',side_effect=AssertionError('Source Root spawn')):
            self.assertRaisesRegex(ValueError,'BOOTSTRAP_EXECUTION_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',
                self.c.collect_root_bootstrap_execution,self.p,None,None,None,{})

    def test_constructed_or_serialized_token_cannot_register_origin(self):
        token=self.c._RootBootstrapExecutionObservation('a'*64,'b'*64,'{}','/root/.rbridge-bootstrap-fixture-'+'c'*32)
        for value in (token,{'status':'PASS','scope':'ROOT_COPIED_BOOTSTRAP_EXECUTION'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_EXECUTION_COLLECTOR_ORIGIN_UNQUALIFIED',
                    self.c.verify_root_bootstrap_execution,self.p,value,{})

    def test_equal_metadata_cannot_replace_original_auth_object_before_root_io(self):
        from rbridge_installation.bootstrap_collector import _RootBootstrapObservation
        original=_RootBootstrapObservation(report_sha256(self.p),'{}','{}','{}','eA==')
        substitute=_RootBootstrapObservation(report_sha256(self.p),'{}','{}','{}','eA==')
        token=self.c._RootBootstrapExecutionObservation(report_sha256(self.p),report_sha256(original),'{}',
            '/root/.rbridge-bootstrap-fixture-'+'c'*32)
        self.c._observations[token]=(report_sha256(token),original,None,None,self.p)
        try:
            with patch('os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_EXECUTION_COLLECTOR_AUTH_ORIGIN_CHANGED',
                    self.c.verify_root_bootstrap_execution,self.p,token,{},bootstrap_observation=substitute)
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_EXECUTION_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',
                    self.c.verify_root_bootstrap_execution,self.p,token,{},bootstrap_observation=original)
        finally:del self.c._observations[token]

    def test_mutated_private_source_test_token_blocks_before_root_io(self):
        token=self.c._RootBootstrapExecutionObservation(report_sha256(self.p),'b'*64,'{}',
            '/root/.rbridge-bootstrap-fixture-'+'c'*32)
        self.c._observations[token]=(report_sha256(token),None,None,None,self.p)
        try:
            object.__setattr__(token,'evidence_json','{"status":"PASS"}')
            with patch('os.open',side_effect=AssertionError('Mutated Root open')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_EXECUTION_COLLECTOR_OBSERVATION_CHANGED',
                    self.c.verify_root_bootstrap_execution,self.p,token,{})
        finally:del self.c._observations[token]


if __name__=='__main__':unittest.main()
