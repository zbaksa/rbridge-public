"""Canonical retained orphan evidence is independently rehashable, never admission."""
import copy
import hashlib
import json
import unittest
from _loader import toolkit

class OrphanRootCustodyTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_root_custody import (
            build_root_custody_bundle,verify_root_custody_bytes,
            MAX_CUSTODY_BYTES)
        from rbridge_installation.orphan_root_disposition_store import _record
        from rbridge_installation.orphan_disposition_preimage import disposition_preimage
        from rbridge_installation.orphan_intent_review import (
            READONLY_EXE_SHA,READONLY_ARGV_SHA)
        from rbridge_installation.orphan_intent_review_packet import build_orphan_review_packet
        from rbridge_installation.models import encode_report,report_sha256
        self.make_record=_record
        self.build=build_root_custody_bundle
        self.verify=verify_root_custody_bytes
        self.encode=encode_report
        self.hash=report_sha256
        self.max_bytes=MAX_CUSTODY_BYTES
        name='helper-0b84e8af62a287a283eabcd4eef1cdb7'
        digest='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'
        self.observation={
            'schema':'RBRIDGE_ORPHAN_READONLY_INTENT_OBSERVATION_V1',
            'status':'INTENT_ONLY_UNRESOLVED',
            'scope':'ROOT_READONLY_DATA_OBSERVATION_ONLY',
            'name':name,'intent_sha256':digest,'boot_relation':'CURRENT',
            'executable_sha256':READONLY_EXE_SHA,'argv_sha256':READONLY_ARGV_SHA,
            'historical_execution':'UNKNOWN',
            'historical_operation_result':'UNKNOWN',
            'original_process_identity':'UNAVAILABLE',
            'missing':['running.json','settled.json'],
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
        self.claim={
            'schema':'RBRIDGE_ORPHAN_REVIEW_OWNER_CLAIM_V1',
            'scope':'UNAUTHENTICATED_CLAIM_ONLY',
            'decision':'ACKNOWLEDGED_UNKNOWN_WITHOUT_ADMISSION',
            'journal_name':name,'intent_sha256':digest,
            'observation_sha256':self.hash(self.observation),
            'owner_claim':'example-owner','issue_number':14813,
            'challenge':'b'*64,
            'acknowledgement':'HISTORICAL_EXECUTION_UNKNOWN_NO_RETRY_AUTHORIZATION'}
        packet=build_orphan_review_packet(self.observation,self.claim)
        self.tty={
            'schema':'RBRIDGE_ORPHAN_ROOT_TTY_REVIEW_DATA_V1',
            'status':'ATTENDED_DATA_ONLY',
            'review_packet_sha256':self.hash(packet),
            'challenge_sha256':'c'*64,
            'local_tty_present':True,
            'owner_authenticated':False,
            'original_process_outcome':'UNKNOWN',
            'root_disposition_written':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
        self.census={
            'schema':'RBRIDGE_ORPHAN_KERNEL_CENSUS_V1',
            'status':'NO_CURRENT_SYSTEMCTL_MATCH',
            'boot_id':'01234567-89ab-cdef-1234-567890abcdef',
            'samples':[{'sequence':1,'count':10,'live_systemctl':[],'unclassified':[]},
                       {'sequence':2,'count':11,'live_systemctl':[],'unclassified':[]}],
            'may_resume_qualification':False,
            'may_launch':False,'may_change_production':False}
        self.preimage=disposition_preimage(
            self.observation,self.claim,self.tty,self.census)
        self.record=_record(self.preimage,'toolkit-'+'1'*40,
                            (1,2,0o100600,0,0,1,789,456,123))

    def bundle(self):
        return self.build(self.record,self.observation,self.claim,
                          self.tty,self.census,self.preimage)

    def test_full_canonical_preimage_survives_readback(self):
        v=self.bundle()
        raw=self.encode(v)
        receipt=self.verify(raw)
        self.assertLessEqual(len(raw),self.max_bytes)
        for key,expected in (
            ('observation',self.observation),('owner_claim',self.claim),
            ('tty_review',self.tty),('kernel_census',self.census),
            ('preimage',self.preimage),('record',self.record)):
            self.assertEqual(v[key],expected)
        self.assertEqual(receipt['status'],'RETAINED_DATA_VERIFIED_ONLY')
        self.assertEqual(receipt['bundle_sha256'],hashlib.sha256(raw).hexdigest())
        self.assertEqual(receipt['record_sha256'],self.hash(self.record))
        self.assertEqual(v['record']['preimage_sha256'],self.hash(v['preimage']))
        for k in ('owner_authenticated','may_settle','may_launch',
                  'may_resume_qualification','may_change_production'):
            self.assertIs(v[k],False)
            self.assertIs(receipt[k],False)

    def test_64bit_nanosecond_timestamps_keep_exact_decimal_identity(self):
        original=(123,456,0o100600,0,0,1,789,
                  1791635488123456789,1791635488987654321)
        record=self.make_record(self.preimage,'toolkit-'+'1'*40,original)
        self.assertEqual(record['original_intent_identity'],
                         [str(x) for x in original])
        bundle=self.build(record,self.observation,self.claim,
                          self.tty,self.census,self.preimage)
        raw=self.encode(bundle)
        self.assertEqual(self.verify(raw)['status'],'RETAINED_DATA_VERIFIED_ONLY')
        self.assertEqual(self.encode(record).count(b'1791635488123456789'),1)

    def test_each_retained_input_is_detectably_tampered(self):
        for name,key,bad in (
            ('observation','historical_execution','SUCCESS'),
            ('owner_claim','challenge','d'*64),
            ('tty_review','challenge_sha256','d'*64),
            ('kernel_census','status','PROVEN'),
            ('preimage','observation_sha256','a'*64),
            ('record','preimage_sha256','a'*64)):
            with self.subTest(name=name):
                altered=copy.deepcopy(self.bundle())
                altered[name][key]=bad
                with self.assertRaises(ValueError):self.verify(self.encode(altered))

    def test_untrusted_authority_claims_are_rejected(self):
        for name,key,bad in (
            ('record','owner_authenticated',True),
            ('record','journal_settled',True),
            ('record','may_launch',True),
            ('preimage','may_change_production',True),
            ('tty_review','owner_authenticated',True),
            ('observation','may_resume_qualification',True),
            ('owner_claim','scope','OWNER_VERIFIED'),
            ('kernel_census','may_launch',True)):
            with self.subTest(field=(name,key)):
                v=copy.deepcopy(self.bundle());v[name][key]=bad
                with self.assertRaises(ValueError):self.verify(self.encode(v))

    def test_hash_only_legacy_record_cannot_count_as_complete_custody(self):
        with self.assertRaises(ValueError):
            self.verify(self.encode(self.record))
        thin=self.bundle();del thin['owner_claim']
        with self.assertRaises(ValueError):
            self.verify(self.encode(thin))

    def test_unexpected_fields_and_partial_evidence_rejected(self):
        for k,v in (('status','PASS'),('signature','owner-authenticated'),
                    ('may_launch',True)):
            altered=self.bundle();altered[k]=v
            with self.subTest(field=k),self.assertRaises(ValueError):
                self.verify(self.encode(altered))
        truncated=self.encode(self.bundle())[:-7]
        with self.assertRaises(ValueError):self.verify(truncated)

    def test_noncanonical_duplicate_and_invalid_json_rejected(self):
        raw=self.encode(self.bundle())
        for bad in (b' '+raw,raw+b'\n',
                    b'{"schema":1,"schema":2}',
                    b'{"unexpected":NaN}',b'\xff',
                    b'',None,"text",raw+b'{}'):
            with self.subTest(bad_type=str(type(bad))):
                with self.assertRaises(ValueError):self.verify(bad)

    def test_size_limit_and_bad_source_binding_rejected(self):
        raw=self.encode(self.bundle())
        with self.assertRaises(ValueError):
            self.verify(raw+b' '*(self.max_bytes+1))
        for key,value in (
            ('root_source_release','toolkit-unsafe'),
            ('original_intent_identity',[True]*9),
            ('intent_sha256','f'*64),
            ('historical_result','PASS')):
            altered=copy.deepcopy(self.bundle())
            altered['record'][key]=value
            with self.subTest(field=key),self.assertRaises(ValueError):
                self.verify(self.encode(altered))

    def test_custody_does_not_reclassify_kernel_summary_as_process_roster(self):
        v=self.bundle()
        self.assertEqual(v['kernel_census']['status'],'NO_CURRENT_SYSTEMCTL_MATCH')
        self.assertEqual(v['historical_execution'],'UNKNOWN')
        self.assertNotIn('authenticated_owner_signature',v)
        self.assertNotIn('historical_process_pid',v)
        self.assertNotIn('full_process_roster',v)
        self.assertNotIn('authorization_token',v)
        self.assertIs(self.verify(self.encode(v))['may_launch'],False)

if __name__=='__main__':
    unittest.main()
