"""Actual Source copy/readback mechanics, never authenticated Root origin."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from _loader import toolkit,ROOT
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report
from rbridge_installation.profile import parse_profile


class BootstrapFixtureTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.bootstrap_fixture import produce_bootstrap_case,compare_bootstrap_case
        except ImportError:self.fail('Fixed bootstrap publication fixture is absent')
        self.produce,self.compare=produce_bootstrap_case,compare_bootstrap_case
        spec=importlib.util.spec_from_file_location('source_bootstrap_bytes_fixture',ROOT/'ops/install/rbridge_bootstrap.py')
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.p=parse_profile(valid_profile());self.payload=(ROOT/'ops/install/rbridge_bootstrap.py').read_bytes()
        self.manifest={'schema':'RBRIDGE_BOOTSTRAP_MANIFEST_V1','source_sha':self.p.toolkit.source_sha,'tree_sha':self.p.toolkit.tree_sha,
            'payload_bytes':len(self.payload),'payload_sha256':hashlib.sha256(self.payload).hexdigest(),
            'toolkit_manifest_sha256':self.p.toolkit.manifest_sha256,'python_closure_sha256':'a'*64}
        self.binding={'repository':self.p.binding.repository,'author':self.p.binding.author,'issue_number':17}
        body={'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1','manifest':self.manifest,'payload_base64':base64.b64encode(self.payload).decode()}
        self.capture={'schema':'RBRIDGE_BOOTSTRAP_ARTIFACT_CAPTURE_V1','repository':self.p.binding.repository,'viewer':self.p.binding.author,
            'author':self.p.binding.author,'issue_number':17,'is_pull_request':False,
            'url':'https://github.com/'+self.p.binding.repository+'/issues/17','body':encode_report(body).decode()}
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.root.chmod(0o700)

    def case(self):return self.produce(self.root,self.p,self.module,self.payload,self.manifest,self.capture,self.binding)

    def test_actual_exclusive_copy_full_readback_collision_and_tamper_are_source_only(self):
        case=self.case();self.assertEqual(case['scope'],'ISOLATED_BOOTSTRAP_SOURCE_DATA_ONLY')
        inputs=json.loads(case['input_json']);output=json.loads(case['output_json'])
        self.assertEqual(base64.b64decode(inputs['payload_base64']),self.payload)
        self.assertEqual(base64.b64decode(output['original_base64']),self.payload)
        self.assertEqual(output['publication']['scope'],'FIXTURE_AUTHORITY_ONLY')
        self.assertEqual(output['original_mode'],0o400);self.assertTrue(output['collision_unchanged'])
        self.assertEqual(output['tamper_reason'],'BOOTSTRAP_FIXTURE_BYTES_CHANGED')
        self.assertEqual(Path(output['publication']['path']).read_bytes(),self.payload[:-1]+b'#')
        self.assertEqual(len(base64.b64decode(output['tampered_base64'])),len(self.payload))
        result=self.compare(self.p,self.module,case)
        self.assertEqual(result['status'],'PASS');self.assertFalse(result['may_execute']);self.assertEqual(result['physical_origin'],'UNQUALIFIED')

    def test_wrong_original_body_or_unprotected_parent_refuses_before_copy(self):
        capture={**self.capture,'author':'foreign-author'}
        self.assertRaises(ValueError,self.produce,self.root,self.p,self.module,self.payload,self.manifest,capture,self.binding)
        self.assertEqual(list(self.root.iterdir()),[])
        self.root.chmod(0o777);self.assertRaises(ValueError,self.case);self.assertEqual(list(self.root.iterdir()),[])

    def test_rehashed_copy_mode_collision_raw_bytes_or_execution_claim_is_rejected(self):
        case=self.case()
        for key,value in [('original_mode',0o600),('collision_unchanged',False),('original_base64','eA=='),('tamper_reason','PASS')]:
            forged=copy.deepcopy(case);out=json.loads(forged['output_json']);out[key]=value
            forged['output_json']=encode_report(out).decode();forged['output_sha256']=hashlib.sha256(forged['output_json'].encode()).hexdigest()
            with self.subTest(key=key):self.assertRaises(ValueError,self.compare,self.p,self.module,forged)
        case['scope']='ISOLATED_ROOT_FIXTURES_ONLY';self.assertRaises(ValueError,self.compare,self.p,self.module,case)

    def test_source_case_does_not_complete_privileged_six_case_bundle(self):
        from rbridge_installation.qualification import QualificationProofs,build_qualification
        result=build_qualification(self.p,QualificationProofs(privileged=self.case()))
        self.assertEqual(result.status,'BLOCKED');self.assertEqual(result.checks['privileged'],'FAIL')

    def test_root_fixture_publication_refuses_source_context_before_any_open(self):
        from unittest.mock import patch
        publish=getattr(self.module,'_publish_root_fixture_bootstrap',None)
        self.assertIsNotNone(publish,'Root isolated publication path is absent')
        with patch.object(self.module.os,'open',side_effect=AssertionError('Source Root bootstrap open')):
            self.assertRaisesRegex(ValueError,'BOOTSTRAP_ROOT_FIXTURE_CONTEXT_UNQUALIFIED',publish,
                '/root/.rbridge-bootstrap-fixture-'+'a'*32,self.payload,self.manifest,self.capture,self.binding)

    def test_foreign_repository_cannot_pass_even_when_capture_and_every_digest_are_rehashed(self):
        case=self.case();inputs=json.loads(case['input_json']);output=json.loads(case['output_json'])
        inputs['binding']['repository']='foreign/bootstrap';inputs['capture']['repository']='foreign/bootstrap'
        inputs['capture']['url']='https://github.com/foreign/bootstrap/issues/17'
        proof=self.module.verify_bootstrap_artifact(self.payload,inputs['manifest'],inputs['capture'],inputs['binding'])
        output['proof']=proof;output['publication'].update({k:v for k,v in proof.items() if k!='scope'})
        case['input_json']=encode_report(inputs).decode();case['output_json']=encode_report(output).decode()
        case['input_sha256']=hashlib.sha256(case['input_json'].encode()).hexdigest();case['output_sha256']=hashlib.sha256(case['output_json'].encode()).hexdigest()
        self.assertRaisesRegex(ValueError,'BOOTSTRAP_FIXTURE_BINDING_CHANGED',self.compare,self.p,self.module,case)

    def test_wrong_profile_binding_or_manifest_pins_refuse_before_source_publication(self):
        for binding,manifest in [({**self.binding,'repository':'foreign/bootstrap'},self.manifest),
                                 (self.binding,{**self.manifest,'source_sha':'b'*40})]:
            self.assertRaises(ValueError,self.produce,self.root,self.p,self.module,self.payload,manifest,self.capture,binding)
            self.assertEqual(list(self.root.iterdir()),[])


if __name__=='__main__':unittest.main()
