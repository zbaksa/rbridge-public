from dataclasses import replace
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

class FixtureLedger:
    def __init__(self):self.transaction_id='a'*32;self.markers=[]
    def append(self,marker,evidence):self.markers.append(marker)

class FixtureHost:
    scope='FIXTURE_AUTHORITY_ONLY'
    def __init__(self,profile,writer=False):self.profile=profile;self.writer=writer;self.old_start_called=False;self.stopped=False
    def capture_service(self,profile):return {'scope':self.scope,'identity_sha256':profile.service.identity_sha256,'config_sha256':'2'*64,'invocation_sha256':'3'*64}
    def stop_unit(self,unit):self.stopped=True
    def observe_pause(self,profile):return {'scope':self.scope,'service_identity_sha256':profile.service.identity_sha256,'active_state':'inactive','main_pid':0,'cgroup_pids':[17] if self.writer else [],'unclassified_same_uid':[],'alternate_writers':[],'supervisors':[],'admissions_closed':True}

class PauseBackupTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.pause_backup import maintain_pause,capture_snapshot,backup_snapshot,PauseError
        except ImportError:self.fail('Maintained pause and full snapshot are not implemented')
        from rbridge_installation.profile import parse_profile
        self.pause,self.capture,self.backup,self.error=maintain_pause,capture_snapshot,backup_snapshot,PauseError
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.state=self.root/'state';self.state.mkdir(mode=0o700)
        p=parse_profile(valid_profile())
        self.profile=replace(p,binding=replace(p.binding,uid=os.getuid(),gid=os.getgid()),paths=replace(p.paths,state_root=str(self.state),lock_path=str(self.root/'maintenance.lock')))
        self.ledger=FixtureLedger();self.host=FixtureHost(self.profile)
    def lease(self):
        lease=self.pause(self.profile,self.host,self.ledger);self.addCleanup(lease.close);return lease
    def test_unsettled_cgroup_or_alternate_writer_blocks_snapshot(self):
        self.host.writer=True
        with self.assertRaises(self.error):self.lease()
        self.assertFalse(self.host.old_start_called);self.assertEqual(self.ledger.markers,['PAUSE_INTENT'])
    def test_backup_preserves_two_link_evidence_and_unknown_names(self):
        directory=self.state/'flowpilot';directory.mkdir(mode=0o700)
        (directory/'claimed.json').write_bytes(b'{"fixture":"claimed"}')
        os.link(directory/'claimed.json',directory/'completed.json')
        (self.state/'unknown-binary').write_bytes(b'\x00\xff evidence')
        lease=self.lease();snapshot=self.capture(lease)
        before=snapshot.tree_sha256
        backup=self.root/'backup';backup.mkdir(mode=0o700);fd=os.open(backup,os.O_RDONLY|os.O_DIRECTORY)
        try:proof=self.backup(snapshot,fd)
        finally:os.close(fd)
        self.assertEqual(proof.status,'PASS');self.assertEqual(self.capture(lease).tree_sha256,before)
        target=backup/proof.directory/'tree'
        self.assertEqual((target/'unknown-binary').read_bytes(),b'\x00\xff evidence')
        self.assertEqual((target/'flowpilot/claimed.json').stat().st_ino,(target/'flowpilot/completed.json').stat().st_ino)
        self.assertEqual((target/'flowpilot/claimed.json').stat().st_nlink,2)
    def test_mutation_or_lost_pause_prevents_backup_without_removal(self):
        (self.state/'record.json').write_text('before');lease=self.lease();snapshot=self.capture(lease)
        (self.state/'record.json').write_text('after');backup=self.root/'backup';backup.mkdir(mode=0o700);fd=os.open(backup,os.O_RDONLY|os.O_DIRECTORY)
        try:
            with self.assertRaises(self.error):self.backup(snapshot,fd)
        finally:os.close(fd)
        self.assertEqual((self.state/'record.json').read_text(),'after');self.assertFalse(self.host.old_start_called)
        self.host.writer=True
        with self.assertRaises(self.error):self.capture(lease)
    def test_fifo_and_external_hardlink_are_captured_but_never_read_or_backed_up(self):
        os.mkfifo(self.state/'unknown-fifo');(self.state/'record').write_text('retained');os.link(self.state/'record',self.root/'external')
        snapshot=self.capture(self.lease())
        self.assertIn('STATE_SPECIAL_OBJECT',snapshot.reason_codes);self.assertIn('STATE_EXTERNAL_HARDLINK',snapshot.reason_codes)
        backup=self.root/'backup';backup.mkdir(mode=0o700);fd=os.open(backup,os.O_RDONLY|os.O_DIRECTORY)
        try:
            with self.assertRaises(self.error):self.backup(snapshot,fd)
        finally:os.close(fd)
        self.assertTrue((self.state/'unknown-fifo').exists());self.assertEqual((self.state/'record').read_text(),'retained')

    def test_backup_restores_captured_access_time_after_its_own_verification_reads(self):
        file=self.state/'record';file.write_text('retained')
        os.utime(file,ns=(1600000000000000000,1600000000000000000))
        lease=self.lease();snapshot=self.capture(lease);entry=next(e for e in snapshot.entries if e.path=='record')
        backup=self.root/'backup';backup.mkdir(mode=0o700);fd=os.open(backup,os.O_RDONLY|os.O_DIRECTORY)
        try:proof=self.backup(snapshot,fd)
        finally:os.close(fd)
        saved=backup/proof.directory/'tree'/'record'
        self.assertEqual(saved.stat().st_atime_ns,int(entry.atime_ns));self.assertEqual(saved.stat().st_mtime_ns,int(entry.mtime_ns))

    def test_hardlink_access_metadata_is_captured_once_per_inode(self):
        (self.state/'a').write_text('shared');os.link(self.state/'a',self.state/'b')
        os.utime(self.state/'a',ns=(1600000000000000000,1600000000000000000))
        snapshot=self.capture(self.lease())
        self.assertEqual({e.atime_ns for e in snapshot.entries if e.kind=='FILE'},{'1600000000000000000'})

    def test_callback_cannot_claim_production_pause_qualification(self):
        self.host.scope='QUALIFIED_HOST_PAUSE'
        with self.assertRaises(self.error):self.lease()
        self.assertFalse(self.host.stopped)

    def test_backup_manifest_readback_refuses_corruption_before_or_after_publication(self):
        from rbridge_installation import pause_backup as module
        for after_publish in (False,True):
            with self.subTest(after_publish=after_publish):
                lease=self.lease();snapshot=self.capture(lease)
                parent=self.root/('backup-'+str(after_publish));parent.mkdir(mode=0o700)
                fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
                original=module._rename_exclusive if after_publish else module._verify_backup
                def corrupt(*args):
                    result=original(*args)
                    manifest=next(parent.glob('*/manifest.json'));manifest.write_bytes(b'changed manifest')
                    return result
                try:
                    with patch.object(module,'_rename_exclusive' if after_publish else '_verify_backup',side_effect=corrupt):
                        with self.assertRaises(self.error):self.backup(snapshot,fd)
                finally:os.close(fd);lease.close()
                self.assertNotIn('BACKUP_COMPLETE',self.ledger.markers)
                self.assertTrue(next(parent.glob('*/manifest.json')).exists())

    def test_independent_backup_directory_descriptor_refuses_replacement_during_open(self):
        from rbridge_installation import pause_backup as module
        nested=self.state/'nested';nested.mkdir(mode=0o700);(nested/'record').write_text('retained')
        lease=self.lease();snapshot=self.capture(lease);parent=self.root/'backup';parent.mkdir(mode=0o700)
        fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
        try:proof=self.backup(snapshot,fd)
        finally:os.close(fd)
        tree=parent/proof.directory/'tree';root_fd=os.open(tree,os.O_RDONLY|os.O_DIRECTORY)
        original=module.os.open;replaced=[]
        def swap(name,flags,*args,**kwargs):
            if name=='nested' and kwargs.get('dir_fd')==root_fd and not replaced:
                (tree/'nested').rename(self.root/'retained-backup-directory')
                (tree/'nested').mkdir(mode=0o700);(tree/'nested/record').write_text('retained')
                os.chmod(tree/'nested/record',0o600);replaced.append(True)
            return original(name,flags,*args,**kwargs)
        try:
            with patch.object(module.os,'open',side_effect=swap):
                with self.assertRaises(self.error):module._verify_backup(root_fd,snapshot)
        finally:os.close(root_fd)
        self.assertEqual((self.root/'retained-backup-directory/record').read_text(),'retained')

    def test_published_backup_full_bytes_are_rechecked_before_completion(self):
        from rbridge_installation import pause_backup as module
        (self.state/'record').write_text('retained');lease=self.lease();snapshot=self.capture(lease)
        parent=self.root/'backup';parent.mkdir(mode=0o700);fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
        original=module._rename_exclusive
        def corrupt(*args):
            result=original(*args);next(parent.glob('*/tree/record')).write_text('modified');return result
        try:
            with patch.object(module,'_rename_exclusive',side_effect=corrupt):
                with self.assertRaises(self.error):self.backup(snapshot,fd)
        finally:os.close(fd)
        self.assertNotIn('BACKUP_COMPLETE',self.ledger.markers)
        self.assertEqual((self.state/'record').read_text(),'retained')
