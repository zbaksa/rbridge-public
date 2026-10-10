"""Source fixture storage is create-once and never grants Root authority."""
import os
from pathlib import Path
import tempfile
import unittest
from _loader import toolkit
from test_orphan_intent_review_packet import OrphanReviewPacketTests

class OrphanSourceFixtureTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_source_fixture_store import (
            append_source_orphan_fixture,read_source_orphan_fixture)
        self.peer=OrphanReviewPacketTests('test_exact_claim_is_only_unverified_data')
        self.peer.setUp()
        self.append=append_source_orphan_fixture
        self.read=read_source_orphan_fixture
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.root.chmod(0o700)
        self.fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        self.addCleanup(os.close,self.fd)

    def test_create_once_is_unqualified(self):
        value=self.append(self.fd,self.peer.observation,self.peer.claim)
        self.assertEqual(value['status'],'STORED_UNQUALIFIED')
        self.assertIs(value['owner_authenticated'],False)
        self.assertIs(value['may_launch'],False)
        self.assertIs(value['may_resume_qualification'],False)
        self.assertEqual(self.read(self.fd,value['name'],value['sha256']),value)

    def test_duplicate_is_rejected(self):
        value=self.append(self.fd,self.peer.observation,self.peer.claim)
        before=(self.root/value['name']).read_bytes()
        with self.assertRaises(ValueError):
            self.append(self.fd,self.peer.observation,self.peer.claim)
        self.assertEqual((self.root/value['name']).read_bytes(),before)

    def test_unqualified_parent_refused(self):
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            self.append(self.fd,self.peer.observation,self.peer.claim)
        self.assertEqual(list(self.root.iterdir()),[])

    def test_owner_claim_cannot_override_authority(self):
        bad=dict(self.peer.claim)
        bad['decision']='APPROVE_RESTART'
        with self.assertRaises(ValueError):
            self.append(self.fd,self.peer.observation,bad)
        self.assertEqual(list(self.root.iterdir()),[])

if __name__=='__main__':
    unittest.main()
