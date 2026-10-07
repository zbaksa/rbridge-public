"""Exact preparation command review is Source data until genuine Root collection."""
import base64
import copy
import hashlib
import json
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


class OwnerCommandDataTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import owner_command_collector as c
        except ImportError:self.fail('Exact owner preparation command review is absent')
        self.c=c;self.p=parse_profile(valid_profile());self.raw=b'SOURCE_BYTES_ONLY_NO_EXECUTION\n'
        self.pins={'profile_sha256':report_sha256(self.p),'bundle_pin':'a'*64,'material_evidence_sha256':'b'*64,
            'publication_evidence_sha256':'c'*64,'runtime_manifest_sha256':self.p.runtime.manifest_sha256,
            'toolkit_manifest_sha256':self.p.toolkit.manifest_sha256,'readers_sha256':'d'*64,'helper_sha256':'e'*64,
            'python_closure_sha256':'f'*64,'payload_sha256':'1'*64,'command_sha256':hashlib.sha256(self.raw).hexdigest(),
            'custody_locator_sha256':'2'*64}
        self.receipt={'schema':'RBRIDGE_OWNER_PREPARATION_COMMAND_REVIEW_V1','decision':'APPROVED_P2A_PREPARATION_COMMAND',
            'scope':'REVIEWED_PREPARATION_COMMAND_ONLY','pins':self.pins,'command_base64':base64.b64encode(self.raw).decode(),
            'switch_authorized':False}
        self.capture={'schema':'RBRIDGE_OWNER_COMMAND_REVIEW_CAPTURE_V1','repository':self.p.binding.repository,
            'viewer':self.p.binding.author,'author':self.p.binding.author,'issue_number':17,'is_pull_request':False,
            'url':'https://github.com/'+self.p.binding.repository+'/issues/17','body':json.dumps(self.receipt)}

    def compare(self,capture=None,pins=None):
        return self.c.compare_owner_command_review(self.p,self.raw,self.pins if pins is None else pins,
            self.capture if capture is None else capture)

    def test_exact_reviewed_bytes_are_data_not_a_command_origin_or_switch(self):
        result=self.compare();self.assertEqual(result['status'],'PASS')
        self.assertEqual(result['scope'],'OWNER_COMMAND_REVIEW_DATA_ONLY');self.assertEqual(result['physical_origin'],'UNQUALIFIED')
        self.assertFalse(result['may_execute']);self.assertFalse(result['service_action_authorized'])

    def test_author_viewer_repository_pr_and_issue_url_are_authenticated_separately(self):
        for field,value in (('author','caller'),('viewer','caller'),('repository','caller/repository'),
                ('is_pull_request',True),('issue_number',True),('url','https://caller.invalid/issues/17')):
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,{**self.capture,field:value})

    def test_changed_command_rehashed_pins_extra_fields_or_switch_claim_cannot_reuse_review(self):
        for receipt in ({**self.receipt,'command_base64':base64.b64encode(self.raw+b'changed').decode()},
                {**self.receipt,'pins':{**self.pins,'bundle_pin':'3'*64}},
                {**self.receipt,'switch_authorized':True},{**self.receipt,'extra':True},
                {**self.receipt,'scope':'OWNER_PRESENT_PRODUCTION_SWITCH'}):
            self.assertRaises(ValueError,self.compare,{**self.capture,'body':json.dumps(receipt)})
        self.assertRaises(ValueError,self.compare,pins={**self.pins,'command_sha256':'3'*64})

    def test_noncanonical_bytes_duplicate_json_and_unbounded_review_are_refused(self):
        for body in ('{"schema":"x","schema":"x"}',
                json.dumps({**self.receipt,'command_base64':self.receipt['command_base64']+'\n'}),
                'x'*65537,'null'):
            self.assertRaises(ValueError,self.compare,{**self.capture,'body':body})


class OwnerCommandRootTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import owner_command_collector as c
        except ImportError:self.fail('Exact owner preparation command review is absent')
        self.c=c;self.p=parse_profile(valid_profile())

    def test_source_collection_cannot_lookup_render_or_register_an_owner_command(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')):
            self.assertRaises(ValueError,self.c.collect_root_owner_command_review,self.p,None,None,{},17,{})

    def test_source_cannot_stage_an_executable_proposal_from_incomplete_material(self):
        stage=getattr(self.c,'stage_root_owner_command_review',None)
        self.assertIsNotNone(stage,'The owner must be able to inspect exact bytes before reviewing them')
        with patch('os.open',side_effect=AssertionError('Source proposal Root open')):
            self.assertRaises(ValueError,stage,self.p,None,None,{},{})

    def test_constructed_or_serialized_review_cannot_issue_a_command(self):
        token=self.c._RootOwnerCommandReviewObservation('a'*64,'b'*64,'c'*64,'{}','[]')
        for value in (token,{'status':'PASS','scope':'ROOT_REVIEWED_PREPARATION_COMMAND'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'OWNER_COMMAND_REVIEW_ORIGIN_UNQUALIFIED',
                    self.c.verify_root_owner_command_review,self.p,value,{})
        from rbridge_installation.qualification import qualified_owner_command
        self.assertRaises(ValueError,qualified_owner_command,{'status':'PASS','command':'sudo caller'})

    def test_original_bundle_and_publication_references_cannot_be_replaced_or_mutated(self):
        bundle={'source_data_only':True};publication={'source_data_only':True}
        token=self.c._RootOwnerCommandReviewObservation(report_sha256(self.p),'b'*64,report_sha256(publication),'{}','[]')
        self.c._observations[token]=(report_sha256(token),bundle,publication,self.p,'{}','{}','SOURCE_DATA_ONLY')
        try:
            with patch('os.open',side_effect=AssertionError('Changed review Root open')):
                self.assertRaisesRegex(ValueError,'OWNER_COMMAND_REVIEW_BUNDLE_ORIGIN_CHANGED',
                    self.c.verify_root_owner_command_review,self.p,token,{},bundle=copy.copy(bundle))
                self.assertRaisesRegex(ValueError,'OWNER_COMMAND_REVIEW_PUBLICATION_ORIGIN_CHANGED',
                    self.c.verify_root_owner_command_review,self.p,token,{},publication_observation=copy.copy(publication))
                object.__setattr__(token,'evidence_json','{"status":"PASS"}')
                self.assertRaisesRegex(ValueError,'OWNER_COMMAND_REVIEW_OBSERVATION_CHANGED',
                    self.c.verify_root_owner_command_review,self.p,token,{})
        finally:self.c._observations.pop(token,None)


if __name__=='__main__':unittest.main()
