import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile


class FixtureBackend:
    scope = 'FIXTURE_AUTHORITY_ONLY'
    def __init__(self): self.state = 'ABSENT'; self.cgroup_settled = True
    def observe_process_unit(self, profile, session_id):
        return {'unit': 'cocwin-remote-bridge-process-' + session_id + '.service',
                'cgroup': '', 'settled': self.cgroup_settled,
                'invocation_sha256': 'f' * 64}
    def probe_process(self, pid):
        return None if self.state == 'ABSENT' else {
            'pid': pid, 'startTimeTicks': '123', 'exe': '/fixture/node',
            'cmdlineSha256': 'e' * 64,
        }


class FixtureLease:
    scope = 'FIXTURE_AUTHORITY_ONLY'
    def __init__(self, profile): self.profile = profile; self.backend = FixtureBackend(); self.checks = 0
    def check(self): self.checks += 1


class ProcessObservationTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.process_observation import collect_process_observations, probe_kernel_process
        except ImportError:
            self.fail('Qualified process observations are not implemented')
        from rbridge_installation.models import InstallationError, report_sha256, record
        from rbridge_installation.profile import parse_profile
        self.collect, self.probe, self.error = collect_process_observations, probe_kernel_process, InstallationError
        self.sha, self.record = report_sha256, record
        self.profile = parse_profile(valid_profile()); self.lease = FixtureLease(self.profile)
        self.token = {'transaction_id': 'a' * 32, 'state_root_identity_sha256': '1' * 64,
                      'tree_sha256': '2' * 64, 'entries': 4, 'bytes': 12,
                      'pause_sha256': '3' * 64, 'captured_at': '2026-10-06T00:00:00.000Z'}
        self.target = {'session_id': 'a' * 32, 'pid': 31337, 'start_ticks': '123',
                       'identity_sha256': self.sha({'pid': 31337, 'startTimeTicks': '123',
                                                   'exe': '/fixture/node', 'cmdlineSha256': 'e' * 64})}

    def test_fixture_scope_is_explicit_and_pause_is_checked_around_each_observation(self):
        result = self.collect(self.lease, self.token, [self.target])
        self.assertEqual(len(result), 1); self.assertTrue(result[0].settled)
        self.assertEqual(result[0].scope, 'FIXTURE_AUTHORITY_ONLY')
        self.assertEqual(result[0].snapshot_sha256, self.sha(self.token))
        self.assertGreaterEqual(self.lease.checks, 2)

    def test_live_identity_unsettled_cgroup_and_reused_pid_do_not_settle(self):
        self.lease.backend.state = 'MATCHING'
        self.assertEqual(self.collect(self.lease, self.token, [self.target])[0].process_state, 'MATCHING')
        self.assertFalse(self.collect(self.lease, self.token, [self.target])[0].settled)
        changed = {**self.target, 'start_ticks': '456'}
        self.assertEqual(self.collect(self.lease, self.token, [changed])[0].process_state, 'REUSED')
        self.lease.backend.state = 'ABSENT'; self.lease.backend.cgroup_settled = False
        self.assertFalse(self.collect(self.lease, self.token, [self.target])[0].settled)

    def test_spoofed_live_scope_invalid_targets_duplicates_and_integer_booleans_block(self):
        self.lease.scope = 'QUALIFIED_HOST_PAUSE'
        with self.assertRaises(self.error): self.collect(self.lease, self.token, [self.target])
        self.lease.scope = 'FIXTURE_AUTHORITY_ONLY'
        for targets in ([self.target, self.target], [{**self.target, 'session_id': '../../escape'}],
                        [{**self.target, 'pid': True}], [{**self.target, 'unexpected': 'argument'}]):
            with self.assertRaises(self.error): self.collect(self.lease, self.token, targets)
        result = self.collect(self.lease, self.token, [self.target])[0]
        from dataclasses import asdict
        with self.assertRaises(ValueError): self.record('ProcessObservation', {**asdict(result), 'settled': 1})

    def test_kernel_probe_captures_a_real_waiting_child_without_signalling_it(self):
        child = subprocess.Popen([sys.executable, '-I', '-c',
                                  'import sys; print("READY", flush=True); sys.stdin.buffer.read(1)'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        self.assertEqual(child.stdout.readline(), b'READY\n')
        if os.readlink('/proc/self') != str(os.getpid()):
            with self.assertRaisesRegex(self.error, 'HOST_KERNEL_NAMESPACE_UNQUALIFIED'):
                self.probe(child.pid)
        else:
            first = self.probe(child.pid); second = self.probe(child.pid)
            self.assertEqual(first, second); self.assertEqual(first['pid'], child.pid)
        self.assertIsNone(child.poll())
        child.stdin.write(b'x'); child.stdin.flush(); child.wait(timeout=5)
        if os.readlink('/proc/self') == str(os.getpid()): self.assertIsNone(self.probe(child.pid))
        child.stdin.close(); child.stdout.close()

    def test_partial_or_changed_kernel_identity_never_becomes_absent(self):
        with patch('rbridge_installation.process_observation.os.readlink', side_effect=FileNotFoundError()):
            with self.assertRaises(self.error): self.probe(os.getpid())

    def test_complete_cgroup_subtree_is_examined_and_malformed_membership_blocks(self):
        from rbridge_installation.host_backend import QualifiedHostBackend
        backend = object.__new__(QualifiedHostBackend); backend.profile = self.profile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'cgroup.procs').write_bytes(b'17\n')
            (root / 'nested').mkdir(); (root / 'nested/cgroup.procs').write_bytes(b'23\n')
            self.assertEqual(backend._subtree_pids(root), [17, 23])
            (root / 'nested/cgroup.procs').write_bytes(b'23\npartial')
            with self.assertRaises(self.error): backend._subtree_pids(root)

    def test_user_unit_observer_has_fixed_arguments_and_rejects_changed_invocation(self):
        from rbridge_installation.host_backend import QualifiedHostBackend
        backend = object.__new__(QualifiedHostBackend); backend.profile = self.profile
        backend.tool = next(t for t in self.profile.tools if t.role == 'systemctl')
        runuser = next(t for t in self.profile.tools if t.role == 'runuser')
        rows = b'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlGroup=\nInvocationID=\n'
        calls = []
        def source_fixture_run(pin, args, timeout, limit, env=None):
            calls.append((pin.role, args, timeout, limit, env))
            return (runuser.version + '\n').encode() if args == ('--version',) else rows
        with patch('rbridge_installation.host_backend._assert_kernel_namespace'), \
             patch.object(backend, '_qualify_tool'), \
             patch('rbridge_installation.host_backend._run_fixed_tool', side_effect=source_fixture_run):
            result = backend.observe_process_unit(self.profile, self.target['session_id'])
            self.assertTrue(result['settled']); self.assertEqual(len(calls), 3)
            self.assertEqual(calls[1][1][:4], ('--user', 'rbridge', '--', backend.tool.path))
            self.assertEqual(calls[1][4]['XDG_RUNTIME_DIR'], '/run/user/1027')
            with self.assertRaises(self.error): backend.observe_process_unit(self.profile, '../../injected')
        with patch('rbridge_installation.host_backend._assert_kernel_namespace'), \
             patch.object(backend, '_qualify_tool'), \
             patch('rbridge_installation.host_backend._run_fixed_tool', side_effect=[
                 (runuser.version + '\n').encode(), rows, rows.replace(b'InvocationID=\n', b'InvocationID=changed\n')]):
            with self.assertRaises(self.error): backend.observe_process_unit(self.profile, self.target['session_id'])
