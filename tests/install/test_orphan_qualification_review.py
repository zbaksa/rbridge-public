"""A complete custody record cannot generate Root helper admission."""
import copy
import hashlib
import json
import unittest
from _loader import toolkit

class OrphanCustodyQualificationReviewTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_root_custody import build_root_custody_bundle
        from rbridge_installation.orphan_root_disposition_store import _record
        from rbridge_installation.orphan_disposition_preimage import disposition_preimage
        from rbridge_installation.orphan_intent_review import READONLY_EXE_SHA,READONLY_ARGV_SHA
        from rbridge_installation.orphan_intent_review_packet import build_orphan_review_packet
        from rbridge_installation.orphan_qualification_review import (
            review_custody_qualification_request,
            compare_custody_qualification_request)
        from rbridge_installation.models import report_sha256,encode_report
        self.review=review_custody_qualification_request
        self.compare=compare_custody_qualification_request
        self.encode=encode_report
        name='helper-0b84e8af62a287a283eabcd4eef1cdb7'
        intent='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'
        self.source='9c474517e492044c463cd0a4de5abd47fb983fdd'
        observation={
            'schema':'RBRIDGE_ORPHAN_READONLY_INTENT_OBSERVATION_V1',
            'status':'INTENT_ONLY_UNRESOLVED',
            'scope':'ROOT_READONLY_DATA_OBSERVATION_ONLY',
            'name':name,'intent_sha256':intent,'boot_relation':'CURRENT',
            'executable_sha256':READONLY_EXE_SHA,'argv_sha256':READONLY_ARGV_SHA,
            'historical_execution':'UNKNOWN',
            'historical_operation_result':'UNKNOWN',
            'original_process_identity':'UNAVAILABLE',
            'missing':['running.json','settled.json'],
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
        claim={
            'schema':'RBRIDGE_ORPHAN_REVIEW_OWNER_CLAIM_V1',
            'scope':'UNAUTHENTICATED_CLAIM_ONLY',
            'decision':'ACKNOWLEDGED_UNKNOWN_WITHOUT_ADMISSION',
            'journal_name':name,'intent_sha256':intent,
            'observation_sha256':report_sha256(observation),
            'owner_claim':'example-owner','issue_number':14813,
            'challenge':'b'*64,
            'acknowledgement':'HISTORICAL_EXECUTION_UNKNOWN_NO_RETRY_AUTHORIZATION'}
        packet=build_orphan_review_packet(observation,claim)
        tty={
            'schema':'RBRIDGE_ORPHAN_ROOT_TTY_REVIEW_DATA_V1',
            'status':'ATTENDED_DATA_ONLY',
            'review_packet_sha256':report_sha256(packet),
            'challenge_sha256':'c'*64,
            'local_tty_present':True,'owner_authenticated':False,
            'original_process_outcome':'UNKNOWN','root_disposition_written':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
        census={
            'schema':'RBRIDGE_ORPHAN_KERNEL_CENSUS_V1',
            'status':'NO_CURRENT_SYSTEMCTL_MATCH',
            'boot_id':'01234567-89ab-cdef-1234-567890abcdef',
            'samples':[{'sequence':1,'count':10,'live_systemctl':[],'unclassified':[]},
                       {'sequence':2,'count':11,'live_systemctl':[],'unclassified':[]}],
            'may_resume_qualification':False,'may_launch':False,
            'may_change_production':False}
        preimage=disposition_preimage(observation,claim,tty,census)
        record=_record(preimage,'toolkit-'+self.source,
                       (1,2,0o100600,0,0,1,789,
                        1791635488123456789,1791635488987654321))
        self.bundle=build_root_custody_bundle(record,observation,claim,
                                               tty,census,preimage)
        self.raw=encode_report(self.bundle)
        self.request={
            'schema':'RBRIDGE_ORPHAN_CUSTODY_QUALIFICATION_REQUEST_V2',
            'scope':'UNAUTHENTICATED_REQUEST_DATA_ONLY',
            'action':'PREPARE_SINGLE_P2A_ROOT_QUALIFICATION',
            'journal_name':name,'intent_sha256':intent,
            'custody_bundle_sha256':hashlib.sha256(self.raw).hexdigest(),
            'root_source_sha':self.source,
            'proposed_driver_sha256':'c'*64,'nonce':'d'*32,
            'service_actions':[],'production_switch_authorized':False}

    def test_complete_custody_still_returns_blocked_only(self):
        review=self.review(self.raw,self.request)
        self.assertEqual(review['status'],'ADMISSION_BLOCKED_PENDING_LIVE_ROOT_ORIGIN')
        self.assertEqual(len(review['requirements_missing']),5)
        self.assertEqual(review['historical_execution'],'UNKNOWN')
        for key in ('owner_authenticated','may_settle','may_launch',
                    'may_resume_qualification','may_change_production'):
            self.assertIs(review[key],False)
        self.assertEqual(self.compare(self.raw,self.request,review)['status'],
                         'DATA_MATCH_BLOCKED')

    def test_hash_only_old_record_not_accepted_as_custody(self):
        with self.assertRaises(ValueError):
            self.review(self.encode(self.bundle['record']),self.request)
        with self.assertRaises(ValueError):
            self.review(self.bundle,self.request)

    def test_wrong_source_or_old_release_is_refused(self):
        for key,val in (
            ('root_source_release','toolkit-'+'e9ffb8411c8ac3c9a0807b71863f0cbad6d918a1'),
            ('root_source_release','toolkit-'+'0'*40)):
            with self.subTest(key=key,val=val):
                v=copy.deepcopy(self.bundle);v['record'][key]=val
                raw=self.encode(v)
                request={**self.request,
                         'custody_bundle_sha256':hashlib.sha256(raw).hexdigest()}
                with self.assertRaises(ValueError):self.review(raw,request)
        req={**self.request,'root_source_sha':'e9ffb8411c8ac3c9a0807b71863f0cbad6d918a1'}
        with self.assertRaises(ValueError):self.review(self.raw,req)

    def test_changed_or_unavailable_source_evidence_is_refused(self):
        for name,key,val in (
            ('observation','historical_execution','PASS'),
            ('owner_claim','challenge','a'*64),
            ('tty_review','owner_authenticated',True),
            ('kernel_census','status','SUCCESS'),
            ('preimage','census_sha256','f'*64),
            ('record','preimage_sha256','f'*64)):
            with self.subTest(name=name):
                v=copy.deepcopy(self.bundle);v[name][key]=val
                raw=self.encode(v)
                req={**self.request,'custody_bundle_sha256':hashlib.sha256(raw).hexdigest()}
                with self.assertRaises(ValueError):self.review(raw,req)

    def test_service_action_and_forged_owner_authority_refused(self):
        for field,value in (
            ('action','PRODUCTION_SWITCH'),
            ('scope','OWNER_AUTHENTICATED'),
            ('service_actions',['restart rbridge.service']),
            ('service_actions',()),
            ('production_switch_authorized',True),
            ('nonce','0'*32),
            ('proposed_driver_sha256','invalid'),
            ('journal_name','helper-'+'e'*32),
            ('root_source_sha','f'*40)):
            with self.subTest(field=field):
                req=copy.deepcopy(self.request);req[field]=value
                with self.assertRaises(ValueError):self.review(self.raw,req)

    def test_custody_digest_and_replayed_claim_refused(self):
        wrong={**self.request,'custody_bundle_sha256':'f'*64}
        with self.assertRaises(ValueError):self.review(self.raw,wrong)
        changed={**self.request,'nonce':'e'*32}
        old=self.review(self.raw,self.request)
        with self.assertRaises(ValueError):self.compare(self.raw,changed,old)
        self.assertEqual(self.review(self.raw,changed)['may_launch'],False)

    def test_forged_comparison_never_authorizes(self):
        good=self.review(self.raw,self.request)
        for key,val in (
            ('status','PASS'),('may_launch',True),
            ('owner_authenticated',True),
            ('may_resume_qualification',True),
            ('requirements_missing',[])):
            with self.subTest(key=key):
                changed=copy.deepcopy(good);changed[key]=val
                with self.assertRaises(ValueError):
                    self.compare(self.raw,self.request,changed)

if __name__=='__main__':
    unittest.main()
