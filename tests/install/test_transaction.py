"""Explicit source/fake backend transactions; no host qualification claim."""
from dataclasses import replace
from pathlib import Path
import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from _loader import toolkit,ROOT
import test_configuration as configuration_fixture

class TransactionTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.transaction import _prepare_fixture_installation,prepare_installation,apply_installation,resume_installation,SwitchAuthorization,QualificationInputs
        except ImportError:self.fail('Bounded maintenance transaction is not implemented')
        self.prepare_fixture,self.prepare,self.apply,self.resume,self.Auth,self.Inputs=_prepare_fixture_installation,prepare_installation,apply_installation,resume_installation,SwitchAuthorization,QualificationInputs
        self.context=configuration_fixture.ConfigurationTests();self.context.setUp();self.addCleanup(self.context.doCleanups)
        t=self.context;t.lease.close();t.ledger.close()
        from rbridge_installation.ledger import _open_fixture_ledger
        self.ledger=_open_fixture_ledger(t.fd,'b'*32);self.addCleanup(self.ledger.close);self.host=t.host;self.profile=t.profile;self.artifact=t.artifact()
        self.host.running=False;self.host.start_error=False;self.host.unsettled=False;self.host.accepted=True;self.host.execution_count=0;self.host.start_intent_preceded_new_start=False;self.host.old_start_called=False
        def start(prepared):
            self.host.start_intent_preceded_new_start=self.ledger.read().entries[-1].marker=='START_ATTEMPTED';self.host.running=True
            if self.host.start_error:raise OSError('source fixture lost start ACK')
        def stop(unit):
            if self.host.unsettled and self.host.running:raise OSError('source fixture stop timeout')
            self.host.running=False
        original_observe=self.host.observe_pause
        def observe(profile):
            value=original_observe(profile)
            if self.host.running:value.update(active_state='active',main_pid=31337,cgroup_pids=[31337],admissions_closed=False)
            return value
        self.host.start_candidate=start;self.host.stop_unit=stop;self.host.observe_pause=observe
        self.addCleanup(self.close_transaction_handles)
        self.host.observe_candidate=lambda prepared:{'scope':'FIXTURE_AUTHORITY_ONLY','status':'PASS','invocation_sha256':'e'*64,'profile_sha256':prepared.profile_sha256,'runtime_manifest_sha256':self.host.runtime_manifest.sha256}
        self.host.accept_candidate=lambda context:{'schema':'RBRIDGE_INSTALL_ACCEPTANCE_V1','status':'PASS' if self.host.accepted else 'FAIL','reason_codes':[] if self.host.accepted else ['FIXTURE_ACCEPTANCE_FAILURE']}
        def gates(lease,token,manifest):
            from rbridge_installation.models import report_sha256
            reports=[{'gate':gate,'status':'PASS','snapshot_sha256':report_sha256(token),'evidence_sha256':'f'*64,'checks':[],'reason_codes':[]} for gate in ('LEGACY','FLOWPILOT','PROCESS','TRANSFERS','CORE')]
            return {'scope':'FIXTURE_AUTHORITY_ONLY','bundle':{'schema':'RBRIDGE_INSTALL_GATE_V1','status':'PASS','reason_codes':[],'token':token,'reports':reports}}
        self.host.fixture_gates=gates
        self.prepared=self.prepare_fixture(self.profile,self.ledger,self.artifact,self.host.runtime_manifest)
        self.auth=self.Auth(purpose='FIXTURE_SWITCH_ONLY',profile_sha256=self.prepared.profile_sha256,runtime_manifest_sha256=self.host.runtime_manifest.sha256,toolkit_manifest_sha256=self.prepared.toolkit_manifest_sha256,readers_sha256=self.prepared.readers_sha256,helper_sha256=self.prepared.helper_sha256,transaction_id=self.ledger.transaction_id,owner_present=True,expires_at='2099-01-01T00:00:00.000Z')
    def close_transaction_handles(self):
        prepared=getattr(self.host,'current_installation',getattr(self,'prepared',None))
        if prepared:
            if prepared.lease:prepared.lease.close()
            if prepared.evidence:prepared.evidence.close()
            if prepared.config and not prepared.config.session.closed:prepared.config.session.close()
            if prepared.pointer and prepared.pointer.session.guard.handles:prepared.pointer.session.guard.close()
        pending=getattr(self.host,'pending_pause',None)
        if pending:pending.close()
    def test_failed_start_after_durable_intent_never_restarts_old(self):
        self.host.start_error=True;result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.phase,'ROLLBACK_BLOCKED_START_ATTEMPTED');self.assertEqual(result.exit_code,4);self.assertFalse(self.host.old_start_called);self.assertTrue(self.host.start_intent_preceded_new_start)
        self.assertEqual(os.readlink(self.profile.paths.current_link),str(self.artifact.path));self.assertFalse(self.prepared.lease.closed)
    def test_stop_timeout_is_unsettled_and_retains_exclusion(self):
        self.host.start_error=True;self.host.unsettled=True;result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.phase,'HOLD_UNSETTLED');self.assertEqual(result.exit_code,2);self.assertFalse(self.prepared.lease.closed);self.assertFalse(self.host.old_start_called)
    def test_accepted_fixture_has_every_marker_and_guarded_start(self):
        result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.status,'ACCEPTED');self.assertEqual(result.exit_code,0);self.assertEqual(self.ledger.read().entries[-1].marker,'ACCEPTED');self.assertTrue(self.host.start_intent_preceded_new_start);self.assertFalse(self.host.old_start_called)
    def test_controlled_acceptance_restart_commits_fresh_final_invocation(self):
        from rbridge_installation.models import report_sha256
        first=self.host.observe_candidate(self.prepared)
        final={**first,'invocation_sha256':'d'*64}
        def acceptance(prepared):
            self.host.observe_candidate=lambda prepared:dict(final)
            return {'schema':'RBRIDGE_INSTALL_ACCEPTANCE_V1','scope':'FIXTURE_AUTHORITY_ONLY','status':'PASS','accepted':False,'final_invocation':dict(final)}
        self.host.accept_candidate=acceptance
        result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.status,'ACCEPTED');self.assertFalse(self.host.old_start_called)
        evidence=self.ledger.read().entries[-1].evidence
        self.assertEqual(evidence['invocation_sha256'],report_sha256(final))
        self.assertNotEqual(evidence['invocation_sha256'],report_sha256(first))
    def test_plan_approval_or_digest_drift_never_authorizes_switch(self):
        for auth in (replace(self.auth,purpose='NATIVE_IMPLEMENTATION_PLAN'),replace(self.auth,profile_sha256='0'*64),replace(self.auth,owner_present=False),replace(self.auth,expires_at='2020-01-01T00:00:00.000Z')):
            result=self.apply(self.prepared,auth,self.host);self.assertEqual(result.exit_code,2);self.assertEqual(self.ledger.read().entries,());self.assertFalse(self.host.running)
    def test_scope_and_pass_strings_do_not_qualify_production_preparation(self):
        result=self.prepare(self.profile,self.Inputs({'scope':'QUALIFIED_INSTALLATION','status':'PASS'}));self.assertNotEqual(result.status,'READY');self.assertFalse(self.host.running)
    def test_post_start_acceptance_failure_preserves_new_durable_state_and_refuses_old(self):
        self.host.accepted=False
        def acceptance(context):
            Path(self.profile.paths.state_root,'closed-core-fixture.json').write_text('{"outcome":"BLOCKED","closed":true}');Path(self.profile.paths.state_root,'new-legacy-job.json').write_text('{"fixture":"new work"}')
            return {'schema':'RBRIDGE_INSTALL_ACCEPTANCE_V1','status':'FAIL','reason_codes':['FIXTURE_ACCEPTANCE_FAILURE']}
        self.host.accept_candidate=acceptance;result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.exit_code,4);self.assertTrue(Path(self.profile.paths.state_root,'new-legacy-job.json').exists());self.assertFalse(self.host.old_start_called)
        resumed=self.resume(self.profile,self.ledger,self.host);self.assertNotEqual(resumed.exit_code,0);self.assertFalse(self.host.old_start_called)
    def test_start_marker_fsync_failure_does_not_start_and_retains_evidence(self):
        from rbridge_installation.ledger import LedgerError
        actual=self.ledger.append
        def uncertain(marker,evidence):
            if marker=='START_ATTEMPTED':raise LedgerError('LEDGER_FSYNC_UNCERTAIN')
            return actual(marker,evidence)
        with patch.object(self.ledger,'append',side_effect=uncertain):result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.exit_code,2);self.assertFalse(self.host.running);self.assertFalse(self.host.old_start_called);self.assertFalse(self.prepared.lease.closed)
    def test_mutated_preparation_cannot_replace_qualified_reader_digest(self):
        self.prepared.readers_sha256='9'*64
        auth=replace(self.auth,readers_sha256='9'*64)
        result=self.apply(self.prepared,auth,self.host)
        self.assertEqual(result.exit_code,2);self.assertEqual(self.ledger.read().entries,())
    def cold_context(self):
        self.prepared.lease.close()
        self.prepared.config.session.close();self.prepared.pointer.session.guard.close()
        for name in ('current_installation','owned_configuration','owned_pointer'):
            if hasattr(self.host,name):delattr(self.host,name)
        self.host.resume_preparation=self.prepare_fixture(self.profile,self.ledger,self.artifact,self.host.runtime_manifest)
    def test_cold_post_start_resume_reacquires_lock_and_proves_stopped_hold(self):
        self.host.start_error=True;self.apply(self.prepared,self.auth,self.host);self.cold_context()
        result=self.resume(self.profile,self.ledger,self.host)
        self.assertEqual(result.exit_code,4);self.assertEqual(result.phase,'ROLLBACK_BLOCKED_START_ATTEMPTED')
        self.assertFalse(self.host.current_installation.lease.closed);self.assertFalse(self.host.old_start_called)
        self.assertEqual(os.readlink(self.profile.paths.current_link),str(self.artifact.path))
    def test_cold_post_start_changed_owned_inode_stays_unknown_without_repair(self):
        self.host.start_error=True;self.apply(self.prepared,self.auth,self.host);self.cold_context()
        binding=Path(self.profile.paths.binding_env);binding.unlink();binding.write_text('concurrent owned edit');binding.chmod(0o600)
        result=self.resume(self.profile,self.ledger,self.host)
        self.assertEqual(result.exit_code,2);self.assertEqual(binding.read_text(),'concurrent owned edit');self.assertFalse(self.host.old_start_called)
    def test_expired_authorization_at_start_marker_blocks_new_start(self):
        actual=self.ledger.append
        def expire(marker,evidence):
            value=actual(marker,evidence)
            if marker=='POINTER_SWITCHED':object.__setattr__(self.auth,'expires_at','2020-01-01T00:00:00.000Z')
            return value
        with patch.object(self.ledger,'append',side_effect=expire):result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.exit_code,3);self.assertFalse(self.host.start_intent_preceded_new_start);self.assertFalse(self.host.running)
    def test_cli_fixed_operations_never_derive_authority_from_pass_strings(self):
        from rbridge_installation.models import encode_report
        for operation in ('prepare','check','apply','resume','status'):
            raw=encode_report({'profile':self.profile,'qualification':{'scope':'QUALIFIED_INSTALLATION','status':'PASS'},'transaction_id':'b'*32})
            child=subprocess.run([sys.executable,'-I','-B',str(ROOT/'ops/install/rbridge_install.py'),operation],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
            self.assertEqual(child.returncode,2);result=json.loads(child.stdout);self.assertEqual(result['status'],'BLOCKED');self.assertNotIn('fixture-secret',child.stdout.decode())
    def test_initial_stop_error_also_retains_new_foreground_exclusion(self):
        def stop(unit):raise OSError('source fixture initial stop uncertainty')
        self.host.stop_unit=stop
        result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.exit_code,2);self.assertEqual(result.phase,'HOLD_UNSETTLED');self.assertIsNotNone(self.prepared.lease);self.assertFalse(self.prepared.lease.closed)
    def test_partial_reload_retains_intent_without_pointer_switch_or_old_start(self):
        self.host.partial=True;result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.exit_code,2);self.assertEqual(result.phase,'HOLD_UNSETTLED');self.assertEqual(self.ledger.read().entries[-1].marker,'CONFIG_INTENT')
        self.assertEqual(os.readlink(self.profile.paths.current_link),str(self.context.old));self.assertTrue(Path(self.profile.paths.binding_env).exists());self.assertFalse(self.host.old_start_called)
    def test_lost_stop_ack_is_followed_by_independent_observation(self):
        self.host.start_error=True
        def stop(unit):
            if self.host.running:self.host.running=False;raise OSError('source fixture lost stop ACK')
        self.host.stop_unit=stop;result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.exit_code,4);self.assertFalse(self.host.running);self.assertFalse(self.prepared.lease.closed)
    def test_post_start_alternate_writer_does_not_report_stopped_hold(self):
        observe=self.host.observe_pause;self.host.start_error=True
        def alternate(profile):
            value=observe(profile)
            if self.host.start_intent_preceded_new_start:value['alternate_writers']=['fixture-alternate.service']
            return value
        self.host.observe_pause=alternate;result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.exit_code,2);self.assertEqual(result.phase,'HOLD_UNSETTLED');self.assertFalse(self.prepared.lease.closed);self.assertFalse(self.host.old_start_called)
    def test_mixed_snapshot_gate_bundle_blocks_before_any_configuration(self):
        gates=self.host.fixture_gates
        def mixed(lease,token,manifest):
            value=gates(lease,token,manifest);value['bundle']['reports'][3]['snapshot_sha256']='0'*64;return value
        self.host.fixture_gates=mixed;result=self.apply(self.prepared,self.auth,self.host)
        self.assertEqual(result.exit_code,2);self.assertFalse(Path(self.profile.paths.binding_env).exists());self.assertFalse(self.host.running);self.assertFalse(self.prepared.lease.closed)
    def test_corrupt_cold_ledger_or_evidence_never_changes_pointer_or_state(self):
        self.host.start_error=True;self.apply(self.prepared,self.auth,self.host);self.cold_context()
        witness=Path(self.context.root/'ledger'/('evidence-'+self.ledger.transaction_id));(next(witness.glob('*-owned-pointer.json'))).write_text('{"duplicate":1,"duplicate":2}')
        result=self.resume(self.profile,self.ledger,self.host);self.assertEqual(result.exit_code,2);self.assertEqual(os.readlink(self.profile.paths.current_link),str(self.artifact.path));self.assertFalse(self.host.old_start_called)
        (self.context.root/'ledger'/self.ledger.transaction_id/'ledger.json').write_text('{"corrupt":true}')
        result=self.resume(self.profile,self.ledger,self.host);self.assertEqual(result.exit_code,2);self.assertFalse(self.host.old_start_called)
    def test_candidate_identity_verification_rejects_env_sha_only_or_wrong_process(self):
        from rbridge_installation.host_backend import validate_candidate_facts
        from rbridge_installation.models import InstallationError
        import hashlib
        p=replace(self.profile,binding=replace(self.profile.binding,uid=1027,gid=1027));rows={'MainPID':'42','InvocationID':'c'*32,'ControlGroup':'/system.slice/rbridge.service','ActiveState':'active','SubState':'running'}
        argv=(p.runtime.node_path,p.paths.current_link+'/dist/server/server/remoteBridgeMain.js')
        facts={'Uid':(p.binding.uid,)*4,'Gid':(p.binding.gid,)*4,'Groups':(p.binding.gid,*p.binding.supplementary_gids),'PPid':(1,),'identity':{'pid':42,'exe':p.runtime.node_path,'cmdlineSha256':hashlib.sha256(('\0'.join(argv)+'\0').encode()).hexdigest(),'startTimeTicks':'123'},'cgroup_sha256':hashlib.sha256(b'0::/system.slice/rbridge.service\n').hexdigest()}
        validate_candidate_facts(p,rows,facts,p.runtime.node_sha256)
        for bad,sha in (({**facts,'Uid':(999,)*4},p.runtime.node_sha256),({**facts,'Gid':(999,)*4},p.runtime.node_sha256),({**facts,'Groups':(0,)},p.runtime.node_sha256),({**facts,'identity':{**facts['identity'],'cmdlineSha256':'0'*64}},p.runtime.node_sha256),(facts,'0'*64)):
            with self.assertRaises(InstallationError):validate_candidate_facts(p,rows,bad,sha)
    def test_real_sigkill_at_every_durable_phase_preserves_intent_and_never_starts_old(self):
        from rbridge_installation.ledger import MARKERS,_open_fixture_ledger
        from rbridge_installation.models import report_sha256,encode_report,record
        from rbridge_installation.artifact import inventory_artifact
        from rbridge_installation.protected_copy import PublishedArtifact
        script='''import sys,json,os,signal,tempfile
sys.path.insert(0,sys.argv[1]);tempfile.tempdir=sys.argv[3]
from test_transaction import TransactionTests
case=TransactionTests();case.setUp();actual=case.ledger.append
from rbridge_installation.models import encode_report
def barrier(marker,evidence):
 if marker=='START_ATTEMPTED' and sys.argv[2]=='BEFORE_START':
  print(json.dumps({'root':str(case.context.root),'profile':json.loads(encode_report(case.profile)),'rows':case.host.rows}),flush=True)
  os.kill(os.getpid(),signal.SIGKILL)
 value=actual(marker,evidence)
 if marker==sys.argv[2]:
  if marker in ('START_ATTEMPTED','NEW_STARTED','ACCEPTING','ACCEPTED'):
   from pathlib import Path
   Path(case.profile.paths.state_root,'closed-core.json').write_text('{"outcome":"BLOCKED","closed":true}')
   Path(case.profile.paths.state_root,'new-legacy.json').write_text('{"fixture":"new admitted work"}')
  print(json.dumps({'root':str(case.context.root),'profile':json.loads(encode_report(case.profile)),'rows':case.host.rows}),flush=True)
  os.kill(os.getpid(),signal.SIGKILL)
 return value
case.ledger.append=barrier
case.apply(case.prepared,case.auth,case.host)
raise SystemExit('fixture did not reach requested crash barrier')
'''
        for marker in (*MARKERS,'BEFORE_START'):
            with self.subTest(marker=marker),tempfile.TemporaryDirectory() as parent:
                child=subprocess.run([sys.executable,'-I','-B','-c',script,str(ROOT/'tests/install'),marker,parent],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
                self.assertEqual(child.returncode,-signal.SIGKILL,child.stderr.decode());info=json.loads(child.stdout);root=Path(info['root']);self.assertEqual(root.parent,Path(parent))
                # Source-only profile substitutes this process UID/path explicitly;
                # the production parser intentionally refuses these substitutions.
                service=info['profile']['service'].copy();service['environment_files']=tuple(record('PathDigest',e) for e in service['environment_files'])
                p=replace(self.profile,paths=replace(self.profile.paths,**info['profile']['paths']),service=replace(self.profile.service,**service))
                self.assertEqual(encode_report(p),encode_report(info['profile']));host=configuration_fixture.FixtureHost(p,info['rows']);host.fixture_gates=self.host.fixture_gates
                fd=os.open(root/'ledger',os.O_RDONLY|os.O_DIRECTORY);ledger=_open_fixture_ledger(fd,'b'*32)
                artifact_path=Path(p.paths.release_parent)/p.runtime.source_sha;manifest=inventory_artifact(artifact_path,'RUNTIME',p);artifact=PublishedArtifact(artifact_path,manifest.sha256,p.runtime.source_sha,'FIXTURE_AUTHORITY_ONLY')
                host.runtime_manifest=manifest;host.resume_preparation=self.prepare_fixture(p,ledger,artifact,manifest)
                try:
                    before=ledger.read();self.assertEqual(before.entries[-1].marker,'POINTER_SWITCHED' if marker=='BEFORE_START' else marker)
                    result=self.resume(p,ledger,host);self.assertNotEqual(result.exit_code,0);self.assertFalse(host.old_start_called)
                    if marker in ('START_ATTEMPTED','NEW_STARTED','ACCEPTING'):
                        self.assertEqual(result.exit_code,4);self.assertEqual(os.readlink(p.paths.current_link),str(artifact_path));self.assertEqual(Path(p.paths.state_root,'closed-core.json').read_text(),'{"outcome":"BLOCKED","closed":true}');self.assertTrue(Path(p.paths.state_root,'new-legacy.json').exists())
                    elif marker in ('CONFIG_INTENT','CONFIG_INSTALLED','POINTER_INTENT','POINTER_SWITCHED'):
                        self.assertEqual(result.exit_code,2);self.assertEqual(result.phase,'HOLD_UNSETTLED');self.assertEqual(ledger.read().sha256,before.sha256)
                    elif marker=='BEFORE_START':
                        self.assertEqual(result.exit_code,3);self.assertEqual(result.phase,'ROLLED_BACK');self.assertEqual(os.readlink(p.paths.current_link),str(Path(p.paths.release_parent)/p.runtime.old_sha));self.assertFalse(Path(p.paths.binding_env).exists());self.assertFalse(Path(p.paths.binding_dropin).exists())
                    elif marker=='ACCEPTED':self.assertEqual(result.phase,'ACCEPTED')
                    else:self.assertEqual(result.phase,'ROLLBACK_BLOCKED')
                finally:
                    recovered=getattr(host,'current_installation',None)
                    if recovered:
                        if recovered.lease:recovered.lease.close()
                        if recovered.evidence:recovered.evidence.close()
                        if recovered.config:recovered.config.session.close()
                        if recovered.pointer:recovered.pointer.session.guard.close()
                    ledger.close();os.close(fd)
