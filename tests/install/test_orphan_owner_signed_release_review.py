"""Detached Ed25519 validity NEVER equates to an authenticated Root owner."""
import copy
import hashlib
import unittest
from unittest.mock import patch
from _loader import toolkit

# Public RFC8032 Ed25519 test-vector key, NOT a real owner credential.
_PUBLIC=bytes.fromhex(
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c')
_RFC_SIG=bytes.fromhex(
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da'
    '085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00')
# Deterministic signature over canonical review-only fixture using public RFC
# test seed. These bytes are a test, NOT an enrolled signer or owner approval.
_REVIEW_SIG=bytes.fromhex(
    'cd66bf66841c7a131d7001d7238a4ad2531ccccc56ade3836e256f1a91aa3fc3'
    '1c9c82e941c3863afd04a0dcdf5319f1f3b82fd1f046a6c2b780639e47b82906')

class OwnerReleaseCryptographicDataTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_owner_signed_release_review import (
            _native_ed25519_verify,parse_signed_release_review_data,
            verify_signed_release_review_data)
        from rbridge_installation.models import encode_report
        self.native=_native_ed25519_verify
        self.parse=parse_signed_release_review_data
        self.verify=verify_signed_release_review_data
        self.encode=encode_report
        self.payload={
            'schema':'RBRIDGE_OWNER_SIGNED_RELEASE_REVIEW_V1',
            'scope':'UNVERIFIED_SIGNER_DATA_ONLY',
            'purpose':'REVIEW_EXACT_P2A_TOOLKIT_BYTES_ONLY',
            'host':'aether-engine',
            'journal_name':'helper-0b84e8af62a287a283eabcd4eef1cdb7',
            'intent_sha256':'844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276',
            'source_sha':'e6ed38a367fb96bf765306188168e2bc70027d43',
            'tree_sha':'7a804948feb1745dd3d4e33e26aa003254e68237',
            'manifest_file_sha256':'53de30fb3731091f337635842b552ad917b5bf9b341875cf768cc5d6fe208a5b',
            'manifest_logical_sha256':'e5a1673965c14677facdc8277a1d58323afa4e454898c786d6e1260d84e474bc',
            'owner_key_sha256':hashlib.sha256(_PUBLIC).hexdigest(),
            'challenge_sha256':'a'*64,
            'boot_id':'01234567-89ab-cdef-1234-567890abcdef',
            'issued_unix_s':1791640000,'expires_unix_s':1791640600,
            'historical_execution':'UNKNOWN','service_actions':[],
            'production_switch_authorized':False,'may_settle':False,
            'may_launch':False,'may_resume_qualification':False,
            'may_change_production':False}
        self.raw=self.encode(self.payload)

    def test_rfc8032_ed25519_vector_verifies_without_subprocess(self):
        self.assertTrue(self.native(b'\x72',_PUBLIC,_RFC_SIG))
        for msg,pub,sig in (
            (b'\x73',_PUBLIC,_RFC_SIG),
            (b'\x72',bytes([_PUBLIC[0]^1])+_PUBLIC[1:],_RFC_SIG),
            (b'\x72',_PUBLIC,bytes([_RFC_SIG[0]^1])+_RFC_SIG[1:])):
            with self.subTest(msg=msg[:1],pub=pub[:1],sig=sig[:1]):
                with self.assertRaises(ValueError):self.native(msg,pub,sig)

    def test_valid_signed_fixture_proves_signature_but_not_owner(self):
        self.assertEqual(hashlib.sha256(self.raw).hexdigest(),
                         '9652930c1c779f999bf08ef0f97f71a5635e588046cdddd035a1c3b2fea76a1a')
        out=self.verify(self.raw,_REVIEW_SIG,_PUBLIC)
        self.assertEqual(out['status'],'SIGNATURE_VALID_ONLY_UNTRUSTED_KEY')
        self.assertIs(out['signature_cryptographically_valid'],True)
        self.assertEqual(out['approval_sha256'],hashlib.sha256(self.raw).hexdigest())
        self.assertGreater(len(out['requirements_missing']),0)
        for key in ('signer_key_authenticated','owner_authenticated',
                    'challenge_freshness_verified','boot_and_time_live_verified',
                    'source_provenance_verified','may_settle','may_launch',
                    'may_resume_qualification','may_change_production'):
            self.assertIs(out[key],False)
        self.assertEqual(self.parse(self.raw),self.payload)

    def test_public_fixture_key_is_not_owner_trust_root(self):
        # A self-contained valid public test signature NEVER authenticates
        # the owner, source, boot, challenge, or authority to run a helper.
        out=self.verify(self.raw,_REVIEW_SIG,_PUBLIC)
        self.assertIn('PINNED_PROTECTED_OWNER_PUBLIC_KEY_TRUST_ROOT',
                      out['requirements_missing'])
        self.assertIn('FRESH_ROOT_CHALLENGE_AND_SINGLE_USE_PROOF',
                      out['requirements_missing'])
        self.assertIs(out['may_resume_qualification'],False)

    def test_modified_signed_payload_or_signature_refused(self):
        for field,value in (
            ('source_sha','a'*40),('tree_sha','b'*40),
            ('manifest_file_sha256','f'*64),
            ('challenge_sha256','c'*64),
            ('issued_unix_s',1791640001),
            ('expires_unix_s',1791640599)):
            data=copy.deepcopy(self.payload);data[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):
                self.verify(self.encode(data),_REVIEW_SIG,_PUBLIC)
        with self.assertRaises(ValueError):
            self.verify(self.raw,bytes([_REVIEW_SIG[0]^1])+_REVIEW_SIG[1:],_PUBLIC)
        other=bytes([_PUBLIC[0]^1])+_PUBLIC[1:]
        with self.assertRaises(ValueError):
            self.verify(self.raw,_REVIEW_SIG,other)

    def test_strict_scope_and_authority_flags_refused(self):
        for field,value in (
            ('purpose','AUTHORIZE_ROOT_QUALIFICATION'),
            ('scope','VERIFIED_OWNER'),
            ('host','other-engine'),
            ('journal_name','helper-'+'f'*32),
            ('intent_sha256','f'*64),
            ('historical_execution','SUCCESS'),
            ('may_settle',True),('may_launch',True),
            ('may_resume_qualification',True),
            ('may_change_production',True),
            ('production_switch_authorized',True),
            ('service_actions',['restart rbridge.service'])):
            data=copy.deepcopy(self.payload);data[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):
                self.parse(self.encode(data))

    def test_timestamp_format_and_claimed_window_cannot_widen(self):
        for key,value in (
            ('issued_unix_s',True),('expires_unix_s','1791640600'),
            ('issued_unix_s',0),('expires_unix_s',1791640601),
            ('expires_unix_s',1791639999)):
            data=copy.deepcopy(self.payload);data[key]=value
            with self.subTest(field=key),self.assertRaises(ValueError):
                self.parse(self.encode(data))
        # No real clock/challenge state is read from this pure DATA function.
        self.assertIs(self.verify(self.raw,_REVIEW_SIG,_PUBLIC)
                      ['boot_and_time_live_verified'],False)

    def test_canonical_duplicate_unexpected_and_invalid_types(self):
        for raw in (
            b' '+self.raw,self.raw+b'\n',b'',
            self.raw.replace(b'"host":"aether-engine"',
                             b'"host":"aether-engine","host":"aether-engine"',1),
            b'{"schema":NaN}',b'\xff',b'a'*8193):
            with self.subTest(length=len(raw)),self.assertRaises(ValueError):
                self.parse(raw)
        for raw in (None,'text',{},123):
            with self.assertRaises(ValueError):self.parse(raw)
        extra={**self.payload,'owner_authenticated':True}
        with self.assertRaises(ValueError):self.parse(self.encode(extra))
        no_key=dict(self.payload);del no_key['tree_sha']
        with self.assertRaises(ValueError):self.parse(self.encode(no_key))

    def test_native_crypto_missing_or_invalid_inputs_fail_closed(self):
        with patch('rbridge_installation.orphan_owner_signed_release_review.ctypes.CDLL',
                   side_effect=OSError('not available')):
            with self.assertRaises(ValueError):
                self.native(b'\x72',_PUBLIC,_RFC_SIG)
        for pub,sig in ((b'',_RFC_SIG),(_PUBLIC,b''),(123,_RFC_SIG),
                        (_PUBLIC,'not bytes')):
            with self.assertRaises(ValueError):self.native(b'\x72',pub,sig)
        with self.assertRaises(ValueError):self.native(b'x'*8193,_PUBLIC,_RFC_SIG)

if __name__=='__main__':
    unittest.main()
