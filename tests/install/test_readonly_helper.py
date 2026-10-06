import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile


class ReadonlyHelperTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.readonly_helper import parse_helper_ready, validate_discovery, validate_gate_bundle, QualifiedReadonlyAuditRunner
        except ImportError:
            self.fail('Qualified fixed readonly helper orchestration is not implemented')
        from rbridge_installation.models import InstallationError, report_sha256
        from rbridge_installation.profile import parse_profile
        self.ready, self.discovery, self.bundle, self.runner = parse_helper_ready, validate_discovery, validate_gate_bundle, QualifiedReadonlyAuditRunner
        self.error, self.sha = InstallationError, report_sha256
        self.profile = parse_profile(valid_profile())
        self.token = {'transaction_id':'a'*32,'state_root_identity_sha256':'1'*64,'tree_sha256':'2'*64,'entries':0,'bytes':0,'pause_sha256':'3'*64,'captured_at':'2026-10-06T00:00:00.000Z'}

    def test_ready_requires_exact_nonce_pid_and_duplicate_free_complete_packet(self):
        packet = {'schema':'RBRIDGE_INSTALL_HELPER_READY_V1','pid':31337,'nonce':'a'*64}
        self.assertEqual(self.ready(json.dumps(packet).encode()+b'\n','a'*64),31337)
        for raw in (json.dumps({**packet,'nonce':'b'*64}).encode()+b'\n',json.dumps({**packet,'pid':True}).encode()+b'\n',b'{"schema":"wrong","schema":"RBRIDGE_INSTALL_HELPER_READY_V1","pid":31337,"nonce":"'+b'a'*64+b'"}\n',json.dumps(packet).encode(),json.dumps({**packet,'extra':True}).encode()+b'\n'):
            with self.assertRaises(self.error):self.ready(raw,'a'*64)

    def test_discovery_binds_full_sorted_targets_to_profile_and_snapshot_without_kernel_claim(self):
        packet = {'schema':'RBRIDGE_INSTALL_DISCOVERY_RESULT_V1','scope':'READONLY_PROBE_TARGETS_ONLY','status':'PASS','reason_codes':[],'profile_sha256':self.sha(self.profile),'snapshot_sha256':self.sha(self.token),'core_absence_sha256':'f'*64,'issue_numbers':[17,23],'process_targets':[{'session_id':'a'*32,'pid':31337,'start_ticks':'123','identity_sha256':'e'*64}]}
        self.assertEqual(self.discovery(packet,self.profile,self.token)['issue_numbers'],[17,23])
        for changed in ({'snapshot_sha256':'e'*64},{'profile_sha256':'e'*64},{'scope':'QUALIFIED_KERNEL_PASS'},{'issue_numbers':[23,17]},{'issue_numbers':[17,17]},{'issue_numbers':[2147483648]},{'process_targets':packet['process_targets']*2},{'process_targets':[{**packet['process_targets'][0],'pid':True}]}):
            with self.assertRaises(self.error):self.discovery({**packet,**changed},self.profile,self.token)

    def test_complete_bundle_recomputes_status_and_refuses_forged_or_mixed_reports(self):
        reports = [{'gate':gate,'status':'PASS','snapshot_sha256':self.sha(self.token),'evidence_sha256':self.sha(gate),'checks':[],'reason_codes':[]} for gate in ('LEGACY','FLOWPILOT','PROCESS','TRANSFERS','CORE')]
        packet = {'schema':'RBRIDGE_INSTALL_GATE_V1','status':'PASS','reason_codes':[],'token':self.token,'reports':reports}
        self.assertEqual(self.bundle(packet,self.token)['status'],'PASS')
        for changed in ({'reports':reports[:4]},{'reports':[reports[0],*reports[:4]]},{'token':{**self.token,'pause_sha256':'e'*64}},{'reports':[*reports[:4],{**reports[4],'status':'BLOCKED','reason_codes':['CORE_PRESENT']}]},{'reports':[*reports[:4],{**reports[4],'snapshot_sha256':'f'*64}]}):
            with self.assertRaises(self.error):self.bundle({**packet,**changed},self.token)
        stopped = {**packet,'status':'BLOCKED','reason_codes':['CORE_PRESENT'],'reports':[*reports[:4],{**reports[4],'status':'BLOCKED','reason_codes':['CORE_PRESENT']}]}
        self.assertEqual(self.bundle(stopped,self.token)['status'],'BLOCKED')

    def test_scope_string_or_callback_cannot_launch_a_production_helper(self):
        class Impostor:
            scope='QUALIFIED_HOST_PAUSE'
            profile=self.profile
            def check(self):raise AssertionError('Unqualified callback reached')
        with self.assertRaises(self.error):self.runner(Impostor(),object())

    def test_scope_string_cannot_exempt_a_same_uid_process_from_writer_detection(self):
        from rbridge_installation.host_backend import QualifiedHostBackend
        backend=object.__new__(QualifiedHostBackend);backend.profile=self.profile
        class Impostor:
            scope='QUALIFIED_FIXED_READONLY_HELPER'
            def matches_pid(self,pid):raise AssertionError('Forged exemption called')
        backend.readonly_helpers={31337:Impostor()}
        with patch('rbridge_installation.host_backend._assert_kernel_namespace'),patch.object(backend,'capture_service',return_value={'identity_sha256':self.profile.service.identity_sha256}),patch.object(backend,'_show',return_value={'ActiveState':'inactive','SubState':'dead','MainPID':'0'}),patch.object(backend,'_cgroup_pids',return_value=[]),patch('rbridge_installation.host_backend.os.listdir',return_value=['31337']),patch('rbridge_installation.host_backend._kernel_bytes',return_value=b'Uid:\t1027\t1027\t1027\t1027\n'):
            with self.assertRaisesRegex(self.error,'HOST_READONLY_HELPER_UNQUALIFIED'):backend.observe_pause(self.profile)

    def test_owned_child_pidfd_retains_liveness_and_exit_without_a_process_name_assumption(self):
        from rbridge_installation.readonly_helper import selectors_ready
        child=subprocess.Popen([sys.executable,'-I','-c','import sys;print("READY",flush=True);sys.stdin.buffer.read(1)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(),b'READY\n');fd=os.pidfd_open(child.pid,0)
            try:
                self.assertFalse(selectors_ready(fd));child.stdin.write(b'x');child.stdin.flush();child.wait(timeout=5);self.assertTrue(selectors_ready(fd))
            finally:os.close(fd)
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=5)
            child.stdin.close();child.stdout.close()


if __name__=='__main__':unittest.main()
