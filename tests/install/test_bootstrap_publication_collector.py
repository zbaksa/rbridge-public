"""Authenticated production-copy Source predicates, never Root authority."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from _loader import toolkit,ROOT
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


class BootstrapPublicationDataTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import bootstrap_publication_collector as c
        except ImportError:self.fail('Authenticated production-copy collector is absent')
        self.c=c;self.p=parse_profile(valid_profile())
        spec=importlib.util.spec_from_file_location('publication_source_bytes',ROOT/'ops/install/rbridge_bootstrap.py')
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        payload=(ROOT/'ops/install/rbridge_bootstrap.py').read_bytes()
        manifest={'schema':'RBRIDGE_BOOTSTRAP_MANIFEST_V1','source_sha':self.p.toolkit.source_sha,
            'tree_sha':self.p.toolkit.tree_sha,'payload_bytes':len(payload),
            'payload_sha256':hashlib.sha256(payload).hexdigest(),'toolkit_manifest_sha256':self.p.toolkit.manifest_sha256,
            'python_closure_sha256':'a'*64}
        capture={'schema':'RBRIDGE_BOOTSTRAP_ARTIFACT_CAPTURE_V1','repository':self.p.binding.repository,
            'viewer':self.p.binding.author,'author':self.p.binding.author,'issue_number':17,'is_pull_request':False,
            'url':'https://github.com/'+self.p.binding.repository+'/issues/17',
            'body':json.dumps({'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1','manifest':manifest,
                'payload_base64':base64.b64encode(payload).decode()})}
        bootstrap={'schema':'RBRIDGE_ROOT_BOOTSTRAP_OBSERVATION_V1','scope':'ROOT_AUTHENTICATED_BOOTSTRAP_BYTES',
            'status':'PASS','manifest':manifest,'evidence':{'capture':capture},'queries':[],
            'payload_base64':base64.b64encode(payload).decode(),'may_execute':False,'service_action_authorized':False}
        binding={'repository':self.p.binding.repository,'author':self.p.binding.author,'issue_number':17}
        proof=self.module.verify_bootstrap_artifact(payload,manifest,capture,binding)
        publication={**proof,'scope':'ROOT_PROTECTED_BYTES_ONLY',
            'path':'/var/lib/rbridge-maintenance/bootstrap-'+manifest['payload_sha256']+'/payload.py',
            'identity':['1','2','33024','0','0','1',str(len(payload)),'3','4']}
        self.value={'schema':'RBRIDGE_ROOT_BOOTSTRAP_PUBLICATION_EVIDENCE_V1',
            'scope':'ROOT_AUTHENTICATED_PUBLICATION_DATA_ONLY','profile_sha256':report_sha256(self.p),
            'bundle_pin':'b'*64,'bootstrap':bootstrap,'publication':publication,
            'qualification_request':{'python_closure_sha256':'a'*64}}

    def compare(self,value=None):
        return self.c.compare_bootstrap_publication(self.p,self.module,self.value if value is None else value)

    def test_complete_source_preimages_are_data_only(self):
        result=self.compare();self.assertEqual(result['status'],'PASS')
        self.assertEqual(result['scope'],'BOOTSTRAP_PUBLICATION_DATA_ONLY')
        self.assertEqual(result['physical_origin'],'UNQUALIFIED')
        self.assertFalse(result['may_execute']);self.assertFalse(result['service_action_authorized'])

    def test_rehashed_author_repository_pull_request_or_profile_cannot_pass(self):
        for field,value in (('author','caller'),('viewer','caller'),('repository','caller/repository'),('is_pull_request',True)):
            changed=copy.deepcopy(self.value);changed['bootstrap']['evidence']['capture'][field]=value
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,changed)
        changed=copy.deepcopy(self.value);changed['profile_sha256']='c'*64
        self.assertRaises(ValueError,self.compare,changed)

    def test_publication_path_identity_payload_and_execution_claims_are_exact(self):
        for field,value in (('path','/tmp/caller/payload.py'),('identity',['1']*9),
                ('payload_sha256','c'*64),('scope','EXECUTION_AUTHORIZED'),('may_execute',True),('extra',True)):
            changed=copy.deepcopy(self.value);changed['publication'][field]=value
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,changed)

    def test_request_and_manifest_are_bound_to_reviewed_toolkit_not_source_labels(self):
        for field,value in (('source_sha','c'*40),('tree_sha','c'*40),
                ('toolkit_manifest_sha256','c'*64),('python_closure_sha256','c'*64)):
            changed=copy.deepcopy(self.value);changed['bootstrap']['manifest'][field]=value
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,changed)
        changed=copy.deepcopy(self.value);changed['qualification_request']['extra']=True
        self.assertRaises(ValueError,self.compare,changed)

    def test_malformed_nested_manifest_or_capture_has_a_stable_refusal(self):
        for field,value in (('manifest',None),('manifest',{}),('evidence',None),('evidence',{}),
                ('evidence',{'capture':None}),('evidence',{'capture':{}})):
            changed=copy.deepcopy(self.value);changed['bootstrap'][field]=value
            with self.subTest(field=field,value=value):self.assertRaises(ValueError,self.compare,changed)


class BootstrapPublicationRootTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import bootstrap_publication_collector as c
        except ImportError:self.fail('Authenticated production-copy collector is absent')
        self.c=c;self.p=parse_profile(valid_profile())

    def test_source_collection_refuses_before_authentication_copy_or_root_io(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')):
            self.assertRaises(ValueError,self.c.collect_root_bootstrap_publication,self.p,None,{})

    def test_constructed_or_serialized_publication_cannot_register_origin(self):
        token=self.c._RootBootstrapPublicationObservation('a'*64,'b'*64,'c'*64,'{}','/root/.rbridge-privileged-'+'d'*32)
        for value in (token,{'status':'PASS','scope':'ROOT_AUTHENTICATED_PROTECTED_BOOTSTRAP_PUBLICATION'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_PUBLICATION_ORIGIN_UNQUALIFIED',
                    self.c.verify_root_bootstrap_publication,self.p,value,{})

    def test_replaced_original_bundle_or_mutated_token_refuses_before_root_io(self):
        original=SimpleNamespace(source_data_only=True);bootstrap={'source_data_only':True}
        token=self.c._RootBootstrapPublicationObservation(report_sha256(self.p),'b'*64,report_sha256(bootstrap),
            '{}','/root/.rbridge-privileged-'+'d'*32)
        self.c._observations[token]=(report_sha256(token),original,bootstrap,self.p,'{}')
        try:
            with patch('os.open',side_effect=AssertionError('Changed origin Root open')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_PUBLICATION_BUNDLE_ORIGIN_CHANGED',
                    self.c.verify_root_bootstrap_publication,self.p,token,{},bundle=copy.copy(original))
                object.__setattr__(token,'evidence_json','{"status":"PASS"}')
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_PUBLICATION_OBSERVATION_CHANGED',
                    self.c.verify_root_bootstrap_publication,self.p,token,{})
        finally:self.c._observations.pop(token,None)


if __name__=='__main__':unittest.main()
