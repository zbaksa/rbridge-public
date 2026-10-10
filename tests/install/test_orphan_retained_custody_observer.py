"""Retained-custody observer never converts physical Root proof to admission."""
import copy
import hashlib
import unittest

from _loader import toolkit
import test_orphan_root_custody as fixtures

class OrphanRetainedCustodyObserverTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_retained_custody_observer import (
            compare_retained_custody_data,observe_protected_retained_custody)
        from rbridge_installation.orphan_root_disposition_store import INTENT_SHA
        self.compare=compare_retained_custody_data
        self.observe=observe_protected_retained_custody
        other=fixtures.OrphanRootCustodyTests('test_full_canonical_preimage_survives_readback')
        other.setUp()
        self.fixture=other
        self.raw=other.encode(other.bundle())
        self.digest=hashlib.sha256(self.raw).hexdigest()
        self.source='1'*40
        self.original=(1,2,0o100600,0,0,1,789,456,123)
        self.intent=INTENT_SHA
        self.children=['intent.json','journal.lock']

    def check(self,*,raw=None,digest=None,source=None,intent=None,
              original=None,children=None):
        return self.compare(
            self.raw if raw is None else raw,
            self.digest if digest is None else digest,
            self.source if source is None else source,
            self.intent if intent is None else intent,
            self.original if original is None else original,
            self.children if children is None else children)

    def test_data_and_exact_old_intent_bind_without_qualification(self):
        row=self.check()
        self.assertEqual(row['status'],'CANONICAL_INTENT_AND_CUSTODY_DATA_MATCH_ONLY')
        self.assertEqual(row['custody_sha256'],self.digest)
        self.assertTrue(row['original_journal_data_matches'])
        self.assertEqual(row['historical_execution'],'UNKNOWN')
        self.assertEqual(row['historical_result'],'UNKNOWN')
        for key in ('source_provenance_verified','owner_authenticated',
                    'journal_settled','may_settle','may_launch',
                    'may_resume_qualification','may_change_production'):
            self.assertIs(row[key],False)

    def test_reject_different_intent_or_journal_children(self):
        for changes in (
            {'intent':'0'*64},
            {'children':['intent.json','journal.lock','settled.json']},
            {'children':['intent.json']},
            {'children':['journal.lock','intent.json']},
            {'children':[]},
            {'original':(1,2,0o100600,0,0,1,789,456,124)},
            {'original':(1,2,0o100600,0,0,1,789,456)},
            {'original':(1,2,0o100600,True,0,1,789,456,123)},
        ):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                self.check(**changes)

    def test_wrong_source_or_digest_never_grants(self):
        for changes in (
            {'source':'2'*40},
            {'source':'user-owned'},
            {'digest':'f'*64},
            {'digest':'000'},
            {'raw':self.raw+b' '},
            {'raw':self.raw[:-3]},
        ):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                self.check(**changes)

    def test_reject_serialized_forged_history_and_permission(self):
        for key,val in (
            ('historical_result','SUCCESS'),
            ('historical_execution','PASSED'),
            ('owner_authenticated',True),
            ('may_launch',True),
            ('may_resume_qualification',True),
        ):
            v=copy.deepcopy(self.fixture.bundle())
            v[key]=val
            with self.subTest(field=key),self.assertRaises(ValueError):
                self.check(raw=self.fixture.encode(v))

    def test_sudo_uid0_tty_data_still_cannot_mint_lease(self):
        other=copy.deepcopy(self.fixture.bundle())
        # Update each hash in the canonical chain by reconstructing the record.
        other['tty_review']['tty_device_uid']=0
        from rbridge_installation.orphan_disposition_preimage import disposition_preimage
        from rbridge_installation.orphan_root_disposition_store import _record
        preimage=disposition_preimage(
            other['observation'],other['owner_claim'],
            other['tty_review'],other['kernel_census'])
        record=_record(preimage,'toolkit-'+self.source,self.original)
        other['preimage']=preimage
        other['record']=record
        raw=self.fixture.encode(other)
        receipt=self.check(raw=raw,digest=hashlib.sha256(raw).hexdigest())
        self.assertEqual(receipt['status'],'CANONICAL_INTENT_AND_CUSTODY_DATA_MATCH_ONLY')
        self.assertIs(receipt['owner_authenticated'],False)
        self.assertIs(receipt['may_resume_qualification'],False)

    def test_protected_reader_refuses_nonroot_even_with_valid_data(self):
        import os
        if os.getuid()!=0:
            with self.assertRaisesRegex(ValueError,'ORPHAN_RETAINED_ROOT_CONTEXT_REQUIRED'):
                self.observe(self.digest,self.source)

if __name__=='__main__':
    unittest.main()
