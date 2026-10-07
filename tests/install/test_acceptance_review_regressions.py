"""Review regressions use actual Source contracts and current-user mechanics."""
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from _loader import toolkit,ROOT
from _fixtures import valid_profile
from test_pause_backup import FixtureHost,FixtureLedger

toolkit()
from rbridge_installation.profile import parse_profile
from rbridge_installation.models import encode_report


class AcceptanceIntentRegressionTests(unittest.TestCase):
    def test_mcp_expectations_match_actual_core_intent_digest_for_both_operations(self):
        from rbridge_installation.acceptance_transport import QualifiedAcceptanceBackend
        p=parse_profile(valid_profile());source=SimpleNamespace(profile=p)
        operations=({'kind':'HEALTH','action':'STATUS'},
            {'kind':'FILE','action':'READ','target':p.paths.canary_path,'args':{}})
        code=('import {rbridgeOperationIntentDigest} from '+json.dumps((ROOT/'src/domain/rbridgeExecutionContract.ts').as_uri())+
            ';let raw="";for await(const part of process.stdin)raw+=part;console.log(rbridgeOperationIntentDigest(JSON.parse(raw)));')
        for index,operation in enumerate(operations):
            request={'requestId':'source-acceptance-'+str(index),'operation':operation}
            submission={'schema':'RBRIDGE_OPERATION_SUBMISSION_V1','operationId':request['requestId'],
                'principalId':p.binding.principal_id,'targetInstanceId':p.binding.target_instance_id,'operation':operation}
            run=subprocess.run(['node','--import','tsx','--input-type=module','-e',code],input=encode_report(submission),
                capture_output=True,timeout=10,cwd=ROOT)
            self.assertEqual(run.returncode,0,run.stderr.decode())
            expected=QualifiedAcceptanceBackend._mcp_expectation(source,request)
            self.assertEqual(expected['intent_sha256'],run.stdout.decode().strip())
            other=QualifiedAcceptanceBackend._mcp_expectation(source,{**request,'requestId':'another-source-id'})
            self.assertEqual(expected['intent_sha256'],other['intent_sha256'])
            self.assertNotEqual(expected['operationId'],other['operationId'])


class RetainedCanaryRegressionTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation.acceptance_transport import _observe_fixture_canary
        except ImportError:self.fail('Existing qualified canary cannot be observed without recreation')
        self.observe=_observe_fixture_canary;self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.parent=Path(self.temp.name);self.parent.chmod(0o700);self.path=self.parent/'canary.txt';self.data=b'known Source canary\n'
        self.path.write_bytes(self.data);self.path.chmod(0o444)

    def test_existing_qualified_bytes_and_identity_are_retained_without_create_or_chmod(self):
        before=self.path.stat();canary=self.observe(self.path,self.data);self.addCleanup(canary.close)
        report=canary.readback();after=self.path.stat()
        for key in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns'):
            self.assertEqual(getattr(before,key),getattr(after,key))
        self.assertEqual(report['sha256'],hashlib.sha256(self.data).hexdigest());self.assertEqual(report['mode'],0o444)
        self.assertEqual(self.path.read_bytes(),self.data)

    def test_missing_symlink_hardlink_wrong_bytes_and_named_replacement_refuse_without_overwrite(self):
        self.assertRaises(ValueError,self.observe,self.parent/'absent',self.data);self.assertFalse((self.parent/'absent').exists())
        link=self.parent/'link';link.symlink_to(self.path);self.assertRaises(ValueError,self.observe,link,self.data)
        self.assertRaises(ValueError,self.observe,self.path,b'changed Source bytes');self.assertEqual(self.path.read_bytes(),self.data)
        hard=self.parent/'hard';os.link(self.path,hard);self.assertRaises(ValueError,self.observe,self.path,self.data);hard.unlink()
        canary=self.observe(self.path,self.data);self.addCleanup(canary.close)
        self.path.unlink();self.path.write_bytes(self.data);self.path.chmod(0o444)
        self.assertRaises(ValueError,canary.readback)


class RestartSnapshotRegressionTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation.acceptance_transport import retain_acceptance_restart_snapshot
        except ImportError:self.fail('Controlled restart still attempts pre-start backup publication')
        from rbridge_installation.pause_backup import maintain_pause,capture_snapshot,backup_snapshot
        self.retain=retain_acceptance_restart_snapshot;self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.parent=Path(self.temp.name);self.state=self.parent/'state';self.state.mkdir(mode=0o700)
        self.record=self.state/'record';self.record.write_bytes(b'before start')
        p=parse_profile(valid_profile());self.p=replace(p,binding=replace(p.binding,uid=os.getuid(),gid=os.getgid()),
            paths=replace(p.paths,state_root=str(self.state),lock_path=str(self.parent/'lock')))
        self.ledger=FixtureLedger();self.host=FixtureHost(self.p);self.lease=maintain_pause(self.p,self.host,self.ledger)
        self.addCleanup(self.lease.close);destination=self.parent/'backups';destination.mkdir(mode=0o700)
        fd=os.open(destination,os.O_RDONLY|os.O_DIRECTORY)
        try:self.original=backup_snapshot(capture_snapshot(self.lease),fd)
        finally:os.close(fd)
        self.manifest=destination/self.original.directory/'manifest.json';self.saved=self.manifest.read_bytes()
        self.ledger.markers.append('ACCEPTING');self.record.write_bytes(b'post start Core state')

    def test_restart_retains_full_current_snapshot_and_never_republishes_original_backup(self):
        rows=[];evidence=SimpleNamespace(write=lambda name,value:rows.append((name,value)));markers=tuple(self.ledger.markers)
        report=self.retain(self.lease,evidence)
        self.assertEqual(tuple(self.ledger.markers),markers);self.assertEqual(self.manifest.read_bytes(),self.saved)
        self.assertEqual(report['snapshot']['scope'],'FIXTURE_AUTHORITY_ONLY')
        self.assertEqual(report['snapshot']['entries'][0]['sha256'],hashlib.sha256(self.record.read_bytes()).hexdigest())
        self.assertFalse(report['pre_start_backup_republished']);self.assertEqual(rows,[('accept-restart-paused',report)])

    def test_concurrent_state_change_or_unsettled_writer_refuses_before_restart(self):
        def change(_name,_value):self.record.write_bytes(b'concurrent change')
        self.assertRaisesRegex(ValueError,'ACCEPTANCE_RESTART_SNAPSHOT_CHANGED',self.retain,self.lease,SimpleNamespace(write=change))
        self.host.writer=True
        self.assertRaises(ValueError,self.retain,self.lease,SimpleNamespace(write=lambda *_:None))
        self.assertEqual(self.manifest.read_bytes(),self.saved)


if __name__=='__main__':unittest.main()
