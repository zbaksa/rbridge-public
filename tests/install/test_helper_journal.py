"""Durable helper history Source fixtures never qualify physical Root origin."""
import copy
import os
from pathlib import Path
import select
import signal
import tempfile
import unittest
from _loader import toolkit


class HelperJournalTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.helper_journal import _open_fixture_helper_journal, inspect_helper_journal
        except ImportError:self.fail('Durable owned-helper intent history is not implemented')
        from rbridge_installation.maintenance_registry import assert_no_unfinished_transactions
        from rbridge_installation.models import encode_report,report_sha256
        self.open,self.inspect,self.check=_open_fixture_helper_journal,inspect_helper_journal,assert_no_unfinished_transactions
        self.encode,self.sha=encode_report,report_sha256
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        os.chmod(self.root,0o700);self.fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY);self.addCleanup(os.close,self.fd)
        self.launch={'argv':['/protected/runuser','--version'],'executable_sha256':'a'*64,
            'input_sha256':'b'*64,'child_specs_sha256':'c'*64}
        self.token={'pid':20,'ppid':10,'session':20,'start_ticks':'100'}

    def test_intent_and_running_without_settlement_block_a_cold_process_without_repair(self):
        journal=self.open(self.fd,'d'*32,self.launch);journal.close()
        path=self.root/('helper-'+'d'*32);before=(path/'intent.json').read_bytes()
        self.assertRaises(ValueError,self.check,self.fd,production=False)
        self.assertEqual((path/'intent.json').read_bytes(),before)
        self.assertFalse((path/'settled.json').exists())
        other=self.open(self.fd,'e'*32,self.launch);other._running(self.token);other.close()
        self.assertRaises(ValueError,self.inspect,self.fd,'helper-'+'e'*32,production=False)
        self.assertFalse((self.root/('helper-'+'e'*32)/'settled.json').exists())

    def test_live_lock_blocks_even_complete_fixture_and_cold_settlement_stays_data_only(self):
        journal=self.open(self.fd,'f'*32,self.launch);self.addCleanup(journal.close)
        journal._running(self.token);journal._settled([{'pid':20,'start_ticks':'100'}])
        self.assertRaises(ValueError,self.check,self.fd,production=False)
        journal.close();proof=self.check(self.fd,production=False)
        self.assertEqual(proof['scope'],'FIXTURE_AUTHORITY_ONLY');self.assertFalse(proof['service_action_authorized'])
        value=self.inspect(self.fd,'helper-'+'f'*32,production=False)
        self.assertEqual(value['origin_scope'],'FIXTURE_AUTHORITY_ONLY')
        self.assertRaises(ValueError,self.inspect,self.fd,'helper-'+'f'*32,production=True)

    def test_missing_lock_broken_chain_or_partial_publication_never_creates_or_repairs(self):
        for i,mutation in enumerate(('missing-lock','broken-chain','partial')):
            with self.subTest(mutation=mutation):
                ident=hex(i+1)[2:]*32;journal=self.open(self.fd,ident,self.launch)
                journal._running(self.token);journal._settled([{'pid':20,'start_ticks':'100'}]);journal.close()
                path=self.root/('helper-'+ident)
                if mutation=='missing-lock':(path/'journal.lock').unlink()
                elif mutation=='partial':(path/'.settled.partial').write_bytes(b'partial')
                else:
                    from rbridge_installation.ledger import _strict_json
                    record=_strict_json((path/'settled.json').read_bytes());record['previous_sha256']='0'*64
                    record['sha256']=self.sha({k:v for k,v in record.items() if k!='sha256'})
                    (path/'settled.json').write_bytes(self.encode(record))
                before={p.name:p.read_bytes() for p in path.iterdir()}
                self.assertRaises(ValueError,self.inspect,self.fd,path.name,production=False)
                self.assertEqual({p.name:p.read_bytes() for p in path.iterdir()},before)

    def test_exclusive_collision_and_replaced_intent_cannot_be_accepted(self):
        journal=self.open(self.fd,'9'*32,self.launch);self.addCleanup(journal.close)
        self.assertRaises(ValueError,self.open,self.fd,'9'*32,self.launch)
        path=self.root/('helper-'+'9'*32)/'intent.json';raw=path.read_bytes();path.unlink();path.write_bytes(raw);os.chmod(path,0o600)
        self.assertRaises(ValueError,journal._running,self.token)
        self.assertFalse(path.with_name('running.json').exists())

    def test_running_identity_and_settlement_set_must_match_the_original_session(self):
        journal=self.open(self.fd,'8'*32,self.launch);self.addCleanup(journal.close)
        for key,value in [('pid',True),('session',21),('start_ticks','0')]:
            bad=copy.deepcopy(self.token);bad[key]=value
            self.assertRaises(ValueError,journal._running,bad)
        journal._running(self.token)
        for rows in ([],[{'pid':20,'start_ticks':'101'}],[{'pid':20,'start_ticks':'100'},{'pid':20,'start_ticks':'100'}]):
            self.assertRaises(ValueError,journal._settled,rows)
        self.assertFalse((self.root/('helper-'+'8'*32)/'settled.json').exists())

    def test_fixture_scope_or_callback_cannot_exempt_an_active_journal(self):
        from rbridge_installation.helper_journal import _current_root_helper
        journal=self.open(self.fd,'7'*32,self.launch);self.addCleanup(journal.close)
        journal._running(self.token,lambda:True)
        self.assertFalse(_current_root_helper(self.fd,journal.name))
        self.assertRaises(ValueError,self.check,self.fd,production=False)

    def test_real_foreground_sigkill_preserves_each_durable_boundary(self):
        for i,phase in enumerate(('INTENT','RUNNING','SETTLED')):
            with self.subTest(phase=phase):
                ident=str(i+4)*32;read,write=os.pipe();pid=os.fork()
                if pid==0:
                    try:
                        os.close(read);journal=self.open(self.fd,ident,self.launch)
                        if phase!='INTENT':journal._running(self.token)
                        if phase=='SETTLED':journal._settled([{'pid':20,'start_ticks':'100'}])
                        os.write(write,b'READY');signal.pause()
                    finally:os._exit(2)
                os.close(write)
                try:
                    self.assertTrue(select.select([read],[],[],10)[0],'Child did not reach durable boundary')
                    self.assertEqual(os.read(read,5),b'READY')
                    path=self.root/('helper-'+ident);before={p.name:p.read_bytes() for p in path.iterdir()}
                finally:
                    os.close(read);os.kill(pid,signal.SIGKILL);_,status=os.waitpid(pid,0)
                self.assertTrue(os.WIFSIGNALED(status));self.assertEqual(os.WTERMSIG(status),signal.SIGKILL)
                if phase=='SETTLED':
                    value=self.inspect(self.fd,path.name,production=False)
                    self.assertEqual(value['origin_scope'],'FIXTURE_AUTHORITY_ONLY')
                else:self.assertRaises(ValueError,self.inspect,self.fd,path.name,production=False)
                self.assertEqual({p.name:p.read_bytes() for p in path.iterdir()},before)


if __name__=='__main__':unittest.main()
