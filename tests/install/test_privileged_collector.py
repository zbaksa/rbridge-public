"""Full Source component data remains separate from genuine Root origins."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from _loader import toolkit,ROOT
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


class PrivilegedCollectorTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.privileged_collector import collect_root_privileged_fixtures,verify_root_privileged_observation,PrivilegedFixtureOrigins,_RootPrivilegedObservation
        except ImportError:self.fail('Protected six-case origin assembly is absent')
        self.collect,self.verify,self.Origins,self.Token=collect_root_privileged_fixtures,verify_root_privileged_observation,PrivilegedFixtureOrigins,_RootPrivilegedObservation
        self.p=parse_profile(valid_profile())

    def test_source_context_cannot_open_root_or_invoke_any_component_collector(self):
        from rbridge_installation import privileged_collector as c
        origins=self.Origins(None,None,None,None,None,None,None)
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch.object(c,'verify_root_copy_ledger_observation',side_effect=AssertionError('Source component observation')):
            self.assertRaisesRegex(ValueError,'PRIVILEGED_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,self.p,None,None,origins,{})

    def test_constructed_origin_or_serialized_full_pass_cannot_register_authority(self):
        token=self.Token(report_sha256(self.p),'a'*64,'{}','/root/.rbridge-privileged-'+'b'*32)
        for value in (token,{'scope':'ROOT_PROTECTED_PRIVILEGED_FIXTURE_OBSERVATION','status':'PASS','cases':{}}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'PRIVILEGED_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.p,value,{})

    def test_private_source_registry_entry_still_requires_actual_root_context(self):
        from rbridge_installation import privileged_collector as c
        origins=self.Origins(None,None,None,None,None,None,None)
        token=self.Token(report_sha256(self.p),report_sha256(origins),'{}','/root/.rbridge-privileged-'+'b'*32)
        c._observations[token]=(report_sha256(token),origins,None,None,self.p,c._snapshot(origins))
        try:
            with patch('os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'PRIVILEGED_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.verify,self.p,token,{})
        finally:del c._observations[token]

    def test_equal_metadata_origin_set_cannot_replace_original_objects(self):
        from rbridge_installation import privileged_collector as c
        origins=self.Origins(None,None,None,None,None,None,None)
        substitute=self.Origins(None,None,None,None,None,None,None)
        token=self.Token(report_sha256(self.p),report_sha256(origins),'{}','/root/.rbridge-privileged-'+'b'*32)
        c._observations[token]=(report_sha256(token),origins,None,None,self.p,c._snapshot(origins))
        try:
            with patch('os.open',side_effect=AssertionError('Substitute Root open')):
                self.assertRaisesRegex(ValueError,'PRIVILEGED_COLLECTOR_COMPONENT_ORIGIN_CHANGED',self.verify,self.p,token,{},origins=substitute)
        finally:del c._observations[token]

    def test_mutated_token_or_mutated_original_origin_set_refuses_before_io(self):
        from rbridge_installation import privileged_collector as c
        for mutation in ('token','original'):
            origins=self.Origins(None,None,None,None,None,None,None)
            token=self.Token(report_sha256(self.p),report_sha256(origins),'{}','/root/.rbridge-privileged-'+'b'*32)
            c._observations[token]=(report_sha256(token),origins,None,None,self.p,c._snapshot(origins))
            try:
                if mutation=='token':object.__setattr__(token,'evidence_json','{"status":"PASS"}')
                else:object.__setattr__(origins,'bootstrap_fixture',{'status':'PASS'})
                with patch('os.open',side_effect=AssertionError('Mutated Root open')):
                    self.assertRaisesRegex(ValueError,'PRIVILEGED_COLLECTOR_'+('OBSERVATION_CHANGED' if mutation=='token' else 'COMPONENT_ORIGIN_CHANGED'),self.verify,self.p,token,{})
            finally:del c._observations[token]

    def test_same_metadata_component_swap_inside_original_set_is_detected_before_root_context(self):
        from rbridge_installation import privileged_collector as c
        from rbridge_installation.artifact_collector import _RootArtifactObservation
        first=_RootArtifactObservation(report_sha256(self.p),'{}','{}',self.p.binding.home+'/.rbridge-artifact-'+'c'*32)
        replacement=_RootArtifactObservation(report_sha256(self.p),'{}','{}',first.fixture_home)
        origins=self.Origins(first,None,None,None,None,None,None)
        token=self.Token(report_sha256(self.p),report_sha256(origins),'{}','/root/.rbridge-privileged-'+'b'*32)
        c._observations[token]=(report_sha256(token),origins,None,None,self.p,c._snapshot(origins))
        try:
            object.__setattr__(origins,'artifact',replacement)
            self.assertEqual(token.origins_sha256,report_sha256(origins))
            with patch('os.open',side_effect=AssertionError('Swapped Source component Root open')):
                self.assertRaisesRegex(ValueError,'PRIVILEGED_COLLECTOR_COMPONENT_ORIGIN_CHANGED',self.verify,self.p,token,{})
        finally:del c._observations[token]


class PrivilegedComponentDataTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.privileged_collector import compare_privileged_components
        except ImportError:self.fail('Full six-case byte comparison is absent')
        self.compare=compare_privileged_components
        from test_helper_family_case import source_case_data
        from rbridge_installation.helper_family_case import capture_helper_family_case
        from rbridge_installation.copy_ledger_fixture import produce_copy_ledger_cases
        from rbridge_installation.config_cas_fixture import produce_config_cas_cases
        from rbridge_installation.fake_unit_case import render_fake_unit,fake_unit_argv,capture_fake_unit_case
        from test_fake_unit_case import synthetic_unit_data
        from rbridge_installation.bootstrap_fixture import produce_bootstrap_case
        self.p,evidence,session,home=source_case_data()
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);root=Path(tmp.name);root.chmod(0o700)
        dirs={name:root/name for name in ('copy','config','bootstrap')}
        for path in dirs.values():path.mkdir(mode=0o700)
        spec=importlib.util.spec_from_file_location('source_assembled_bootstrap',ROOT/'ops/install/rbridge_bootstrap.py')
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        payload=(ROOT/'ops/install/rbridge_bootstrap.py').read_bytes()
        manifest={'schema':'RBRIDGE_BOOTSTRAP_MANIFEST_V1','source_sha':self.p.toolkit.source_sha,'tree_sha':self.p.toolkit.tree_sha,
            'payload_bytes':len(payload),'payload_sha256':hashlib.sha256(payload).hexdigest(),
            'toolkit_manifest_sha256':self.p.toolkit.manifest_sha256,'python_closure_sha256':'a'*64}
        binding={'repository':self.p.binding.repository,'author':self.p.binding.author,'issue_number':17}
        body={'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1','manifest':manifest,'payload_base64':base64.b64encode(payload).decode()}
        capture={'schema':'RBRIDGE_BOOTSTRAP_ARTIFACT_CAPTURE_V1','repository':self.p.binding.repository,'viewer':self.p.binding.author,
            'author':self.p.binding.author,'issue_number':17,'is_pull_request':False,
            'url':'https://github.com/'+self.p.binding.repository+'/issues/17','body':encode_report(body).decode()}
        # Only the kernel/systemd observations are synthetic; file, copy, crash,
        # configuration and standalone byte mechanics execute in Source fixtures.
        args=synthetic_unit_data(render_fake_unit,fake_unit_argv,profile=self.p)
        self.components={'copy_ledger':produce_copy_ledger_cases(dirs['copy'],self.p),
            'config_cas':produce_config_cas_cases(dirs['config'],self.p),
            'owned_helper_family':capture_helper_family_case(self.p,evidence,session,home),
            'fake_unit_stop':capture_fake_unit_case(*args),
            'bootstrap':produce_bootstrap_case(dirs['bootstrap'],self.p,self.module,payload,manifest,capture,binding)}

    def test_complete_full_source_cases_remain_data_and_preserve_each_original(self):
        result=self.compare(self.p,self.module,self.components)
        self.assertEqual(result['scope'],'PRIVILEGED_COMPONENT_DATA_ONLY');self.assertFalse(result['may_execute'])
        self.assertEqual(result['physical_origin'],'UNQUALIFIED');self.assertEqual(result['bootstrap_execution'],'NOT_PERFORMED')
        self.assertEqual(set(result['cases']),{'copy','ledger_crash','config_cas','owned_helper_family','fake_unit_stop','bootstrap'})
        self.assertEqual(result['cases']['copy'],self.components['copy_ledger']['cases']['copy'])
        self.assertEqual(json.loads(result['cases']['config_cas']['output_json']),self.components['config_cas'])
        self.assertEqual(json.loads(result['cases']['owned_helper_family']['input_json']),self.components['owned_helper_family'])
        self.assertEqual(result['cases']['bootstrap']['input_json'],self.components['bootstrap']['input_json'])
        from rbridge_installation.qualification import build_qualification,QualificationProofs
        assessment=build_qualification(self.p,QualificationProofs(privileged=result))
        self.assertEqual(assessment.status,'BLOCKED');self.assertFalse(assessment.command_ready)

    def test_missing_extra_or_cross_profile_component_refuses_even_with_full_rehash(self):
        for name in self.components:
            values=copy.deepcopy(self.components);values.pop(name)
            with self.subTest(missing=name):self.assertRaises(ValueError,self.compare,self.p,self.module,values)
        values=copy.deepcopy(self.components);values['caller_pass']={'status':'PASS'}
        self.assertRaises(ValueError,self.compare,self.p,self.module,values)
        values=copy.deepcopy(self.components);case=values['bootstrap'];raw=json.loads(case['input_json'])
        raw['profile_sha256']='c'*64;case['input_json']=encode_report(raw).decode();case['input_sha256']=hashlib.sha256(case['input_json'].encode()).hexdigest()
        self.assertRaises(ValueError,self.compare,self.p,self.module,values)

    def test_rehashed_stop_or_config_failure_cannot_be_hidden_by_other_passes(self):
        for name in ('fake_unit_stop','config_cas'):
            values=copy.deepcopy(self.components)
            row=values[name] if name=='fake_unit_stop' else values[name]['cases']['post_start']
            output=json.loads(row['output_json'])
            if name=='fake_unit_stop':output['pidfd_settled']=False
            else:output['restore_status']='PASS';output['may_start_old']=True
            row['output_json']=encode_report(output).decode();row['output_sha256']=hashlib.sha256(row['output_json'].encode()).hexdigest()
            with self.subTest(component=name):self.assertRaises(ValueError,self.compare,self.p,self.module,values)


if __name__=='__main__':unittest.main()
