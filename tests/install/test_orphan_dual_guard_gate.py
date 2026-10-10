"""Two existing operative guards accept no fabricated orphan qualification leases."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch,Mock

from _loader import toolkit

class OrphanDualGuardFailClosedTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_dual_guard_gate import (
            ORPHAN_NAME,require_qualified_orphan_lease)
        self.orphan=ORPHAN_NAME
        self.review=require_qualified_orphan_lease

    def test_matching_intent_hash_or_signed_data_never_mints_admission(self):
        from rbridge_installation.orphan_dual_guard_gate import ORPHAN_INTENT_SHA256
        candidates=[
            {'journal_name':self.orphan,'intent_sha256':ORPHAN_INTENT_SHA256,
             'owner_authenticated':True,'may_launch':True},
            {'status':'ROOT_DATA_ONLY_STORED'},
            {'status':'ONE_USE_SIGNED_CHALLENGE_DATA_ONLY'},
            ['RBRIDGE_LEASE_PASS'], 'PASS',b'PASS',123,
            object(),lambda:True,
        ]
        for candidate in candidates:
            for stage in ('MAINTENANCE_REGISTRY','HELPER_JOURNAL'):
                with self.subTest(candidate=repr(candidate),stage=stage):
                    with self.assertRaisesRegex(
                            ValueError,'ORPHAN_GUARD_ISSUER_NOT_IMPLEMENTED'):
                        self.review(candidate,guard=stage,journal_name=self.orphan)

    def test_scope_and_other_journal_rejected_first(self):
        with self.assertRaisesRegex(ValueError,'ORPHAN_GUARD_SCOPE_INVALID'):
            self.review(object(),guard='SERVICE_RESTART',journal_name=self.orphan)
        with self.assertRaisesRegex(ValueError,'ORPHAN_GUARD_TARGET_INVALID'):
            self.review(object(),guard='HELPER_JOURNAL',
                        journal_name='helper-'+'f'*32)
        with self.assertRaisesRegex(ValueError,'ORPHAN_GUARD_LEASE_MISSING'):
            self.review(None,guard='MAINTENANCE_REGISTRY',
                        journal_name=self.orphan)

    def test_cold_registry_still_rejects_unsettled_fixture_without_repairs(self):
        from rbridge_installation.helper_journal import _open_fixture_helper_journal
        from rbridge_installation.maintenance_registry import (
            assert_no_unfinished_transactions)
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);p.chmod(0o700)
            fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:
                launch={'argv':['/protected/readonly'],
                    'executable_sha256':'a'*64,'input_sha256':'b'*64,
                    'child_specs_sha256':'c'*64}
                j=_open_fixture_helper_journal(fd,'a'*32,launch)
                j.close()
                journal=p/('helper-'+'a'*32)/'intent.json'
                before=journal.read_bytes()
                with self.assertRaises(ValueError):
                    assert_no_unfinished_transactions(fd,production=False)
                with self.assertRaisesRegex(
                        ValueError,'ORPHAN_GUARD_ISSUER_NOT_IMPLEMENTED'):
                    assert_no_unfinished_transactions(
                        fd,production=False,orphan_lease={'may_launch':True})
                self.assertEqual(journal.read_bytes(),before)
                self.assertFalse(journal.with_name('settled.json').exists())
            finally:
                os.close(fd)

    def test_root_helper_candidate_rejected_before_any_journal_or_popen(self):
        from rbridge_installation import helper_journal as helper
        from rbridge_installation import owned_process as owned
        data={'status':'SIGNATURE_VALID_ONLY'}
        with patch.object(helper.os,'getuid',return_value=0), \
             patch.object(helper.os,'geteuid',return_value=0), \
             patch('rbridge_installation.host_backend._assert_kernel_namespace'), \
             patch('rbridge_installation.helper_journal.ProtectedParent') as parent:
            with self.assertRaisesRegex(
                    ValueError,'ORPHAN_GUARD_ISSUER_NOT_IMPLEMENTED'):
                helper.begin_root_helper(
                    None,(),b'',(),orphan_lease=data)
            parent.assert_not_called()
        with patch.object(owned.os,'getuid',return_value=0), \
             patch.object(owned.os,'geteuid',return_value=0), \
             patch.object(owned,'_assert_kernel_namespace'), \
             patch.object(owned.subprocess,'Popen') as launch:
            with self.assertRaisesRegex(
                    ValueError,'ORPHAN_GUARD_ISSUER_NOT_IMPLEMENTED'):
                owned.run_owned_process(
                    None,(),1000,4096,orphan_lease=data)
            launch.assert_not_called()

if __name__=='__main__':
    unittest.main()
