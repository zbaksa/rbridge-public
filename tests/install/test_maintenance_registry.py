"""Cold full-parent inventory fixtures; no live host maintenance authority."""
import os
from pathlib import Path
import tempfile
import unittest
from _loader import toolkit


class MaintenanceRegistryTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.maintenance_registry import assert_no_unfinished_transactions
        except ImportError:self.fail('Cold global maintenance guard is not implemented')
        from rbridge_installation.ledger import _open_fixture_ledger,MARKERS
        self.check,self.open,self.markers=assert_no_unfinished_transactions,_open_fixture_ledger,MARKERS
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        os.chmod(self.root,0o700);self.fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY);self.addCleanup(os.close,self.fd)

    def test_dead_predecessor_start_marker_blocks_a_different_transaction(self):
        previous=self.open(self.fd,'a'*32)
        for marker in self.markers[:11]:previous.append(marker,{})
        previous.close()
        self.assertRaisesRegex(ValueError,'UNFINISHED',self.check,self.fd,production=False)
        self.assertTrue((self.root/('a'*32)/'ledger.json').exists())

    def test_live_peer_lock_empty_ledger_and_corrupt_chain_are_never_ignored(self):
        previous=self.open(self.fd,'b'*32)
        self.assertRaises(ValueError,self.check,self.fd,production=False)
        previous.close();self.assertRaises(ValueError,self.check,self.fd,production=False)
        path=self.root/('b'*32)/'ledger.json';path.write_bytes(b'{"schema":"broken"}')
        self.assertRaises(ValueError,self.check,self.fd,production=False)
        self.assertEqual(path.read_bytes(),b'{"schema":"broken"}')

    def test_current_owned_ledger_and_completed_fixture_are_separate_from_unknown_objects(self):
        current=self.open(self.fd,'c'*32);self.addCleanup(current.close)
        current.append('QUALIFIED',{});current.append('STAGED',{})
        proof=self.check(self.fd,current,production=False)
        self.assertEqual(proof['scope'],'FIXTURE_AUTHORITY_ONLY');self.assertFalse(proof['service_action_authorized'])
        (self.root/'.unfinished-helper').write_bytes(b'retained')
        self.assertRaises(ValueError,self.check,self.fd,current,production=False)
        self.assertEqual((self.root/'.unfinished-helper').read_bytes(),b'retained')

    def test_complete_peer_fixture_never_becomes_a_production_origin(self):
        previous=self.open(self.fd,'d'*32)
        for marker in self.markers:previous.append(marker,{})
        previous.close();proof=self.check(self.fd,production=False)
        self.assertEqual(proof['transactions'],['d'*32]);self.assertFalse(proof['service_action_authorized'])
        self.assertRaises(ValueError,self.check,self.fd,production=True)


if __name__=='__main__':unittest.main()
