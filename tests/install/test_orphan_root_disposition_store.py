"""Protected Root orphan writer is non-authorizing and preserves journal identity."""
import copy
import os
from pathlib import Path
import tempfile
import unittest
from _loader import toolkit

class OrphanProtectedRootStoreTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_root_disposition_store import (
            _record,_check_journal,_signature,append_root_orphan_review)
        self.record=_record
        self.check=_check_journal
        self.signature=_signature
        self.append=append_root_orphan_review
        self.name='helper-0b84e8af62a287a283eabcd4eef1cdb7'
        self.sha='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'
        self.preimage={
            'schema':'RBRIDGE_ORPHAN_PROTECTED_DISPOSITION_PREIMAGE_V1',
            'status':'INTENT_ONLY_UNRESOLVED_REVIEWED',
            'scope':'SERIALIZED_PREIMAGE_ONLY',
            'journal_name':self.name,
            'intent_sha256':self.sha,
            'owner_authenticated':False,'root_provenance_verified':False,
            'journal_settled':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
        self.origin='toolkit-'+'1'*40
        self.original=(1,2,3,4,5,6,7,8,9)

    def test_pure_root_record_still_has_no_operational_rights(self):
        record=self.record(self.preimage,self.origin,self.original)
        self.assertEqual(record['status'],'ROOT_RECORD_ONLY_INTENT_UNRESOLVED')
        self.assertEqual(record['historical_result'],'UNKNOWN')
        self.assertEqual(record['historical_execution'],'UNKNOWN')
        for k in ('owner_authenticated','journal_settled','may_settle',
                  'may_launch','may_resume_qualification','may_change_production'):
            self.assertIs(record[k],False)

    def test_misbound_or_authorized_preimages_refused(self):
        for key,value in (
            ('journal_name','helper-'+'2'*32),('intent_sha256','0'*64),
            ('status','SETTLED'),('scope','ROOT_AUTHORIZED'),
            ('may_launch',True),('may_resume_qualification',True),
            ('root_provenance_verified',True),('journal_settled',True)):
            with self.subTest(key=key):
                bad=copy.deepcopy(self.preimage);bad[key]=value
                with self.assertRaises(ValueError):
                    self.record(bad,self.origin,self.original)

    def test_unknown_root_source_or_identity_refused(self):
        for source in ('user-owned','toolkit-unsafe','toolkit-'+'x'*40):
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    self.record(self.preimage,source,self.original)
        with self.assertRaises(ValueError):
            self.record(self.preimage,self.origin,(1,2,3))

    def test_nonroot_may_never_open_the_root_store(self):
        if os.getuid()!=0:
            with self.assertRaisesRegex(ValueError,'ORPHAN_ROOT_STORE_ROOT_REQUIRED'):
                self.append({'unexpected':'owner-claim'})

    def test_intent_metadata_is_pinned_across_a_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'intent.json').write_bytes(b'intent')
            (p/'journal.lock').write_bytes(b'')
            fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            lock=os.open(p/'journal.lock',os.O_RDONLY|os.O_NOFOLLOW)
            try:
                before=os.fstat(fd);original=self.signature(os.stat(p/'intent.json'))
                lock_before=os.fstat(lock)
                self.assertIsNone(self.check(fd,before,lock,lock_before,original))
                os.utime(p/'intent.json',ns=(0,0))
                with self.assertRaisesRegex(ValueError,'ORPHAN_ROOT_STORE_JOURNAL_CHANGED'):
                    self.check(fd,before,lock,lock_before,original)
            finally:
                os.close(lock);os.close(fd)

    def test_new_member_invalidates_retained_directory_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'intent.json').write_bytes(b'intent')
            (p/'journal.lock').write_bytes(b'')
            fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            lock=os.open(p/'journal.lock',os.O_RDONLY|os.O_NOFOLLOW)
            try:
                before=os.fstat(fd);original=self.signature(os.stat(p/'intent.json'))
                lock_before=os.fstat(lock)
                (p/'settled.json').write_bytes(b'forged')
                with self.assertRaises(ValueError):
                    self.check(fd,before,lock,lock_before,original)
            finally:os.close(lock);os.close(fd)

if __name__=='__main__':
    unittest.main()
