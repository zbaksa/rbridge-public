import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from _loader import toolkit,ROOT

MARKERS=['QUALIFIED','STAGED','PAUSE_INTENT','PAUSED','BACKUP_COMPLETE','GATES_PASS','CONFIG_INTENT','CONFIG_INSTALLED','POINTER_INTENT','POINTER_SWITCHED','START_ATTEMPTED']
EVIDENCE={k:'1'*64 for k in ['profile_sha256','config_sha256','pointer_sha256','service_identity_sha256','snapshot_sha256','owned_additions_sha256']}

class LedgerTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.ledger import _open_fixture_ledger,recovery_decision,ObservedTransactionState,LedgerError
        except ImportError:self.fail('Persistent intent ledger is not implemented')
        self.open,self.decide,self.Observed,self.error=_open_fixture_ledger,recovery_decision,ObservedTransactionState,LedgerError
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.parent=Path(self.tmp.name);self.parent.chmod(0o700)
        self.fd=os.open(self.parent,os.O_RDONLY|os.O_DIRECTORY);self.addCleanup(os.close,self.fd)
        self.tx='a'*32;self.ledger=self.open(self.fd,self.tx);self.addCleanup(self.ledger.close)
    def tearDown(self):
        if hasattr(self,'ledger'):self.ledger.close()
    def observed(self,**changes):
        values={'config_sha256':'1'*64,'pointer_sha256':'1'*64,'service_identity_sha256':'1'*64,'snapshot_sha256':'1'*64,'owned_additions_sha256':'1'*64,'service_settled':True,'writers_excluded':True,'fresh_gate_status':'PASS','fresh_gate_snapshot_sha256':'1'*64}
        values.update(changes);return self.Observed(**values)
    def fill(self,markers=MARKERS):
        for marker in markers:self.ledger.append(marker,EVIDENCE)
    def test_start_intent_survives_failed_start_and_forbids_old_restore(self):
        self.fill();self.ledger.close();self.ledger=self.open(self.fd,self.tx)
        decision=self.decide(self.ledger.read(),self.observed(service_settled=False))
        self.assertEqual(decision.action,'HOLD_POST_START');self.assertFalse(decision.may_start_old)
    def test_fsync_failure_never_advances_marker(self):
        self.ledger.append('QUALIFIED',EVIDENCE)
        with patch('rbridge_installation.ledger.os.fsync',side_effect=OSError('fixture EIO')):
            with self.assertRaises(self.error):self.ledger.append('STAGED',EVIDENCE)
        with self.assertRaises(self.error):self.ledger.read()
        self.ledger.close();self.ledger=self.open(self.fd,self.tx)
        with self.assertRaises(self.error):self.ledger.read()
        data=json.loads((self.parent/self.tx/'ledger.json').read_text())
        self.assertEqual(data['entries'][-1]['marker'],'QUALIFIED')
    def test_child_death_retains_start_marker_and_pending_never_means_safe(self):
        self.fill(MARKERS[:-1]);self.ledger.close()
        code="""import os,sys
sys.path.insert(0,sys.argv[1])
from rbridge_installation.ledger import _open_fixture_ledger
fd=os.open(sys.argv[2],os.O_RDONLY|os.O_DIRECTORY)
ledger=_open_fixture_ledger(fd,'a'*32)
ledger.append('START_ATTEMPTED',%r)
os.kill(os.getpid(),9)
""" % EVIDENCE
        result=subprocess.run([sys.executable,'-I','-B','-c',code,str(ROOT/'ops/install'),str(self.parent)],timeout=10)
        self.assertEqual(result.returncode,-9)
        self.ledger=self.open(self.fd,self.tx)
        self.assertFalse(self.decide(self.ledger.read(),self.observed()).may_start_old)
    def test_drift_and_unknown_pause_refuse_prestart_restore(self):
        self.fill(MARKERS[:-1])
        valid=self.decide(self.ledger.read(),self.observed())
        self.assertEqual(valid.action,'RESTORE_OWNED_PRE_START');self.assertTrue(valid.may_start_old)
        for changes,action in [({'pointer_sha256':'2'*64},'BLOCKED_DRIFT'),({'service_settled':False},'HOLD_UNSETTLED'),({'fresh_gate_status':'UNKNOWN'},'BLOCKED_DRIFT')]:
            decision=self.decide(self.ledger.read(),self.observed(**changes));self.assertEqual(decision.action,action);self.assertFalse(decision.may_start_old)
    def test_invalid_sequence_or_replaced_record_is_rejected_without_repair(self):
        with self.assertRaises(self.error):self.ledger.append('NEW_STARTED',EVIDENCE)
        self.ledger.append('QUALIFIED',EVIDENCE)
        path=self.parent/self.tx/'ledger.json';before=path.read_bytes()
        modified=json.loads(before);modified['entries'][0]['marker']='START_ATTEMPTED';path.write_text(json.dumps(modified))
        corrupt=path.read_bytes()
        with self.assertRaises(self.error):self.ledger.read()
        self.assertEqual(path.read_bytes(),corrupt)

    def test_terminal_ledger_cannot_reenter_qualification(self):
        self.ledger.append('QUALIFIED',EVIDENCE);self.ledger.append('ROLLBACK_BLOCKED',EVIDENCE)
        with self.assertRaises(self.error):self.ledger.append('QUALIFIED',EVIDENCE)

    def test_existing_only_resume_never_creates_a_missing_transaction_or_lock(self):
        missing='b'*32
        self.assertRaises(self.error,self.open,self.fd,missing,mode='existing_only')
        self.assertFalse((self.parent/missing).exists())
        self.ledger.append('QUALIFIED',EVIDENCE);self.ledger.close()
        raw=(self.parent/self.tx/'ledger.json').read_bytes()
        lock=self.parent/self.tx/'ledger.lock';lock.unlink()
        self.assertRaises(self.error,self.open,self.fd,self.tx,mode='existing_only')
        self.assertFalse(lock.exists());self.assertEqual((self.parent/self.tx/'ledger.json').read_bytes(),raw)

    def test_create_only_preserves_a_collision_and_existing_only_reads_the_same_chain(self):
        self.ledger.append('QUALIFIED',EVIDENCE);self.ledger.close()
        raw=(self.parent/self.tx/'ledger.json').read_bytes()
        self.assertRaises(self.error,self.open,self.fd,self.tx,mode='create_only')
        self.assertEqual((self.parent/self.tx/'ledger.json').read_bytes(),raw)
        self.ledger=self.open(self.fd,self.tx,mode='existing_only')
        self.assertEqual(self.ledger.read().entries[-1].marker,'QUALIFIED')
    def test_forged_snapshot_cannot_restore(self):
        self.fill(MARKERS[:-1]);self.assertTrue(self.decide(self.ledger.read(),self.observed()).may_start_old)
        from dataclasses import replace
        snapshot=self.ledger.read();forged=replace(snapshot,sha256='2'*64)
        decision=self.decide(forged,self.observed())
        self.assertEqual(decision.action,'BLOCKED_DRIFT');self.assertFalse(decision.may_start_old)

    def test_durable_pending_intent_survives_child_death_before_replacement(self):
        self.ledger.append('QUALIFIED',EVIDENCE);self.ledger.close()
        code="""import os,sys
sys.path.insert(0,sys.argv[1])
import rbridge_installation.ledger as m
fd=os.open(sys.argv[2],os.O_RDONLY|os.O_DIRECTORY)
ledger=m._open_fixture_ledger(fd,'a'*32)
actual=m._write_exclusive
def terminate(fd,name,raw,uid):
 if name.startswith('.ledger-'):os.kill(os.getpid(),9)
 return actual(fd,name,raw,uid)
m._write_exclusive=terminate
ledger.append('STAGED',%r)
""" % EVIDENCE
        result=subprocess.run([sys.executable,'-I','-B','-c',code,str(ROOT/'ops/install'),str(self.parent)],timeout=10)
        self.assertEqual(result.returncode,-9)
        self.ledger=self.open(self.fd,self.tx)
        with self.assertRaises(self.error):self.ledger.read()
        self.assertTrue((self.parent/self.tx/'pending.json').exists())

    def test_every_marker_fsync_boundary_blocks_acknowledgement(self):
        from rbridge_installation import ledger as module
        actual=module.os.fsync
        self.ledger.close()
        for failure in range(1,6):
            with self.subTest(failure=failure):
                transaction=f'{failure:032x}';ledger=self.open(self.fd,transaction);ledger.append('QUALIFIED',EVIDENCE)
                count=0
                def fail_sync(fd):
                    nonlocal count
                    count+=1
                    if count==failure:raise OSError('fixture EIO')
                    return actual(fd)
                try:
                    with patch('rbridge_installation.ledger.os.fsync',side_effect=fail_sync):
                        with self.assertRaises(self.error):ledger.append('STAGED',EVIDENCE)
                    with self.assertRaises(self.error):ledger.read()
                finally:ledger.close()

    def test_reopen_missing_lock_does_not_repair_or_reinitialize(self):
        self.ledger.append('QUALIFIED',EVIDENCE);self.ledger.close()
        lock=self.parent/self.tx/'ledger.lock';lock.unlink()
        with self.assertRaises(self.error):self.open(self.fd,self.tx)
        self.assertFalse(lock.exists())
