"""Cold INTENT is useful for review, never helper admission."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from _loader import toolkit

class ReadonlyOrphanReviewTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation import orphan_intent_review as review
        from rbridge_installation.helper_journal import (
            _open_fixture_helper_journal,inspect_helper_journal)
        self.review=review
        self.old=inspect_helper_journal
        self.open=_open_fixture_helper_journal
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.root.chmod(0o700)
        self.fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        self.addCleanup(os.close,self.fd)
        self.name='helper-'+'b'*32
        self.launch={
            'argv':list(review.READONLY_ARGV),
            'executable_sha256':review.READONLY_EXE_SHA,
            'input_sha256':review.EMPTY_INPUT_SHA,
            'child_specs_sha256':review.EMPTY_CHILD_SPECS_SHA}
        journal=self.open(self.fd,'b'*32,self.launch)
        journal.close()
        self.path=self.root/self.name
        self.raw=(self.path/'intent.json').read_bytes()
        self.pin=hashlib.sha256(self.raw).hexdigest()

    def check(self,pin=None,name=None):
        return self.review.inspect_readonly_orphan_intent(
            self.fd,name or self.name,pin or self.pin,production=False)

    def test_intent_only_stays_unknown_and_no_authority(self):
        before={p.name:p.read_bytes() for p in self.path.iterdir()}
        report=self.check()
        self.assertEqual(report['status'],'INTENT_ONLY_UNRESOLVED')
        self.assertEqual(report['historical_execution'],'UNKNOWN')
        self.assertEqual(report['scope'],'FIXTURE_DATA_ONLY')
        for flag in ('may_launch','may_settle','may_resume_qualification','may_change_production'):
            self.assertIs(report[flag],False)
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.path.iterdir()})
        with self.assertRaises(ValueError):
            self.old(self.fd,self.name,production=False)

    def test_wrong_digest_is_rejected(self):
        with self.assertRaises(ValueError):
            self.check(pin='0'*64)

    def test_non_matching_command_is_rejected(self):
        name='helper-'+'c'*32
        journal=self.open(self.fd,'c'*32,{**self.launch,
            'argv':['/usr/bin/systemctl','show','different.service']})
        journal.close()
        digest=hashlib.sha256((self.root/name/'intent.json').read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'ORPHAN_REVIEW_COMMAND_NOT_READONLY_PINNED'):
            self.check(digest,name)

    def test_unexpected_journal_member_is_rejected(self):
        (self.path/'unexpected.txt').write_bytes(b'fixture')
        with self.assertRaisesRegex(ValueError,'ORPHAN_REVIEW_NOT_INTENT_ONLY'):
            self.check()

if __name__=='__main__':
    unittest.main()
