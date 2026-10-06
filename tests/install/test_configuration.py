"""Source filesystem/fake systemd fixtures; no privileged installation proof."""
from dataclasses import replace
from pathlib import Path
import hashlib
import os
import shlex
import shutil
import signal
import subprocess
import sys
import json
import tempfile
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile,runtime_stage

class FixtureHost:
    scope='FIXTURE_AUTHORITY_ONLY'
    def __init__(self,profile,rows):self.profile=profile;self.rows=rows;self.reloads=0;self.partial=False;self.old_start_called=False
    def _show(self,unit):return dict(self.rows)
    def capture_service(self,profile):
        from rbridge_installation.configuration import normalize_owned_rows
        normalize_owned_rows(self,self.rows)
        return {'scope':self.scope,'identity_sha256':profile.service.identity_sha256,'config_sha256':profile.service.identity_sha256,'invocation_sha256':'c'*64}
    def stop_unit(self,unit):pass
    def observe_pause(self,profile):
        self.capture_service(profile)
        return {'scope':self.scope,'service_identity_sha256':profile.service.identity_sha256,'active_state':'inactive','main_pid':0,'cgroup_pids':[],'unclassified_same_uid':[],'alternate_writers':[],'supervisors':[],'admissions_closed':True}
    def reload_configuration(self):
        self.reloads+=1
        session=self.owned_configuration
        if session.loading and not session.restoring:
            self.rows['DropInPaths']=' '.join(sorted([*shlex.split(session.before['DropInPaths']),self.profile.paths.binding_dropin],key=lambda p:Path(p).name))
            if not self.partial:self.rows['EnvironmentFiles']=session.before['EnvironmentFiles']+' '+self.profile.paths.binding_env+' (ignore_errors=no)'
        else:self.rows=dict(session.before)

class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.configuration import install_configuration,switch_pointer,restore_owned_pre_start,OwnedChanges,ConfigError
        except ImportError:self.fail('Owned configuration/pointer transaction is not implemented')
        from rbridge_installation.profile import parse_profile
        from rbridge_installation.ledger import _open_fixture_ledger,ObservedTransactionState
        from rbridge_installation.pause_backup import maintain_pause,capture_snapshot
        from rbridge_installation.host_backend import PROPERTIES
        self.install,self.switch,self.restore,self.Changes,self.error=install_configuration,switch_pointer,restore_owned_pre_start,OwnedChanges,ConfigError
        self.Observed=ObservedTransactionState;self.capture=capture_snapshot
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        for name in ('env','dropins','state','ledger','releases'): (self.root/name).mkdir(mode=0o700)
        originals=[]
        for name in ('runtime','flowpilot'):
            p=self.root/'env'/name;p.write_text('RBRIDGE_RELEASE_SHA=earlier\nGH_TOKEN=fixture-secret-never-print\n');p.chmod(0o600);originals.append({'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
        self.fragment=self.root/'unit';self.fragment.write_text('[Service]\nEnvironment=RBRIDGE_RELEASE_SHA=earliest\n');self.fragment.chmod(0o644)
        self.cpu=self.root/'dropins/50-cpu.conf';self.cpu.write_text('[Service]\nCPUQuota=15%\n');self.cpu.chmod(0o644)
        p=parse_profile(valid_profile());self.profile=replace(p,binding=replace(p.binding,uid=os.getuid(),gid=os.getgid()),paths=replace(p.paths,binding_env=str(self.root/'env/binding'),binding_dropin=str(self.root/'dropins/60-p2a-binding.conf'),current_link=str(self.root/'current'),release_parent=str(self.root/'releases'),state_root=str(self.root/'state'),lock_path=str(self.root/'maintenance.lock')),service=replace(p.service,environment_files=tuple(__import__('rbridge_installation.models',fromlist=['record']).record('PathDigest',v) for v in originals)))
        rows={k:'' for k in PROPERTIES};rows.update({'FragmentPath':str(self.fragment),'DropInPaths':str(self.cpu),'EnvironmentFiles':' '.join(v['path']+' (ignore_errors=no)' for v in originals),'CPUQuotaPerSecUSec':'150ms','User':'rbridge','Group':'rbridge','ExecStart':'{ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/fixture/current/main.js ; ignore_errors=no ; start_time=[n/a] ; }','ProtectSystem':'strict','ProtectHome':'read-only','NoNewPrivileges':'yes','ReadWritePaths':'/home/rbridge/.local/state/rbridge','ActiveState':'inactive','SubState':'dead','MainPID':'0'})
        from rbridge_installation.models import report_sha256
        files={'fragment':{'path':str(self.fragment),'sha256':hashlib.sha256(self.fragment.read_bytes()).hexdigest()},'dropins':[{'path':str(self.cpu),'sha256':hashlib.sha256(self.cpu.read_bytes()).hexdigest()}]}
        self.profile=replace(self.profile,service=replace(self.profile.service,dropins_sha256=report_sha256(files)))
        self.host=FixtureHost(self.profile,rows);self.fd=os.open(self.root/'ledger',os.O_RDONLY|os.O_DIRECTORY);self.addCleanup(os.close,self.fd)
        self.ledger=_open_fixture_ledger(self.fd,'a'*32);self.addCleanup(self.ledger.close)
        self.ledger.append('QUALIFIED',{});self.ledger.append('STAGED',{})
        self.lease=maintain_pause(self.profile,self.host,self.ledger);self.addCleanup(self.lease.close)
        self.snapshot=self.capture(self.lease);self.ledger.append('BACKUP_COMPLETE',{});self.ledger.append('GATES_PASS',{'snapshot_sha256':self.snapshot.tree_sha256})
        self.old=self.root/'releases'/p.runtime.old_sha;self.old.mkdir();(self.root/'current').symlink_to(self.old)
    def config(self):return self.install(self.profile,self.lease,self.ledger,self.host)
    def artifact(self):
        from rbridge_installation.artifact import inventory_artifact
        from rbridge_installation.protected_copy import PublishedArtifact
        target=self.root/'releases'/self.profile.runtime.source_sha;target.mkdir();runtime_stage(target)
        self.host.runtime_manifest=inventory_artifact(target,'RUNTIME',self.profile)
        return PublishedArtifact(target,self.host.runtime_manifest.sha256,self.profile.runtime.source_sha,'FIXTURE_AUTHORITY_ONLY')
    def observed(self,changes,**extra):
        from rbridge_installation.models import report_sha256
        values={'pointer_sha256':changes.pointer.after_sha256 if changes.pointer else changes.config.before_pointer_sha256,'config_sha256':changes.config.after_sha256,'service_identity_sha256':self.profile.service.identity_sha256,'snapshot_sha256':self.capture(self.lease).tree_sha256,'owned_additions_sha256':changes.config.owned_additions_sha256,'service_settled':True,'writers_excluded':True,'fresh_gate_status':'PASS','fresh_gate_snapshot_sha256':self.snapshot.tree_sha256};values.update(extra);return self.Observed(**values)
    def test_appends_environment_file_after_both_originals_preserving_cpu_and_hardening(self):
        originals={p:Path(p).read_bytes() for p in [self.fragment,self.cpu,*[e.path for e in self.profile.service.environment_files]]}
        change=self.config();self.lease.check()
        self.assertTrue(self.host.rows['EnvironmentFiles'].endswith(self.profile.paths.binding_env+' (ignore_errors=no)'))
        self.assertEqual(self.host.rows['CPUQuotaPerSecUSec'],'150ms');self.assertEqual(self.host.rows['ProtectSystem'],'strict');self.assertEqual(self.host.rows['ReadWritePaths'],'/home/rbridge/.local/state/rbridge')
        for p,data in originals.items():self.assertEqual(Path(p).read_bytes(),data)
        binding=Path(self.profile.paths.binding_env);self.assertEqual(binding.stat().st_mode&0o7777,0o600);self.assertEqual(Path(self.profile.paths.binding_dropin).stat().st_mode&0o7777,0o644)
        text=binding.read_text();self.assertIn('RBRIDGE_RELEASE_SHA='+self.profile.runtime.source_sha,text);self.assertIn('COCWIN_REMOTE_BRIDGE_RELEASE_SHA='+self.profile.runtime.source_sha,text);self.assertNotIn('GH_TOKEN',text);self.assertNotIn('fixture-secret',repr(change))
        self.assertEqual(self.ledger.read().entries[-1].marker,'CONFIG_INSTALLED')
    def test_unowned_paths_and_partial_reload_never_acknowledge_configuration(self):
        binding=Path(self.profile.paths.binding_env);binding.write_text('pre-existing');binding.chmod(0o600)
        with self.assertRaises(self.error):self.config()
        self.assertEqual(binding.read_text(),'pre-existing');self.assertEqual(self.host.reloads,0)
        binding.unlink();self.host.partial=True
        with self.assertRaises(self.error):self.config()
        self.assertEqual(self.ledger.read().entries[-1].marker,'CONFIG_INTENT');self.assertFalse(self.host.old_start_called)
    def test_concurrent_dropin_or_original_environment_edit_invalidates_lease(self):
        self.config();self.host.rows['DropInPaths']+=' /srv/fixture/concurrent.conf'
        with self.assertRaises(Exception):self.lease.check()
        self.assertEqual(self.cpu.read_text(),'[Service]\nCPUQuota=15%\n')
    def test_acknowledged_overlay_cannot_disappear_from_effective_settings(self):
        change=self.config();self.host.rows=dict(change.session.before)
        with self.assertRaises(Exception):self.lease.check()
    def test_original_environment_or_owned_binding_drift_is_not_repaired(self):
        change=self.config();binding=Path(self.profile.paths.binding_env);binding.write_text('drift');binding.chmod(0o600)
        with self.assertRaises(self.error):self.restore(self.Changes(change),self.Observed('a'*64,'b'*64,'c'*64,'d'*64,'e'*64,True,True,'PASS','d'*64),self.lease,self.ledger)
        self.assertEqual(binding.read_text(),'drift');self.assertTrue(self.cpu.exists())
    def test_original_environment_edit_is_preserved_and_never_restored_from_old_contents(self):
        self.config();original=Path(self.profile.service.environment_files[-1].path);original.write_text('concurrent original edit');original.chmod(0o600)
        with self.assertRaises(Exception):self.lease.check()
        self.assertEqual(original.read_text(),'concurrent original edit');self.assertFalse(self.host.old_start_called)
    def test_dangling_owned_dropin_and_wrong_pointer_are_never_overwritten(self):
        dropin=Path(self.profile.paths.binding_dropin);dropin.symlink_to(self.root/'absent')
        with self.assertRaises(self.error):self.config()
        self.assertTrue(dropin.is_symlink());self.assertFalse(Path(self.profile.paths.binding_env).exists());dropin.unlink()
        self.config();artifact=self.artifact();(self.root/'current').unlink();(self.root/'current').symlink_to(self.root/'different')
        with self.assertRaises(self.error):self.switch(self.profile,artifact,self.lease,self.ledger)
        self.assertEqual(os.readlink(self.root/'current'),str(self.root/'different'));self.assertEqual(self.ledger.read().entries[-1].marker,'CONFIG_INSTALLED')
    def test_original_unset_environment_cannot_remove_owned_binding(self):
        self.host.rows['UnsetEnvironment']='RBRIDGE_MCP_PRINCIPAL_ID'
        with self.assertRaises(self.error):self.config()
        self.assertFalse(Path(self.profile.paths.binding_env).exists())
    def test_dropin_order_uses_filename_across_directories(self):
        from rbridge_installation.models import report_sha256
        vendor=self.root/'vendor';vendor.mkdir();early=vendor/'10-base.conf';early.write_text('[Service]\nNoNewPrivileges=yes\n');early.chmod(0o644)
        self.host.rows['DropInPaths']=str(early)+' '+str(self.cpu)
        files={'fragment':{'path':str(self.fragment),'sha256':hashlib.sha256(self.fragment.read_bytes()).hexdigest()},'dropins':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [early,self.cpu]]}
        self.profile=replace(self.profile,service=replace(self.profile.service,dropins_sha256=report_sha256(files)));self.lease.profile=self.profile;self.host.profile=self.profile
        self.config();self.assertEqual(shlex.split(self.host.rows['DropInPaths']),[str(early),str(self.cpu),self.profile.paths.binding_dropin]);self.lease.check()
    def test_reload_execstart_metadata_change_is_distinct_from_executable_or_argument_drift(self):
        actual=self.host.reload_configuration
        def reload():
            actual();self.host.rows['ExecStart']=self.host.rows['ExecStart'].replace('[n/a]','Mon 2026-10-05 10:00:00 UTC')
        self.host.reload_configuration=reload
        self.config();self.lease.check()
        self.host.rows['ExecStart']=self.host.rows['ExecStart'].replace('/srv/fixture/current/main.js','/srv/fixture/foreign/main.js')
        with self.assertRaises(Exception):self.lease.check()
    def test_unknown_or_missing_fresh_gate_does_not_restore(self):
        config=self.config();changes=self.Changes(config)
        with self.assertRaises(self.error):self.restore(changes,self.observed(changes,fresh_gate_status='UNKNOWN'),self.lease,self.ledger)
        self.assertTrue(Path(self.profile.paths.binding_env).exists())
    def test_failed_config_fsync_retains_intent_without_reload_or_old_start(self):
        actual=os.fsync
        def fail_file(fd):
            if os.path.isfile('/proc/self/fd/'+str(fd)) and os.readlink('/proc/self/fd/'+str(fd))==self.profile.paths.binding_env:raise OSError('fixture EIO')
            return actual(fd)
        with patch('rbridge_installation.configuration.os.fsync',side_effect=fail_file):
            with self.assertRaises(self.error):self.config()
        self.assertEqual(self.ledger.read().entries[-1].marker,'CONFIG_INTENT');self.assertTrue(Path(self.profile.paths.binding_env).exists());self.assertEqual(self.host.reloads,0);self.assertFalse(self.host.old_start_called)
    def test_lost_pointer_ack_keeps_both_symlinks_and_never_claims_switched(self):
        self.config();artifact=self.artifact();actual=self.ledger.append
        def lost_ack(marker,evidence):
            if marker=='POINTER_SWITCHED':raise OSError('fixture lost ACK')
            return actual(marker,evidence)
        with patch.object(self.ledger,'append',side_effect=lost_ack):
            with self.assertRaises(self.error):self.switch(self.profile,artifact,self.lease,self.ledger)
        self.assertEqual(self.ledger.read().entries[-1].marker,'POINTER_INTENT');self.assertEqual(os.readlink(self.root/'current'),str(artifact.path));held=list(self.root.glob('.rbridge-pointer-*'));self.assertEqual(len(held),1);self.assertEqual(os.readlink(held[0]),str(self.old));self.assertFalse(self.host.old_start_called)
    def test_pointer_restores_only_exact_owned_additions_before_start(self):
        config=self.config();artifact=self.artifact();pointer=self.switch(self.profile,artifact,self.lease,self.ledger)
        self.assertEqual(os.readlink(self.root/'current'),str(artifact.path));self.assertTrue(self.old.is_dir())
        changes=self.Changes(config,pointer);proof=self.restore(changes,self.observed(changes),self.lease,self.ledger)
        self.assertTrue(proof.may_start_old);self.assertEqual(os.readlink(self.root/'current'),str(self.old));self.assertFalse(Path(self.profile.paths.binding_env).exists());self.assertTrue(self.cpu.exists());self.assertFalse(self.host.old_start_called)
    def test_pointer_or_owned_file_drift_and_start_intent_forbid_restoration(self):
        config=self.config();artifact=self.artifact();pointer=self.switch(self.profile,artifact,self.lease,self.ledger);changes=self.Changes(config,pointer)
        (self.root/'current').unlink();(self.root/'current').symlink_to(self.root/'concurrent')
        with self.assertRaises(self.error):self.restore(changes,self.observed(changes),self.lease,self.ledger)
        self.assertEqual(os.readlink(self.root/'current'),str(self.root/'concurrent'));self.assertTrue(Path(self.profile.paths.binding_env).exists())
    def test_start_attempted_even_failed_prevents_every_old_restore(self):
        config=self.config();artifact=self.artifact();pointer=self.switch(self.profile,artifact,self.lease,self.ledger);changes=self.Changes(config,pointer)
        self.ledger.append('START_ATTEMPTED',{})
        with self.assertRaises(self.error):self.restore(changes,self.observed(changes),self.lease,self.ledger)
        self.assertEqual(os.readlink(self.root/'current'),str(artifact.path));self.assertFalse(self.host.old_start_called)
    def test_scope_string_cannot_grant_production_mutation(self):
        self.host.scope='QUALIFIED_HOST_PAUSE'
        with self.assertRaises(self.error):self.config()
        self.assertFalse(Path(self.profile.paths.binding_env).exists())
    def test_real_child_death_after_exchange_retains_intent_and_original_inode(self):
        from _loader import ROOT
        code='''import sys,os,json,signal
sys.path.insert(0,sys.argv[1])
from test_configuration import ConfigurationTests
t=ConfigurationTests();t.setUp();t.config();artifact=t.artifact()
import rbridge_installation.configuration as m
actual=m._exchange
def crash(fd,left,right):
 actual(fd,left,right);os.fsync(fd)
 print(json.dumps({'root':str(t.root),'old':str(t.old),'new':str(artifact.path)}),flush=True)
 os.kill(os.getpid(),signal.SIGKILL)
m._exchange=crash
t.switch(t.profile,artifact,t.lease,t.ledger)
'''
        child=subprocess.run([sys.executable,'-I','-B','-c',code,str(ROOT/'tests/install')],capture_output=True,text=True,timeout=10)
        self.assertEqual(child.returncode,-signal.SIGKILL,child.stderr);data=json.loads(child.stdout);root=Path(data['root']);self.addCleanup(shutil.rmtree,root)
        self.assertEqual(os.readlink(root/'current'),data['new']);held=list(root.glob('.rbridge-pointer-*'));self.assertEqual(len(held),1);self.assertEqual(os.readlink(held[0]),data['old'])
        record=json.loads((root/'ledger'/('a'*32)/'ledger.json').read_text());self.assertEqual(record['entries'][-1]['marker'],'POINTER_INTENT');self.assertNotIn('START_ATTEMPTED',[row['marker'] for row in record['entries']])
