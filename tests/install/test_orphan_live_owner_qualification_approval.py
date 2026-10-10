"""Qualification-specific Ed25519 approval bytes do NOT mint a Root lease."""
import copy
import hashlib
import unittest
from unittest.mock import patch

from _loader import toolkit

# Public RFC8032 test-vector key, never the private owner credential.
_PUBLIC=bytes.fromhex(
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c')
# Fixed signature made using public RFC8032 test seed ONLY, for the exact
# canonical fixture below; NOT an authorization on the live aether-engine.
_SIGNATURE=bytes.fromhex(
    '0528a4831c9621e4dc0fbeb86aa7a524c3ee49183792aec76bc967b9b6c43397'
    '5bcc9e289ed49898fe01ead79b429ba057d9b852539ff2a7a126a6d6f7a74e08')

class LiveOwnerApprovalDataTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation import orphan_live_owner_qualification_approval as module
        from rbridge_installation.models import encode_report
        self.mod=module
        self.encode=encode_report
        self.payload={
            'schema':'RBRIDGE_ROOT_P2A_OWNER_APPROVAL_V1',
            'scope':'ONE_READONLY_QUALIFICATION_REVIEW_ONLY',
            'purpose':'APPROVE_ONCE_P2A_READONLY_ROOT_QUALIFICATION',
            'host':'aether-engine',
            'journal_name':'helper-0b84e8af62a287a283eabcd4eef1cdb7',
            'intent_sha256':'844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276',
            'custody_sha256':'1'*64,'writer_source_sha':'2'*40,
            'source_sha':'3'*40,'tree_sha':'4'*40,
            'manifest_file_sha256':'5'*64,
            'manifest_logical_sha256':'6'*64,
            'owner_key_sha256':hashlib.sha256(_PUBLIC).hexdigest(),
            'qualification_driver_sha256':'7'*64,
            'boot_id':'01234567-89ab-cdef-1234-567890abcdef',
            'root_pid':32123,'root_start_ticks':'654321',
            'root_thread_id':32123,'nonce_hex':'8'*64,
            'issued_unix_s':1791640000,'expires_unix_s':1791640180,
            'historical_execution':'UNKNOWN',
            'requested_service_actions':[],
            'production_switch_authorized':False,
            'may_settle':False,'may_change_production':False,
        }
        self.raw=self.encode(self.payload)

    def test_rfc_key_valid_signature_is_data_only_even_for_qualification_purpose(self):
        self.assertEqual(hashlib.sha256(self.raw).hexdigest(),
                         '509f4719d7c7763459ec2a45562f838700cff950b18e8566430d0d4120005bb2')
        self.assertEqual(len(self.raw),1340)
        self.assertEqual(self.mod.parse_qualification_approval_bytes(self.raw),self.payload)
        row=self.mod.verify_qualification_signature_data(
            self.raw,_SIGNATURE,_PUBLIC,self.raw)
        self.assertEqual(row['status'],
                         'ENROLLED_KEY_SIGNATURE_CRYPTOGRAPHICALLY_VALID_DATA_ONLY')
        self.assertEqual(row['challenge_sha256'],hashlib.sha256(self.raw).hexdigest())
        self.assertIs(row['signature_valid_relative_to_supplied_key'],True)
        for k in ('live_root_process_verified','protected_key_origin_verified',
                  'physical_custody_verified','owner_identity_independently_authenticated',
                  'lease_issued','may_settle','may_launch',
                  'may_resume_qualification','may_change_production'):
            self.assertIs(row[k],False)

    def test_signature_replay_with_different_nonce_source_boot_or_pid_blocked(self):
        for key,value in (
            ('nonce_hex','9'*64),
            ('source_sha','a'*40),
            ('tree_sha','b'*40),
            ('writer_source_sha','c'*40),
            ('custody_sha256','d'*64),
            ('manifest_file_sha256','e'*64),
            ('qualification_driver_sha256','f'*64),
            ('root_pid',32124),
            ('root_start_ticks','654322'),
            ('root_thread_id',32124),
            ('boot_id','11111111-1111-1111-1111-111111111111'),
            ('issued_unix_s',1791640001),
            ('expires_unix_s',1791640181)):
            edited=self.encode({**self.payload,key:value})
            with self.subTest(key=key),self.assertRaises(ValueError):
                self.mod.verify_qualification_signature_data(
                    edited,_SIGNATURE,_PUBLIC,edited)

    def test_cannot_copy_signed_request_to_new_expected_payload(self):
        changed=self.encode({**self.payload,'nonce_hex':'9'*64})
        with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_APPROVAL_BINDING_CHANGED'):
            self.mod.verify_qualification_signature_data(
                self.raw,_SIGNATURE,_PUBLIC,changed)
        with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_APPROVAL_BINDING_CHANGED'):
            self.mod.verify_qualification_signature_data(
                self.raw,_SIGNATURE,_PUBLIC,None)

    def test_fake_signed_key_and_invalid_signature_blocked(self):
        with self.assertRaises(ValueError):
            self.mod.verify_qualification_signature_data(
                self.raw,b'0'*64,_PUBLIC,self.raw)
        with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_APPROVAL_KEY_MISMATCH'):
            self.mod.verify_qualification_signature_data(
                self.raw,_SIGNATURE,b'1'*32,self.raw)
        for signature in (b'',b'bad',123,None):
            with self.subTest(sig=repr(signature)),self.assertRaises(ValueError):
                self.mod.verify_qualification_signature_data(
                    self.raw,signature,_PUBLIC,self.raw)

    def test_scope_cannot_change_to_service_or_cutover(self):
        for key,value in (
            ('purpose','APPROVE_ALL_ROOT_ACTIONS'),
            ('scope','UNRESTRICTED'),
            ('requested_service_actions',['restart rbridge.service']),
            ('production_switch_authorized',True),
            ('may_settle',True),
            ('may_change_production',True),
            ('historical_execution','SUCCESS'),
            ('journal_name','helper-'+'f'*32),
            ('host','another-host')):
            bad=self.encode({**self.payload,key:value})
            with self.subTest(key=key),self.assertRaises(ValueError):
                self.mod.parse_qualification_approval_bytes(bad)

    def test_strict_format_rejects_bad_numeric_identity_and_expiry(self):
        for key,value in (
            ('root_pid',True),
            ('root_pid',0),
            ('root_thread_id',True),
            ('root_thread_id',0),
            ('root_start_ticks','0'),
            ('root_start_ticks',None),
            ('nonce_hex','0'*64),
            ('nonce_hex','X'*64),
            ('issued_unix_s',True),
            ('expires_unix_s',1791640181),
            ('expires_unix_s',1791639999),
            ('owner_key_sha256','x'*64)):
            bad=self.encode({**self.payload,key:value})
            with self.subTest(key=key),self.assertRaises(ValueError):
                self.mod.parse_qualification_approval_bytes(bad)

    def test_noncanonical_extra_duplicate_and_malformed_bytes_blocked(self):
        for raw in (
            b'', b' ',self.raw+b'\n',b' '+self.raw,
            self.raw.replace(b'"host":"aether-engine"',
                b'"host":"aether-engine","host":"aether-engine"',1),
            b'{"status":NaN}',b'\xff',
            self.raw+b'{}',self.raw+b' '*3500):
            with self.subTest(length=len(raw)),self.assertRaises(ValueError):
                self.mod.parse_qualification_approval_bytes(raw)
        for text in ({},123,None,'not bytes'):
            with self.assertRaises(ValueError):
                self.mod.parse_qualification_approval_bytes(text)

    def test_no_root_call_can_be_made_in_nonroot_user_context(self):
        import os
        if os.getuid()!=0:
            with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_ROOT_CONTEXT_REQUIRED'):
                self.mod.collect_live_root_owner_qualification_signature(
                    '3'*40,'4'*40,'5'*64,'6'*64,'1'*64,'2'*40,
                    hashlib.sha256(_PUBLIC).hexdigest(),'7'*64)

    def test_root_process_facts_require_actual_kernel_origin(self):
        with patch('rbridge_installation.host_backend._assert_kernel_namespace',
                   side_effect=ValueError('unqualified')):
            with self.assertRaises(ValueError):
                self.mod._root_process_facts()

if __name__=='__main__':
    unittest.main()
