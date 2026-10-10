"""A signed Root review cannot grant a general helper operation or cutover.

Every positive state-machine fixture patches the actual Root physical verifier.
This proves Python control logic only, never actual Root provenance/admission.
The two operative guards are NOT wired to this proposed lease in this PR.
"""
import copy
import os
import pickle
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from _loader import toolkit

class ProposedReadOnlyRootLeaseTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation import orphan_single_readonly_root_lease as mod
        from rbridge_installation import orphan_live_owner_qualification_approval as live
        from rbridge_installation.orphan_intent_review import READONLY_ARGV,READONLY_EXE_SHA
        from rbridge_installation.orphan_dual_guard_gate import ORPHAN_NAME
        self.mod=mod
        self.live=live
        self.argv=READONLY_ARGV
        self.driver=READONLY_EXE_SHA
        self.orphan=ORPHAN_NAME
        self.facts=('01234567-89ab-cdef-1234-567890abcdef',32123,'654321',32123)
        self.snapshot={
            'facts':self.facts,
            'expires_mono':1100.0,
            'source_sha':'3'*40,'tree_sha':'4'*40,
            'manifest_file_sha256':'5'*64,
            'manifest_logical_sha256':'6'*64,
            'custody_sha256':'1'*64,'writer_source_sha':'2'*40,
            'owner_key_sha256':'9'*64,
            'driver_sha256':self.driver,
            'approval_sha256':'8'*64,
        }
        self.handle=live._ProcessLocalApprovedReview(live._ISSUE_SEAL)
        live._approved_reviews[self.handle]=self.snapshot
        self.pin=SimpleNamespace(path=self.argv[0],sha256=self.driver)

    def issue_fixture(self):
        # Do NOT weaken the physical verifier in production. This is an
        # isolated source test of the new private state machine.
        with patch.object(self.mod,'_physical_revalidate'):
            return self.mod.issue_one_root_readonly_qualification_lease(self.handle)

    def validate_fixture(self,lease,guard,phase,pin=None,args=None,
                         input_bytes=None,child_specs=None):
        with patch.object(self.mod,'_physical_revalidate'):
            return self.mod._validate_live_lease(
                lease,guard=guard,journal_name=self.orphan,phase=phase,
                pin=pin,args=args,input_bytes=input_bytes,
                child_specs=child_specs)

    def test_single_signed_readonly_workflow_has_strict_order_and_one_use(self):
        lease=self.issue_fixture()
        for phase in ('PRECHECK','PRECHECK'):
            check=self.validate_fixture(
                lease,'MAINTENANCE_REGISTRY',phase)
            self.assertFalse(check['service_action_authorized'])
        self.assertEqual(self.mod._live[lease]['state'],'NEW')
        check=self.validate_fixture(lease,'MAINTENANCE_REGISTRY','ORPHAN')
        self.assertEqual(self.mod._live[lease]['state'],'REGISTRY_OBSERVED')
        self.assertIs(check['old_journal_settled'],False)
        self.assertIs(check['operational_admission_authorized'],False)
        self.assertEqual(check['status'],
                         'SOURCE_ONLY_PROPOSED_ORIGINAL_ORPHAN_READONLY_AUDIT')
        with self.assertRaises(ValueError):
            self.validate_fixture(lease,'MAINTENANCE_REGISTRY','ORPHAN')
        args=list(self.argv[1:])
        self.assertEqual(self.validate_fixture(
            lease,'HELPER_JOURNAL','PRECHECK',
            self.pin,args,b'',())['phase'],'PRECHECK')
        self.assertEqual(self.mod._live[lease]['state'],'REGISTRY_OBSERVED')
        self.validate_fixture(
            lease,'HELPER_JOURNAL','ORPHAN',self.pin,args,b'',())
        self.assertEqual(self.mod._live[lease]['state'],'CONSUMED')
        with self.assertRaises(ValueError):
            self.validate_fixture(lease,'HELPER_JOURNAL','ORPHAN',
                                  self.pin,args,b'',())
        self.mod.revoke_root_readonly_lease(lease)
        with self.assertRaisesRegex(ValueError,'ORPHAN_READONLY_LEASE_NOT_LIVE'):
            self.validate_fixture(lease,'HELPER_JOURNAL','PRECHECK')

    def test_non_readonly_operations_are_always_refused_before_consuming(self):
        samples=(
            (SimpleNamespace(path='/usr/bin/systemctl',sha256=self.driver),
             ['restart','rbridge.service'],b'',()),
            (self.pin,['show','other.service'],b'',()),
            (self.pin,list(self.argv[1:]),b'mutate',()),
            (self.pin,list(self.argv[1:]),b'',({'exe':'/bin/sh'},)),
            (SimpleNamespace(path='/usr/sbin/runuser',sha256=self.driver),
             list(self.argv[1:]),b'',()),
            (SimpleNamespace(path=self.argv[0],sha256='f'*64),
             list(self.argv[1:]),b'',()),
        )
        lease=self.issue_fixture()
        self.validate_fixture(lease,'MAINTENANCE_REGISTRY','ORPHAN')
        for pin,args,data,specs in samples:
            with self.subTest(args=args,pin=pin),self.assertRaisesRegex(
                    ValueError,'ORPHAN_READONLY_HELPER_OPERATION_UNQUALIFIED'):
                self.validate_fixture(lease,'HELPER_JOURNAL','ORPHAN',
                                      pin,args,data,specs)
            self.assertEqual(self.mod._live[lease]['state'],'REGISTRY_OBSERVED')

    def test_bad_or_pretend_owner_receipt_never_issues_lease(self):
        with self.assertRaisesRegex(ValueError,'ORPHAN_READONLY_LEASE_SIGNED_REVIEW_REQUIRED'):
            self.mod.issue_one_root_readonly_qualification_lease(
                {'signature_valid':True,'may_launch':True})
        with self.assertRaisesRegex(ValueError,'ORPHAN_READONLY_LEASE_SIGNED_REVIEW_REQUIRED'):
            self.mod.issue_one_root_readonly_qualification_lease(object())
        with self.assertRaisesRegex(ValueError,'ORPHAN_READONLY_LEASE_UNISSUED'):
            self.mod._OneRootReadOnlyQualificationLease()
        forged=self.mod._OneRootReadOnlyQualificationLease(self.mod._FACTORY_SEAL)
        with self.assertRaisesRegex(ValueError,'ORPHAN_READONLY_LEASE_NOT_LIVE'):
            self.validate_fixture(forged,'HELPER_JOURNAL','PRECHECK')

    def test_not_exact_original_or_wrong_guard_or_phase_is_denied(self):
        lease=self.issue_fixture()
        for kwargs in (
            {'guard':'PRODUCTION_SWITCH','journal_name':self.orphan,'phase':'PRECHECK'},
            {'guard':'MAINTENANCE_REGISTRY','journal_name':'helper-'+'f'*32,'phase':'PRECHECK'},
            {'guard':'MAINTENANCE_REGISTRY','journal_name':self.orphan,'phase':'IGNORE_ALL'},
        ):
            with self.subTest(kwargs=kwargs),patch.object(self.mod,'_physical_revalidate'):
                with self.assertRaises(ValueError):
                    self.mod._validate_live_lease(lease,**kwargs)

    def test_wrong_signed_driver_rejected_and_review_consumed(self):
        self.snapshot['driver_sha256']='f'*64
        with patch.object(self.mod,'_physical_revalidate'):
            with self.assertRaisesRegex(ValueError,'ORPHAN_READONLY_LEASE_OPERATION_NOT_SIGNED'):
                self.mod.issue_one_root_readonly_qualification_lease(self.handle)
        self.assertNotIn(self.handle,self.live._approved_reviews)

    def test_private_lease_not_copyable_pickleable_or_persistable(self):
        lease=self.issue_fixture()
        for fn in (lambda:copy.copy(lease),lambda:copy.deepcopy(lease),
                   lambda:pickle.dumps(lease,protocol=5)):
            with self.assertRaisesRegex(ValueError,'ORPHAN_READONLY_LEASE_NONTRANSFERABLE'):
                fn()
        from rbridge_installation.orphan_dual_guard_gate import require_qualified_orphan_lease
        # Until the operational guard integration is independently accepted,
        # even a mock-issued instance MUST remain denied by both guard APIs.
        for guard in ('MAINTENANCE_REGISTRY','HELPER_JOURNAL'):
            with self.assertRaises(ValueError):
                require_qualified_orphan_lease(
                    lease,guard=guard,journal_name=self.orphan)
        self.mod.revoke_root_readonly_lease(lease)

    def test_callback_or_json_payload_cannot_substitute_for_approval(self):
        from rbridge_installation.orphan_dual_guard_gate import require_qualified_orphan_lease
        for item in (None,True,{},'PASS',lambda:True,self.snapshot):
            for guard in ('MAINTENANCE_REGISTRY','HELPER_JOURNAL'):
                with self.subTest(item=repr(item)),self.assertRaises(ValueError):
                    require_qualified_orphan_lease(
                        item,guard=guard,journal_name=self.orphan)

if __name__=='__main__':
    unittest.main()
