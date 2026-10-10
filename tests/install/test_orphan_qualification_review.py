"""An orphan disposition and owner claim cannot mint helper admission."""
import copy
import unittest
from _loader import toolkit

class OrphanQualificationReviewTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_qualification_review import (
            review_orphan_qualification_request,
            compare_orphan_qualification_request)
        from rbridge_installation.models import report_sha256
        self.review=review_orphan_qualification_request
        self.compare=compare_orphan_qualification_request
        self.digest=report_sha256
        self.name='helper-0b84e8af62a287a283eabcd4eef1cdb7'
        self.intent='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'
        self.source='e9ffb8411c8ac3c9a0807b71863f0cbad6d918a1'
        self.record={
            'schema':'RBRIDGE_ROOT_ORPHAN_INTENT_EVIDENCE_V1',
            'status':'ROOT_RECORD_ONLY_INTENT_UNRESOLVED',
            'scope':'PROTECTED_APPEND_ONLY_DATA_NOT_AUTHORIZATION',
            'journal_name':self.name,
            'intent_sha256':self.intent,'preimage_sha256':'a'*64,
            'root_source_release':'toolkit-'+self.source,
            'original_intent_identity':list(range(1,10)),
            'historical_execution':'UNKNOWN','historical_result':'UNKNOWN',
            'owner_authenticated':False,'journal_settled':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
        self.request={
            'schema':'RBRIDGE_ORPHAN_QUALIFICATION_REVIEW_REQUEST_V1',
            'scope':'UNAUTHENTICATED_REQUEST_DATA_ONLY',
            'action':'PREPARE_SINGLE_P2A_ROOT_QUALIFICATION',
            'journal_name':self.name,'intent_sha256':self.intent,
            'disposition_sha256':self.digest(self.record),
            'root_source_sha':self.source,
            'proposed_driver_sha256':'c'*64,'nonce':'d'*32,
            'service_actions':[],'production_switch_authorized':False}

    def test_even_perfect_serialized_evidence_remains_blocked(self):
        value=self.review(self.record,self.request)
        self.assertEqual(value['status'],'ADMISSION_BLOCKED_PENDING_LIVE_ROOT_ORIGIN')
        self.assertEqual(len(value['requirements_missing']),4)
        self.assertEqual(value['original_process_result'],'UNKNOWN')
        for field in ('may_settle','may_launch','may_resume_qualification',
                      'may_change_production'):
            self.assertIs(value[field],False)
        result=self.compare(self.record,self.request,value)
        self.assertEqual(result['status'],'DATA_MATCH_BLOCKED')

    def test_authentication_and_settlement_forgery_rejected(self):
        for k,v in (
            ('owner_authenticated',True),('journal_settled',True),
            ('may_settle',True),('may_launch',True),
            ('may_resume_qualification',True),
            ('may_change_production',True),
            ('historical_execution','SUCCESS'),
            ('status','SETTLED')):
            with self.subTest(field=k):
                changed=copy.deepcopy(self.record);changed[k]=v
                with self.assertRaises(ValueError):
                    self.review(changed,self.request)

    def test_other_orphan_and_original_intent_digest_refused(self):
        for k,v in (
            ('journal_name','helper-'+'e'*32),('intent_sha256','f'*64),
            ('preimage_sha256','bad'),
            ('root_source_release','toolkit-'+'0'*40),
            ('original_intent_identity',[]),
            ('original_intent_identity',[True]*9)):
            with self.subTest(field=k):
                record=copy.deepcopy(self.record);record[k]=v
                with self.assertRaises(ValueError):
                    self.review(record,self.request)

    def test_request_cannot_ask_for_service_switch_or_restart(self):
        for k,v in (
            ('action','P2A_PRODUCTION_SWITCH'),
            ('scope','OWNER_AUTHENTICATED'),
            ('service_actions',['restart rbridge.service']),
            ('production_switch_authorized',True),
            ('root_source_sha','f'*40),
            ('proposed_driver_sha256','wrong'),
            ('nonce','0'*32)):
            with self.subTest(field=k):
                request=copy.deepcopy(self.request);request[k]=v
                with self.assertRaises(ValueError):
                    self.review(self.record,request)

    def test_request_replay_or_wrong_disposition_refused(self):
        request=copy.deepcopy(self.request)
        request['disposition_sha256']='e'*64
        with self.assertRaises(ValueError):
            self.review(self.record,request)
        other=copy.deepcopy(self.record);other['preimage_sha256']='b'*64
        with self.assertRaises(ValueError):
            self.review(other,self.request)

    def test_obsolete_stage2d_source_pins_are_rejected(self):
        legacy='2de2e17cf0cec83940ddfb04ee20e29f3c26262a'
        old_record=copy.deepcopy(self.record)
        old_record['root_source_release']='toolkit-'+legacy
        with self.assertRaisesRegex(ValueError,'ORPHAN_ADMISSION_RECORD_UNQUALIFIED'):
            self.review(old_record,self.request)
        old_request=copy.deepcopy(self.request)
        old_request['root_source_sha']=legacy
        with self.assertRaisesRegex(ValueError,'ORPHAN_ADMISSION_REQUEST_UNQUALIFIED'):
            self.review(self.record,old_request)

    def test_modified_comparison_cannot_grant_authority(self):
        value=self.review(self.record,self.request)
        for k,v in (
            ('status','PASS'),('may_launch',True),
            ('may_resume_qualification',True),
            ('requirements_missing',[])):
            with self.subTest(field=k):
                changed=copy.deepcopy(value);changed[k]=v
                with self.assertRaises(ValueError):
                    self.compare(self.record,self.request,changed)

if __name__=='__main__':
    unittest.main()
