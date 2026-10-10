"""A typed TTY acknowledgement is only data, never Root admission."""
import unittest
from _loader import toolkit
import test_orphan_intent_review_packet as fixtures

class OrphanTTYReviewTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_tty_review import (
            compare_tty_review_response,collect_root_tty_review_data)
        self.compare=compare_tty_review_response
        self.collect=collect_root_tty_review_data
        self.peer=fixtures.OrphanReviewPacketTests(
            'test_exact_claim_is_only_unverified_data')
        self.peer.setUp()
        self.nonce='a'*32
        self.response=b'ACKNOWLEDGE UNKNOWN '+self.nonce.encode()+b'\n'

    def test_exact_response_matches_without_authority(self):
        value=self.compare(self.nonce,self.response)
        self.assertEqual(value['status'],'BYTE_MATCH_ONLY')
        self.assertEqual(value['schema'],'RBRIDGE_ORPHAN_TTY_COMPARISON_V1')
        for name in ('owner_authenticated','may_launch',
                     'may_resume_qualification','may_change_production'):
            self.assertIs(value[name],False)

    def test_replay_with_different_challenge_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'ORPHAN_TTY_RESPONSE_MISMATCH'):
            self.compare('b'*32,self.response)

    def test_unqualified_responses_are_rejected(self):
        for response in (
            self.response[:-1],
            self.response+b'EXTRA',
            b'ACKNOWLEDGE UNKNOWN '+b'a'*32+b'\r\n',
            b'APPROVE RESTART '+b'a'*32+b'\n',
            b'',b'x'*129):
            with self.subTest(length=len(response)):
                with self.assertRaises(ValueError):
                    self.compare(self.nonce,response)

    def test_invalid_challenge_types_are_rejected(self):
        for nonce in ('0'*32,'A'*32,'x',True,1,'a'*31):
            with self.subTest(nonce=nonce):
                with self.assertRaises(ValueError):
                    self.compare(nonce,self.response)

    def test_root_collector_refuses_nonroot_before_tty_io(self):
        import os
        if os.getuid()!=0:
            with self.assertRaisesRegex(ValueError,'ORPHAN_TTY_ROOT_REQUIRED'):
                self.collect(self.peer.observation,self.peer.claim)

    def test_not_a_crypto_signature_or_settlement(self):
        value=self.compare(self.nonce,self.response)
        self.assertNotIn('signature',value)
        self.assertNotIn('settled',value)
        self.assertNotIn('root_disposition_written',value)
        self.assertIs(value['owner_authenticated'],False)

if __name__=='__main__':
    unittest.main()
