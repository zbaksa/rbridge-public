"""Root-disposition preimage is DATA, not orphan admission authority."""
import copy
import unittest
from _loader import toolkit

class OrphanDispositionPreimageTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_disposition_preimage import (
            disposition_preimage,compare_disposition_preimage)
        from rbridge_installation.orphan_intent_review import (
            READONLY_EXE_SHA,READONLY_ARGV_SHA)
        from rbridge_installation.orphan_intent_review_packet import build_orphan_review_packet
        from rbridge_installation.models import report_sha256
        self.build=disposition_preimage
        self.compare=compare_disposition_preimage
        self.hash=report_sha256
        self.observation={
            'schema':'RBRIDGE_ORPHAN_READONLY_INTENT_OBSERVATION_V1',
            'status':'INTENT_ONLY_UNRESOLVED',
            'scope':'ROOT_READONLY_DATA_OBSERVATION_ONLY',
            'name':'helper-0b84e8af62a287a283eabcd4eef1cdb7',
            'intent_sha256':'844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276',
            'boot_relation':'CURRENT','executable_sha256':READONLY_EXE_SHA,
            'argv_sha256':READONLY_ARGV_SHA,'historical_execution':'UNKNOWN',
            'historical_operation_result':'UNKNOWN',
            'original_process_identity':'UNAVAILABLE',
            'missing':['running.json','settled.json'],
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
        self.claim={
            'schema':'RBRIDGE_ORPHAN_REVIEW_OWNER_CLAIM_V1',
            'scope':'UNAUTHENTICATED_CLAIM_ONLY',
            'decision':'ACKNOWLEDGED_UNKNOWN_WITHOUT_ADMISSION',
            'journal_name':self.observation['name'],
            'intent_sha256':self.observation['intent_sha256'],
            'observation_sha256':self.hash(self.observation),
            'owner_claim':'example-owner','issue_number':14813,
            'challenge':'b'*64,
            'acknowledgement':'HISTORICAL_EXECUTION_UNKNOWN_NO_RETRY_AUTHORIZATION'}
        packet=build_orphan_review_packet(self.observation,self.claim)
        self.tty={
            'schema':'RBRIDGE_ORPHAN_ROOT_TTY_REVIEW_DATA_V1',
            'status':'ATTENDED_DATA_ONLY',
            'review_packet_sha256':self.hash(packet),
            'challenge_sha256':'c'*64,'local_tty_present':True,
            'owner_authenticated':False,'original_process_outcome':'UNKNOWN',
            'root_disposition_written':False,'may_settle':False,
            'may_launch':False,'may_resume_qualification':False,
            'may_change_production':False}
        self.census={
            'schema':'RBRIDGE_ORPHAN_KERNEL_CENSUS_V1',
            'status':'NO_CURRENT_SYSTEMCTL_MATCH',
            'boot_id':'01234567-89ab-cdef-1234-567890abcdef',
            'samples':[{'sequence':1,'count':10,'live_systemctl':[],'unclassified':[]},
                       {'sequence':2,'count':11,'live_systemctl':[],'unclassified':[]}],
            'may_resume_qualification':False,'may_launch':False,
            'may_change_production':False}

    def create(self,obs=None,claim=None,tty=None,census=None):
        return self.build(obs if obs is not None else self.observation,
                          claim if claim is not None else self.claim,
                          tty if tty is not None else self.tty,
                          census if census is not None else self.census)

    def test_complete_data_still_cannot_authorize(self):
        packet=self.create()
        self.assertEqual(packet['status'],'INTENT_ONLY_UNRESOLVED_REVIEWED')
        self.assertEqual(packet['historical_execution'],'UNKNOWN')
        for k in ('owner_authenticated','root_provenance_verified','journal_settled',
                  'may_launch','may_resume_qualification','may_change_production'):
            self.assertIs(packet[k],False)
        result=self.compare(self.observation,self.claim,self.tty,self.census,packet)
        self.assertEqual(result['status'],'DATA_MATCH_ONLY')
        self.assertIs(result['may_launch'],False)

    def test_wrong_or_forged_observation_refused(self):
        for key,value in [('scope','FIXTURE_DATA_ONLY'),
                          ('name','helper-'+'e'*32),
                          ('intent_sha256','a'*64),
                          ('historical_execution','SUCCESS'),
                          ('may_launch',True)]:
            with self.subTest(key=key):
                obs=copy.deepcopy(self.observation);obs[key]=value
                with self.assertRaises(ValueError):self.create(obs=obs)

    def test_forged_tty_refused(self):
        for key,value in [('status','OWNER_APPROVED'),
                          ('owner_authenticated',True),
                          ('local_tty_present',False),
                          ('original_process_outcome','SUCCESS'),
                          ('may_resume_qualification',True),
                          ('review_packet_sha256','0'*64)]:
            with self.subTest(key=key):
                tty=copy.deepcopy(self.tty);tty[key]=value
                with self.assertRaises(ValueError):self.create(tty=tty)

    def test_census_requires_two_complete_no_match_scans(self):
        for key,value in [('status','INCOMPLETE'),('boot_id','bad'),
                          ('samples',[]),('may_launch',True)]:
            with self.subTest(key=key):
                scan=copy.deepcopy(self.census);scan[key]=value
                with self.assertRaises(ValueError):self.create(census=scan)
        for key,value in [('sequence',3),('count',True),('count',0),
                          ('live_systemctl',[{'pid':123}]),
                          ('unclassified',[{'pid':123}])]:
            with self.subTest(key=key):
                scan=copy.deepcopy(self.census);scan['samples'][1][key]=value
                with self.assertRaises(ValueError):self.create(census=scan)

    def test_claim_replay_or_packet_tampering_refused(self):
        claim=copy.deepcopy(self.claim);claim['challenge']='d'*64
        with self.assertRaises(ValueError):self.create(claim=claim)
        original=self.create()
        for key,value in [('status','SETTLED'),('may_launch',True),
                          ('journal_settled',True),('boot_id','0'*36)]:
            with self.subTest(key=key):
                altered=copy.deepcopy(original);altered[key]=value
                with self.assertRaises(ValueError):
                    self.compare(self.observation,self.claim,self.tty,self.census,altered)

    def test_no_process_provenance_is_not_historical_success(self):
        value=self.create()
        self.assertEqual(value['historical_result'],'UNKNOWN')
        self.assertEqual(value['scope'],'SERIALIZED_PREIMAGE_ONLY')
        self.assertNotIn('owner_signature',value)
        self.assertNotIn('journal_repaired',value)
        self.assertNotIn('production_authority',value)

if __name__=='__main__':
    unittest.main()
