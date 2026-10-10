"""Protected Root public-key evidence is NOT authenticated owner enrollment."""
import hashlib
import os
import unittest
from unittest.mock import patch
from _loader import toolkit

_PUBLIC=bytes.fromhex(
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c')

class OwnerProtectedPublicKeyDataTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation import orphan_owner_key_origin as origin
        self.origin=origin
        self.sha=hashlib.sha256(_PUBLIC).hexdigest()

    def test_public_key_data_is_never_owner_authentication(self):
        out=self.origin.compare_public_key_data(_PUBLIC,self.sha)
        self.assertEqual(out['status'],'PUBLIC_KEY_DATA_MATCH_ONLY')
        self.assertEqual(out['key_sha256'],self.sha)
        for field in ('key_enrollment_authenticated','owner_authenticated',
                      'root_source_provenance_verified','may_settle','may_launch',
                      'may_resume_qualification','may_change_production'):
            self.assertIs(out[field],False)

    def test_untrusted_forged_key_can_only_match_data(self):
        # A supplied public key and matching digest, even for a *fake* key,
        # cannot prove that a human owner enrolled the key.
        for pub in (_PUBLIC,b'\x77'*32,b'\x00'*32):
            with self.subTest(digest=hashlib.sha256(pub).hexdigest()):
                out=self.origin.compare_public_key_data(
                    pub,hashlib.sha256(pub).hexdigest())
                self.assertIs(out['owner_authenticated'],False)
                self.assertIs(out['may_launch'],False)

    def test_wrong_sha_types_or_lengths_are_refused(self):
        for pub,digest in (
            (_PUBLIC,'f'*64),(_PUBLIC,'0'*63),(_PUBLIC,'G'*64),
            (_PUBLIC,None),(b'',self.sha),(b'a'*31,self.sha),
            (b'a'*33,self.sha),(None,self.sha),(123,self.sha)):
            with self.subTest(kind=str(type(pub)),sha=str(digest)[:12]):
                with self.assertRaises(ValueError):
                    self.origin.compare_public_key_data(pub,digest)

    def test_root_only_reader_refuses_nonroot_before_storage_access(self):
        if os.getuid()!=0 or os.geteuid()!=0:
            with self.assertRaisesRegex(
                    ValueError,'ORPHAN_OWNER_KEY_ROOT_REQUIRED'):
                self.origin.observe_protected_owner_key(self.sha)
            with self.assertRaisesRegex(
                    ValueError,'ORPHAN_OWNER_KEY_ROOT_REQUIRED'):
                self.origin.verify_signed_review_using_protected_key(
                    b'fixture',b'\x00'*64,self.sha)

    def test_mocked_key_bytes_remain_untrusted_data(self):
        # Mocked Root bytes are a SOURCE fixture, NEVER a physical Root PASS.
        with patch.object(self.origin,'_read_protected_owner_key',
                          return_value=_PUBLIC):
            out=self.origin.observe_protected_owner_key(self.sha)
        self.assertEqual(out['status'],
                         'ROOT_PROTECTED_KEY_BYTES_MATCH_UNTRUSTED_PIN')
        self.assertIs(out['root_public_key_bytes_observed'],True)
        self.assertIs(out['key_enrollment_authenticated'],False)
        self.assertIs(out['owner_authenticated'],False)
        self.assertIs(out['may_resume_qualification'],False)

    def test_mocked_signature_combination_does_not_issue_authority(self):
        # Cryptography itself is separately tested against public RFC vectors.
        fake_crypto={'status':'SIGNATURE_VALID_ONLY_UNTRUSTED_KEY',
                     'signer_key_sha256':self.sha,
                     'signature_cryptographically_valid':True,
                     'owner_authenticated':False,'may_launch':False,
                     'may_resume_qualification':False,
                     'may_change_production':False}
        from rbridge_installation import orphan_owner_signed_release_review as crypto
        with patch.object(self.origin,'_read_protected_owner_key',
                          return_value=_PUBLIC), \
             patch.object(crypto,'verify_signed_release_review_data',
                          return_value=fake_crypto):
            out=self.origin.verify_signed_review_using_protected_key(
                b'fixture',b'fixture',self.sha)
        self.assertEqual(out['status'],
                         'CRYPTO_SIGNATURE_AND_ROOT_KEY_DATA_MATCH_ONLY')
        for field in ('key_enrollment_authenticated','owner_authenticated',
                      'root_source_provenance_verified',
                      'challenge_freshness_verified','may_settle','may_launch',
                      'may_resume_qualification','may_change_production'):
            self.assertIs(out[field],False)
        self.assertIs(out['root_public_key_bytes_observed'],True)

    def test_invalid_signature_result_does_not_pass_combination(self):
        from rbridge_installation import orphan_owner_signed_release_review as crypto
        with patch.object(self.origin,'_read_protected_owner_key',
                          return_value=_PUBLIC), \
             patch.object(crypto,'verify_signed_release_review_data',
                          return_value={'status':'FAILED',
                           'signer_key_sha256':self.sha}):
            with self.assertRaises(ValueError):
                self.origin.verify_signed_review_using_protected_key(
                    b'fixture',b'fixture',self.sha)

if __name__=='__main__':
    unittest.main()
