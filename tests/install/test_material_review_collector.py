"""Exact owner material-review receipts are data until authenticated Root capture."""
import copy
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


def material_data():
    p=parse_profile(valid_profile())
    evidence={'profile':p,'base_profile':p,'runtime_manifest':{'sha256':p.runtime.manifest_sha256},
        'toolkit_manifest':{'sha256':p.toolkit.manifest_sha256},
        'observations':{'source_ci':{'source':{'commit':p.toolkit.source_sha,'tree':p.toolkit.tree_sha,
            'run_id':17,'log_sha256':'a'*64}},'bootstrap':{'manifest':{'payload_sha256':'b'*64,
                'python_closure_sha256':'c'*64}}},
        'source_ci_locator':{'run_id':17,'job_id':18},'readers_sha256':'d'*64,
        'reader_context_sha256':'e'*64,'helper_sha256':'f'*64,'canary_base64':'U09VUkNFX0RBVEFfT05MWQ==',
        'owner_review':'NOT_COLLECTED','installation_authority':False,'service_action_authorized':False}
    material={'schema':'RBRIDGE_ROOT_QUALIFICATION_MATERIAL_V1','scope':'ROOT_COMPLETE_QUALIFICATION_MATERIAL',
        'status':'PASS','profile_sha256':report_sha256(p),'base_profile_sha256':report_sha256(p),
        'evidence_sha256':report_sha256(evidence),'evidence':evidence,'installation_authority':False,
        'may_execute':False,'service_action_authorized':False}
    return p,material


class MaterialReviewDataTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation.material_review_collector import material_review_pins,compare_material_review
        except ImportError:self.fail('Exact complete material review comparison is absent')
        self.pins,self.compare=material_review_pins,compare_material_review;self.p,self.material=material_data()
        body={'schema':'RBRIDGE_OWNER_INSTALLATION_MATERIAL_REVIEW_V1','decision':'APPROVED_FOR_P2A_PREPARATION',
            'scope':'REVIEWED_QUALIFICATION_MATERIAL_ONLY','pins':self.pins(self.p,self.material),'switch_authorized':False}
        self.capture={'schema':'RBRIDGE_MATERIAL_REVIEW_CAPTURE_V1','repository':self.p.binding.repository,
            'viewer':self.p.binding.author,'author':self.p.binding.author,'issue_number':17,'is_pull_request':False,
            'url':'https://github.com/'+self.p.binding.repository+'/issues/17','body':encode_report(body).decode()}

    def test_exact_whole_material_receipt_is_only_data_and_never_switch_permission(self):
        value=self.compare(self.p,self.material,self.capture)
        self.assertEqual(value['scope'],'MATERIAL_REVIEW_DATA_ONLY');self.assertEqual(value['status'],'PASS')
        self.assertEqual(value['capture'],self.capture);self.assertEqual(value['receipt']['pins'],self.pins(self.p,self.material))
        self.assertFalse(value['may_execute']);self.assertFalse(value['service_action_authorized'])
        self.assertEqual(value['physical_origin'],'UNQUALIFIED')

    def test_wrong_authenticated_identity_url_number_or_pull_request_refuses(self):
        for field,value in [('viewer','foreign'),('author','foreign'),('repository','foreign/repo'),
                ('issue_number',True),('is_pull_request',True),('url','https://github.com/foreign/repo/issues/17')]:
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,self.p,self.material,{**self.capture,field:value})

    def test_each_reviewed_pin_and_owner_decision_must_match_even_after_full_rehash(self):
        import json
        for field in self.pins(self.p,self.material):
            capture=copy.deepcopy(self.capture);body=json.loads(capture['body'])
            body['pins'][field]=19 if type(body['pins'][field]) is int else '0'*len(body['pins'][field])
            capture['body']=encode_report(body).decode()
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,self.p,self.material,capture)
        for field,value in [('decision','SOURCE_CI_PASS'),('scope','SWITCH_AUTHORIZED'),('switch_authorized',True)]:
            capture=copy.deepcopy(self.capture);body=json.loads(capture['body']);body[field]=value;capture['body']=encode_report(body).decode()
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,self.p,self.material,capture)

    def test_changed_complete_material_preimage_cannot_reuse_prior_owner_review(self):
        material=copy.deepcopy(self.material);material['evidence']['canary_base64']='Y2hhbmdlZA=='
        material['evidence_sha256']=report_sha256(material['evidence'])
        self.assertRaises(ValueError,self.compare,self.p,material,self.capture)
        self.assertRaises(ValueError,self.pins,self.p,{**self.material,'evidence_sha256':'0'*64})


class MaterialReviewRootTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import material_review_collector as c
        except ImportError:self.fail('Protected authenticated material review collector is absent')
        self.c=c;self.p=parse_profile(valid_profile())

    def test_source_context_refuses_original_material_lookup_or_root_io(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch.object(self.c,'verify_root_qualification_material',side_effect=AssertionError('Source Root material')), \
             patch.object(self.c,'lookup_issues',side_effect=AssertionError('Source authenticated lookup')):
            self.assertRaisesRegex(ValueError,'MATERIAL_REVIEW_ROOT_CONTEXT_UNQUALIFIED',
                self.c.collect_root_material_review,self.p,None,None,None,17,{})

    def test_constructed_or_serialized_token_cannot_register_review_origin(self):
        token=self.c._RootMaterialReviewObservation('a'*64,'b'*64,'{}','{}')
        for value in (token,{'scope':'ROOT_AUTHENTICATED_OWNER_MATERIAL_REVIEW','status':'PASS'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'MATERIAL_REVIEW_ORIGIN_UNQUALIFIED',
                    self.c.verify_root_material_review,self.p,value,{})

    def test_equal_metadata_cannot_replace_original_material_object_before_io(self):
        from rbridge_installation.qualification_collector import _RootQualificationMaterialObservation
        original=_RootQualificationMaterialObservation(report_sha256(self.p),'a'*64,'b'*64,'{}','/root/.rbridge-privileged-'+'c'*32)
        substitute=copy.copy(original);token=self.c._RootMaterialReviewObservation(report_sha256(self.p),report_sha256(original),'{}','{}')
        self.c._observations[token]=(report_sha256(token),original,None,None,self.p,'{}')
        try:
            with patch('os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'MATERIAL_REVIEW_MATERIAL_ORIGIN_CHANGED',
                    self.c.verify_root_material_review,self.p,token,{},material_observation=substitute)
                self.assertRaisesRegex(ValueError,'MATERIAL_REVIEW_ROOT_CONTEXT_UNQUALIFIED',
                    self.c.verify_root_material_review,self.p,token,{},material_observation=original)
        finally:del self.c._observations[token]

    def test_mutated_private_source_token_or_request_refuses_before_io(self):
        token=self.c._RootMaterialReviewObservation(report_sha256(self.p),'b'*64,'{}','{}')
        self.c._observations[token]=(report_sha256(token),None,None,None,self.p,'{}')
        try:
            with patch('os.open',side_effect=AssertionError('Mutated Root open')):
                self.assertRaisesRegex(ValueError,'MATERIAL_REVIEW_OBSERVATION_CHANGED',self.c.verify_root_material_review,
                    self.p,token,{'python_closure_sha256':'c'*64})
                object.__setattr__(token,'evidence_json','{"status":"PASS"}')
                self.assertRaisesRegex(ValueError,'MATERIAL_REVIEW_OBSERVATION_CHANGED',self.c.verify_root_material_review,self.p,token,{})
        finally:del self.c._observations[token]


if __name__=='__main__':unittest.main()
