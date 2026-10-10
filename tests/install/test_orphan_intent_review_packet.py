"""An unresolved helper cannot be admitted by a forged review packet."""
import copy
import unittest
from _loader import toolkit

class OrphanReviewPacketTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_intent_review_packet import (
            build_orphan_review_packet,compare_orphan_review_packet)
        from rbridge_installation.orphan_intent_review import (
            READONLY_EXE_SHA,READONLY_ARGV_SHA)
        from rbridge_installation.models import report_sha256
        self.build=build_orphan_review_packet
        self.compare=compare_orphan_review_packet
        self.sha=report_sha256
        self.observation={
            'schema':'RBRIDGE_ORPHAN_READONLY_INTENT_OBSERVATION_V1',
            'status':'INTENT_ONLY_UNRESOLVED',
            'scope':'FIXTURE_DATA_ONLY',
            'name':'helper-'+'a'*32,
            'intent_sha256':'b'*64,
            'boot_relation':'CURRENT',
            'executable_sha256':READONLY_EXE_SHA,
            'argv_sha256':READONLY_ARGV_SHA,
            'historical_execution':'UNKNOWN',
            'historical_operation_result':'UNKNOWN',
            'original_process_identity':'UNAVAILABLE',
            'missing':['running.json','settled.json'],
            'may_settle':False,
            'may_launch':False,
            'may_resume_qualification':False,
            'may_change_production':False}
        self.claim={
            'schema':'RBRIDGE_ORPHAN_REVIEW_OWNER_CLAIM_V1',
            'scope':'UNAUTHENTICATED_CLAIM_ONLY',
            'decision':'ACKNOWLEDGED_UNKNOWN_WITHOUT_ADMISSION',
            'journal_name':self.observation['name'],
            'intent_sha256':self.observation['intent_sha256'],
            'observation_sha256':self.sha(self.observation),
            'owner_claim':'example-owner',
            'issue_number':14771,
            'challenge':'c'*64,
            'acknowledgement':'HISTORICAL_EXECUTION_UNKNOWN_NO_RETRY_AUTHORIZATION'}

    def test_exact_claim_is_only_unverified_data(self):
        obs=copy.deepcopy(self.observation);claim=copy.deepcopy(self.claim)
        packet=self.build(obs,claim)
        self.assertEqual(packet['status'],'UNVERIFIED_OWNER_CLAIM_UNRESOLVED')
        self.assertEqual(packet['historical_execution'],'UNKNOWN')
        self.assertEqual(packet['historical_operation_result'],'UNKNOWN')
        for key in ('owner_authenticated','journal_settled','may_launch',
                    'may_resume_qualification','may_change_production'):
            self.assertIs(packet[key],False)
        result=self.compare(obs,claim,packet)
        self.assertEqual(result['status'],'DATA_MATCH_ONLY')
        self.assertIs(result['may_resume_qualification'],False)
        self.assertEqual(obs,self.observation)
        self.assertEqual(claim,self.claim)

    def test_forged_observation_authority_is_refused(self):
        for key,bad in (
            ('status','PASS'),('scope','PRODUCTION_ORIGIN'),
            ('boot_relation','OTHER'),('historical_execution','SUCCESS'),
            ('historical_operation_result','PASS'),
            ('original_process_identity','123'),
            ('missing',[]),('may_settle',True),
            ('may_launch',True),('may_resume_qualification',True),
            ('may_change_production',True),
            ('executable_sha256','0'*64),('argv_sha256','0'*64)):
            with self.subTest(key=key):
                obs=copy.deepcopy(self.observation);obs[key]=bad
                with self.assertRaises(ValueError):self.build(obs,self.claim)

    def test_wrong_claim_and_fake_owner_fields_are_refused(self):
        for key,bad in (
            ('schema','AUTHORIZED'),('scope','ROOT_AUTHENTICATED'),
            ('decision','APPROVED_FOR_ADMISSION'),
            ('journal_name','helper-'+'e'*32),
            ('intent_sha256','f'*64),
            ('observation_sha256','e'*64),
            ('owner_claim','a/b'),('issue_number',True),
            ('issue_number',0),('challenge','0'*64),
            ('acknowledgement','OWNER_APPROVED_RESTART')):
            with self.subTest(key=key):
                claim=copy.deepcopy(self.claim);claim[key]=bad
                with self.assertRaises(ValueError):
                    self.build(self.observation,claim)

    def test_unknown_or_extra_fields_refused(self):
        obs=copy.deepcopy(self.observation);obs['authority']='PASS'
        with self.assertRaises(ValueError):self.build(obs,self.claim)
        claim=copy.deepcopy(self.claim);claim['signature_verified']=True
        with self.assertRaises(ValueError):self.build(self.observation,claim)

    def test_claim_nonce_binding_does_not_authenticate(self):
        first=self.build(self.observation,self.claim)
        changed=copy.deepcopy(self.claim);changed['challenge']='d'*64
        second=self.build(self.observation,changed)
        self.assertNotEqual(first['claim_sha256'],second['claim_sha256'])
        with self.assertRaises(ValueError):
            self.compare(self.observation,changed,first)
        self.assertIs(second['owner_authenticated'],False)

    def test_packet_tampering_refused(self):
        packet=self.build(self.observation,self.claim)
        for key,bad in (('may_launch',True),('journal_settled',True),
                        ('owner_authenticated',True),
                        ('historical_execution','SUCCESS'),
                        ('status','QUALIFIED'),('claim_sha256','0'*64)):
            with self.subTest(key=key):
                corrupt=copy.deepcopy(packet);corrupt[key]=bad
                with self.assertRaises(ValueError):
                    self.compare(self.observation,self.claim,corrupt)

    def test_receipt_cannot_bind_modified_observation(self):
        obs=copy.deepcopy(self.observation);obs['intent_sha256']='d'*64
        with self.assertRaises(ValueError):self.build(obs,self.claim)

    def test_not_an_owner_receipt_or_root_capability(self):
        value=self.build(self.observation,self.claim)
        self.assertEqual(value['scope'],'PURE_SERIALIZED_DATA_ONLY')
        self.assertNotIn('signature',value)
        self.assertNotIn('authorization',value)
        self.assertNotIn('root_origin',value)

if __name__=='__main__':
    unittest.main()
