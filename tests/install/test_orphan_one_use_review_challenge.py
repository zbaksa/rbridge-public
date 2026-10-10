"""One-use review challenge refuses stale, replayed and forged DATA."""
import copy
import hashlib
import pickle
import unittest
from unittest.mock import patch
from _loader import toolkit

class OneUseReviewChallengeDataTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation import orphan_one_use_review_challenge as module
        from rbridge_installation.models import encode_report
        self.module=module
        self.encode=encode_report
        self.source='44b49b2047330b8b53785fb6cf100848104137f6'
        self.tree='5dd90322784c8e766f1ce849debf45730af989a6'
        self.mfile='9d994bfc8d135f1edf55836e81090ad78c9baa7f17e985aaeccf3d70d27c2e1d'
        self.mlogical='04b2516c187864d85e0a42ffbd899047979c02692d28ce2fce38778be9199c44'
        self.pid=13579
        self.ticks='98765432'
        self.boot='01234567-89ab-cdef-1234-567890abcdef'
        self.issued=1791640800
        with patch.object(module.secrets,'token_bytes',return_value=b'\x11'*32), \
             patch.object(module.time,'monotonic',return_value=1000.0), \
             patch.object(module.time,'time',return_value=float(self.issued)):
            self.challenge=module.SingleUseReviewChallengeData(
                self.source,self.tree,self.mfile,self.mlogical,
                self.pid,self.ticks,self.boot)
        self.issued_data=self.challenge.issue_data()
        self.signed={
            'schema':'RBRIDGE_OWNER_SIGNED_RELEASE_REVIEW_V1',
            'scope':'UNVERIFIED_SIGNER_DATA_ONLY',
            'purpose':'REVIEW_EXACT_P2A_TOOLKIT_BYTES_ONLY',
            'host':'aether-engine',
            'journal_name':'helper-0b84e8af62a287a283eabcd4eef1cdb7',
            'intent_sha256':'844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276',
            'source_sha':self.source,'tree_sha':self.tree,
            'manifest_file_sha256':self.mfile,
            'manifest_logical_sha256':self.mlogical,
            'owner_key_sha256':'a'*64,
            'challenge_sha256':self.issued_data['challenge_sha256'],
            'boot_id':self.boot,'issued_unix_s':self.issued,
            'expires_unix_s':self.issued+120,
            'historical_execution':'UNKNOWN','service_actions':[],
            'production_switch_authorized':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
        self.raw=self.encode(self.signed)
        self.crypto={'status':'SIGNATURE_VALID_ONLY_UNTRUSTED_KEY',
                     'approval_sha256':hashlib.sha256(self.raw).hexdigest(),
                     'signer_key_authenticated':False,
                     'owner_authenticated':False,
                     'source_provenance_verified':False,
                     'may_settle':False,'may_launch':False,
                     'may_resume_qualification':False,
                     'may_change_production':False}
        self.kw={'observed_pid':self.pid,
                 'observed_start_ticks':self.ticks,
                 'observed_boot_id':self.boot,
                 'observed_monotonic':1010.0,
                 'observed_unix_s':self.issued+10}

    def consume(self,raw=None,kwargs=None,crypto=None):
        with patch.object(self.module,'verify_signed_release_review_data',
                          return_value=self.crypto if crypto is None else crypto):
            return self.challenge.consume_signed_review_data(
                self.raw if raw is None else raw,b'fixture',b'fixture',
                **(self.kw if kwargs is None else kwargs))

    def test_one_use_matching_signed_data_never_grants_authority(self):
        out=self.consume()
        self.assertEqual(out['status'],'ONE_USE_SIGNED_CHALLENGE_DATA_ONLY')
        self.assertIs(out['nonce_reuse_within_object_blocked'],True)
        self.assertEqual(out['signed_payload_sha256'],self.crypto['approval_sha256'])
        for k in ('owner_key_trust_verified','owner_authenticated',
                  'process_origin_verified','kernel_freshness_verified',
                  'may_settle','may_launch','may_resume_qualification',
                  'may_change_production'):
            self.assertIs(out[k],False)
        with self.assertRaisesRegex(ValueError,'ORPHAN_REVIEW_CHALLENGE_USED'):
            self.consume()
        with self.assertRaisesRegex(ValueError,'ORPHAN_REVIEW_CHALLENGE_USED'):
            self.challenge.issue_data()

    def test_public_nonce_and_claimed_process_are_not_root_provenance(self):
        row=self.issued_data
        self.assertEqual(row['nonce_hex'],'11'*32)
        self.assertEqual(row['challenge_sha256'],
                         hashlib.sha256(b'\x11'*32).hexdigest())
        self.assertEqual(row['status'],'UNVERIFIED_PROCESS_CHALLENGE_DATA')
        self.assertIs(row['process_origin_verified'],False)
        self.assertIs(row['may_launch'],False)
        self.assertIs(row['owner_authenticated'],False)

    def test_wrong_process_pid_start_ticks_and_boot_fail_closed(self):
        for key,val in (
            ('observed_pid',self.pid+1),
            ('observed_start_ticks',self.ticks+'0'),
            ('observed_boot_id','0'*8+'-'+self.boot[9:]),
            ('observed_pid',True),
            ('observed_unix_s','1791640810')):
            with self.subTest(field=key):
                with patch.object(self.module.secrets,'token_bytes',
                                  return_value=b'\x11'*32), \
                     patch.object(self.module.time,'monotonic',return_value=1000.0), \
                     patch.object(self.module.time,'time',return_value=float(self.issued)):
                    obj=self.module.SingleUseReviewChallengeData(
                        self.source,self.tree,self.mfile,self.mlogical,
                        self.pid,self.ticks,self.boot)
                kw={**self.kw,key:val}
                with self.assertRaises(ValueError):
                    obj.consume_signed_review_data(self.raw,b'fixture',
                        b'fixture',**kw)
                with self.assertRaisesRegex(ValueError,
                                             'ORPHAN_REVIEW_CHALLENGE_USED'):
                    obj.issue_data()

    def test_expired_or_regressed_time_is_refused_and_consumed(self):
        for key,val in (
            ('observed_monotonic',999.0),
            ('observed_monotonic',1120.001),
            ('observed_unix_s',self.issued-1),
            ('observed_unix_s',self.issued+121),
            ('observed_monotonic',None)):
            with self.subTest(field=key):
                with patch.object(self.module.secrets,'token_bytes',
                                  return_value=b'\x11'*32), \
                     patch.object(self.module.time,'monotonic',return_value=1000.0), \
                     patch.object(self.module.time,'time',return_value=float(self.issued)):
                    obj=self.module.SingleUseReviewChallengeData(
                        self.source,self.tree,self.mfile,self.mlogical,
                        self.pid,self.ticks,self.boot)
                with self.assertRaises(ValueError):
                    obj.consume_signed_review_data(
                        self.raw,b'fixture',b'fixture',
                        **{**self.kw,key:val})
                with self.assertRaisesRegex(ValueError,
                                             'ORPHAN_REVIEW_CHALLENGE_USED'):
                    obj.issue_data()

    def test_edited_signed_source_manifest_or_challenge_is_refused(self):
        for k,v in (
            ('source_sha','a'*40),('tree_sha','b'*40),
            ('manifest_file_sha256','f'*64),
            ('manifest_logical_sha256','e'*64),
            ('challenge_sha256','a'*64),
            ('boot_id','11111111-1111-1111-1111-111111111111'),
            ('issued_unix_s',self.issued+1),
            ('expires_unix_s',self.issued+121)):
            with self.subTest(field=k):
                with patch.object(self.module.secrets,'token_bytes',
                                  return_value=b'\x11'*32), \
                     patch.object(self.module.time,'monotonic',return_value=1000.0), \
                     patch.object(self.module.time,'time',return_value=float(self.issued)):
                    obj=self.module.SingleUseReviewChallengeData(
                        self.source,self.tree,self.mfile,self.mlogical,
                        self.pid,self.ticks,self.boot)
                edited=self.encode({**self.signed,k:v})
                with self.assertRaises(ValueError):
                    with patch.object(
                            self.module,'verify_signed_release_review_data',
                            return_value=self.crypto):
                        obj.consume_signed_review_data(
                            edited,b'fixture',b'fixture',**self.kw)

    def test_forged_crypto_flags_and_bad_signature_refused(self):
        for k,v in (
            ('owner_authenticated',True),
            ('signer_key_authenticated',True),
            ('source_provenance_verified',True),
            ('may_launch',True),
            ('may_resume_qualification',True),
            ('may_change_production',True),
            ('status','ROOT_APPROVED')):
            with self.subTest(field=k):
                with patch.object(self.module.secrets,'token_bytes',
                                  return_value=b'\x11'*32), \
                     patch.object(self.module.time,'monotonic',return_value=1000.0), \
                     patch.object(self.module.time,'time',return_value=float(self.issued)):
                    obj=self.module.SingleUseReviewChallengeData(
                        self.source,self.tree,self.mfile,self.mlogical,
                        self.pid,self.ticks,self.boot)
                with patch.object(
                        self.module,'verify_signed_release_review_data',
                        return_value={**self.crypto,k:v}):
                    with self.assertRaises(ValueError):
                        obj.consume_signed_review_data(
                            self.raw,b'fixture',b'fixture',**self.kw)
        with patch.object(self.module,'verify_signed_release_review_data',
                          side_effect=ValueError('BAD_SIGNATURE')):
            with self.assertRaises(ValueError):
                self.challenge.consume_signed_review_data(
                    self.raw,b'bad',b'fixture',**self.kw)
        with self.assertRaisesRegex(ValueError,'ORPHAN_REVIEW_CHALLENGE_USED'):
            self.challenge.issue_data()

    def test_invalid_constructor_or_nonce_source_refused(self):
        for name,value in (
            ('source_sha','x'*40),('tree_sha','x'*40),
            ('manifest_file_sha256','a'*63),
            ('claimed_pid',True),('claimed_pid',1),
            ('claimed_start_ticks','0'),('claimed_start_ticks',None),
            ('claimed_boot_id','not-a-boot')):
            args={'source_sha':self.source,'tree_sha':self.tree,
                  'manifest_file_sha256':self.mfile,
                  'manifest_logical_sha256':self.mlogical,
                  'claimed_pid':self.pid,
                  'claimed_start_ticks':self.ticks,
                  'claimed_boot_id':self.boot}
            args[name]=value
            with self.subTest(field=name),self.assertRaises(ValueError):
                self.module.SingleUseReviewChallengeData(**args)
        with patch.object(self.module.secrets,'token_bytes',return_value=b'bad'):
            with self.assertRaises(ValueError):
                self.module.SingleUseReviewChallengeData(
                    self.source,self.tree,self.mfile,self.mlogical,
                    self.pid,self.ticks,self.boot)

    def test_object_cannot_be_copied_or_serialized(self):
        for fn in (lambda:copy.copy(self.challenge),
                   lambda:copy.deepcopy(self.challenge),
                   lambda:pickle.dumps(self.challenge,protocol=5)):
            with self.assertRaises(ValueError):fn()

if __name__=='__main__':
    unittest.main()
