"""Opaque live approval cannot be forged by JSON or transferred between Root jobs.

Positive paths here register a synthetic fixture directly in a private test
registry; they are NOT an owner signature or real Root issuer.
"""
import copy
import hashlib
import pickle
import unittest
from unittest.mock import patch

from _loader import toolkit

_PUBLIC=bytes.fromhex(
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c')

class RootLocalOwnerReviewHandleTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation import orphan_live_owner_qualification_approval as mod
        self.mod=mod
        self.source='3'*40
        self.tree='4'*40
        self.custody='1'*64
        self.writer='2'*40
        self.driver='7'*64
        self.key_sha=hashlib.sha256(_PUBLIC).hexdigest()
        self.facts=('01234567-89ab-cdef-1234-567890abcdef',32123,'654321',32123)
        self.reviewer=mod._ProcessLocalOwnerReview(mod._ISSUE_SEAL)
        self.snapshot={
            'facts':self.facts,
            'expires_mono':1100.0,
            'source_sha':self.source,'tree_sha':self.tree,
            'manifest_file_sha256':'5'*64,
            'manifest_logical_sha256':'6'*64,
            'custody_sha256':self.custody,
            'writer_source_sha':self.writer,
            'owner_key_sha256':self.key_sha,
            'driver_sha256':self.driver,
            'approval_sha256':'8'*64,
        }
        mod._issued_reviews[self.reviewer]=self.snapshot

    def consume(self,*,facts=None,clock=1001.0,source=None,
                tree_proof=None,custody_proof=None,key=None):
        source_row=tree_proof or {
            'status':'PHYSICAL_ROOT_TOOLKIT_BYTES_MATCH_UNTRUSTED_PINS',
            'manifest_logical_sha256':'6'*64}
        custody_row=custody_proof or {
            'status':'ROOT_PHYSICAL_CUSTODY_AND_ORIGINAL_INTENT_MATCH_DATA_ONLY'}
        with patch.object(self.mod,'_root_process_facts',
                          return_value=self.facts if facts is None else facts), \
             patch.object(self.mod,'_exact_root_context',
                          return_value='toolkit-'+self.source), \
             patch.object(self.mod.time,'monotonic',return_value=clock), \
             patch('rbridge_installation.orphan_published_source_review.inspect_published_toolkit_readonly',
                   return_value=source_row), \
             patch('rbridge_installation.orphan_retained_custody_observer.observe_protected_retained_custody',
                   return_value=custody_row), \
             patch('rbridge_installation.orphan_owner_key_origin._read_protected_owner_key',
                   return_value=_PUBLIC if key is None else key):
            return self.mod.consume_process_local_signed_review(
                self.reviewer,
                self.source if source is None else source,
                self.custody,self.driver)

    def test_valid_mocked_physical_review_yields_only_process_local_data_handle(self):
        approved=self.consume()
        receipt=self.mod.describe_process_local_approval(approved)
        self.assertEqual(receipt['status'],
                         'PROCESS_LOCAL_SIGNED_REVIEW_NOT_QUALIFICATION_AUTHORITY')
        self.assertEqual(receipt['approval_sha256'],'8'*64)
        self.assertTrue(receipt['owner_signature_checked'])
        for flag in ('owner_identity_independently_authenticated','lease_issued',
                     'may_settle','may_launch','may_resume_qualification',
                     'may_change_production'):
            self.assertIs(receipt[flag],False)
        self.assertNotIn('process_lease',receipt)
        self.assertNotIn('authorization_token',receipt)
        with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_REVIEW_HANDLE_INVALID'):
            self.consume()
        from rbridge_installation.orphan_dual_guard_gate import (
            require_qualified_orphan_lease,ORPHAN_NAME)
        for guard in ('MAINTENANCE_REGISTRY','HELPER_JOURNAL'):
            with self.assertRaisesRegex(ValueError,'ORPHAN_GUARD_ISSUER_NOT_IMPLEMENTED'):
                require_qualified_orphan_lease(
                    approved,guard=guard,journal_name=ORPHAN_NAME)

    def test_mock_handle_without_registry_or_created_with_wrong_seal_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_REVIEW_CANNOT_BE_CONSTRUCTED'):
            self.mod._ProcessLocalOwnerReview()
        with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_APPROVAL_CANNOT_BE_CONSTRUCTED'):
            self.mod._ProcessLocalApprovedReview(object())
        forged=self.mod._ProcessLocalOwnerReview(self.mod._ISSUE_SEAL)
        with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_REVIEW_HANDLE_INVALID'):
            self.mod.consume_process_local_signed_review(
                forged,self.source,self.custody,self.driver)
        with self.assertRaises(ValueError):
            self.mod.describe_process_local_approval(
                self.mod._ProcessLocalApprovedReview(self.mod._ISSUE_SEAL))

    def test_wrong_source_driver_or_custody_consumes_even_on_failure(self):
        for kind in ('source_sha','custody_sha256','qualification_driver_sha256'):
            with self.subTest(kind=kind):
                self.mod._issued_reviews[self.reviewer]=self.snapshot
                kw=dict(source_sha=self.source,custody_sha256=self.custody,
                        qualification_driver_sha256=self.driver)
                kw[kind]='f'*(40 if kind=='source_sha' else 64)
                with self.assertRaises(ValueError):
                    self.mod.consume_process_local_signed_review(self.reviewer,**kw)
                self.assertNotIn(self.reviewer,self.mod._issued_reviews)

    def test_live_pid_start_ticks_boot_or_native_thread_drift_consumes(self):
        for i in range(4):
            with self.subTest(field=i):
                self.mod._issued_reviews[self.reviewer]=self.snapshot
                drift=list(self.facts)
                drift[i]='0'*8+'-'+self.facts[0][9:] if i==0 else 54321 if i in (1,3) else '999999'
                with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_REVIEW_ORIGIN_OR_TIME_CHANGED'):
                    self.consume(facts=tuple(drift))
                self.assertNotIn(self.reviewer,self.mod._issued_reviews)

    def test_monotonic_expiration_is_fail_closed_and_consumes(self):
        with self.assertRaisesRegex(ValueError,'ORPHAN_LIVE_REVIEW_ORIGIN_OR_TIME_CHANGED'):
            self.consume(clock=1100.01)
        self.assertNotIn(self.reviewer,self.mod._issued_reviews)

    def test_changed_protected_source_custody_or_enrolled_key_consumes(self):
        cases=[
            {'tree_proof':{'status':'BLOCKED','manifest_logical_sha256':'6'*64}},
            {'tree_proof':{'status':'PHYSICAL_ROOT_TOOLKIT_BYTES_MATCH_UNTRUSTED_PINS',
                           'manifest_logical_sha256':'e'*64}},
            {'custody_proof':{'status':'BLOCKED'}},
            {'key':b'0'*32},
        ]
        for kw in cases:
            self.mod._issued_reviews[self.reviewer]=self.snapshot
            with self.subTest(kw=kw),self.assertRaises(ValueError):
                self.consume(**kw)
            self.assertNotIn(self.reviewer,self.mod._issued_reviews)

    def test_process_local_handles_are_not_copyable_or_picklable(self):
        for cls in (self.mod._ProcessLocalOwnerReview,
                    self.mod._ProcessLocalApprovedReview):
            obj=cls(self.mod._ISSUE_SEAL)
            for operation in (lambda:copy.copy(obj),
                              lambda:copy.deepcopy(obj),
                              lambda:pickle.dumps(obj,protocol=5)):
                with self.subTest(cls=cls.__name__),self.assertRaises(ValueError):
                    operation()

if __name__=='__main__':
    unittest.main()
