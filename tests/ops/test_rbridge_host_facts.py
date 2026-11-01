import hashlib
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'ops/diagnostics/rbridge_host_facts.py'


class HostFactsTests(unittest.TestCase):
    def load(self):
        self.assertTrue(SOURCE.exists(), 'read-only host collector has not been implemented')
        spec = importlib.util.spec_from_file_location('host_facts_under_test', SOURCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_wrong_host_is_rejected_before_observations(self):
        m = self.load()
        with patch.object(m.socket, 'gethostname', return_value='different-host'), patch.object(m.subprocess, 'run', side_effect=AssertionError('unexpected service call')):
            with self.assertRaisesRegex(m.Blocked, 'WRONG_HOST'):
                m.check_context('expected-host', 0, 0, True, True, True)

    def test_nonroot_or_unisolated_context_is_rejected(self):
        m = self.load()
        host = m.socket.gethostname()
        for context in [(1000, 1000, True, True, True), (0, 0, False, True, True), (0, 0, True, False, True), (0, 0, True, True, False)]:
            with self.subTest(context=context), self.assertRaises(m.Blocked):
                m.check_context(host, *context)

    def test_hostname_requires_exact_full_identity(self):
        m = self.load()
        with patch.object(m.socket, 'gethostname', return_value='bridge.other.example'):
            with self.assertRaisesRegex(m.Blocked, 'WRONG_HOST'):
                m.check_context('bridge', 0, 0, True, True, True)
            with self.assertRaisesRegex(m.Blocked, 'WRONG_HOST'):
                m.check_context('bridge.expected.example', 0, 0, True, True, True)
            m.check_context('bridge.other.example', 0, 0, True, True, True)

    def test_component_cannot_select_command_or_noncode_path(self):
        m = self.load()
        valid = 'worker=/usr/local/libexec/example/worker.py=' + 'a' * 64
        self.assertEqual(m.parse_component(valid), ('worker', '/usr/local/libexec/example/worker.py', 'a' * 64))
        for value in ['worker=/bin/sh=' + 'a' * 64, 'worker=/etc/shadow=' + 'a' * 64, 'worker=/usr/local/libexec/../worker.py=' + 'a' * 64, 'worker=/usr/local/libexec/x.py=bad', '../worker=/usr/local/libexec/x.py=' + 'a' * 64]:
            with self.subTest(value=value), self.assertRaises(m.Blocked):
                m.parse_component(value)

    def test_component_cannot_shadow_mandatory_hold_observation(self):
        m = self.load()
        with self.assertRaisesRegex(m.Blocked, 'COMPONENT_NAME_INVALID'):
            m.parse_component('hold=/usr/local/libexec/example/worker.py=' + 'a' * 64)

    def test_unit_argument_cannot_be_a_systemctl_option(self):
        m = self.load()
        with patch.object(m.subprocess, 'run', side_effect=AssertionError('option must never reach systemctl')):
            with self.assertRaisesRegex(m.Blocked, 'UNIT_NAME_INVALID'):
                m.unit_info('--test.service')

    def test_cli_wrong_host_emits_blocked_before_collect(self):
        m = self.load()
        output = io.StringIO()
        expected = m.socket.gethostname() + '-different'
        with contextlib.redirect_stdout(output), patch.object(m, 'collect', side_effect=AssertionError('must not collect')):
            rc = m.main(['--host', expected, '--runtime-uid', '1000', '--hold-sha', 'a' * 64])
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(output.getvalue())['reason'], 'WRONG_HOST')

    def test_cli_nonroot_emits_blocked_before_collect(self):
        m = self.load()
        output = io.StringIO()
        host = m.socket.gethostname()
        with contextlib.redirect_stdout(output), patch.object(m.os, 'geteuid', return_value=1000), patch.object(m.os, 'getegid', return_value=1000), patch.object(m, 'collect', side_effect=AssertionError('must not collect')):
            rc = m.main(['--host', host, '--runtime-uid', '1000', '--hold-sha', 'a' * 64])
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(output.getvalue())['reason'], 'ROOT_READER_REQUIRED')

    def test_regular_read_hashes_exact_bytes_and_reports_identity(self):
        m = self.load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file.py'
            path.write_bytes(b'print("bounded")\n')
            raw, metadata = m.read_regular(str(path), 4096)
            self.assertEqual(raw, b'print("bounded")\n')
            self.assertEqual(metadata['sha256'], hashlib.sha256(b'print("bounded")\n').hexdigest())
            self.assertEqual(metadata['uid'], os.getuid())
            self.assertEqual(metadata['bytes'], 17)

    def test_symlinks_and_hardlinks_are_refused(self):
        m = self.load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file.py'
            path.write_bytes(b'x')
            link = Path(directory) / 'link.py'
            link.symlink_to(path)
            with self.assertRaises(m.Blocked):
                m.read_regular(str(link), 4096)
            link.unlink()
            os.link(path, link)
            with self.assertRaises(m.Blocked):
                m.read_regular(str(path), 4096)

    def test_oversized_files_are_refused_before_read(self):
        m = self.load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file.py'
            path.write_bytes(b'x' * 11)
            with patch.object(m.os, 'read', side_effect=AssertionError('oversize must not be read')):
                with self.assertRaisesRegex(m.Blocked, 'FILE_UNTRUSTED'):
                    m.read_regular(str(path), 10)

    def test_file_change_during_read_is_not_accepted(self):
        m = self.load()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'file.py'
            path.write_bytes(b'old')
            real_read = os.read
            def mutate(fd, count):
                raw = real_read(fd, count)
                path.write_bytes(b'new bytes')
                return raw
            with patch.object(m.os, 'read', side_effect=mutate):
                with self.assertRaisesRegex(m.Blocked, 'FILE_CHANGED'):
                    m.read_regular(str(path), 4096)

    def test_ancestor_replacement_is_rejected_with_descriptor_anchoring(self):
        m = self.load()
        # Only ownership/mode trust is simulated for this nonprivileged fixture.
        # Directory rename, symlink substitution and fd-relative reads are real.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            parent, outside, retained = base / 'checked', base / 'outside', base / 'retained'
            parent.mkdir(); outside.mkdir()
            target = parent / 'worker.py'
            target.write_bytes(b'original code')
            (outside / 'worker.py').write_bytes(b'outside code')
            expected = hashlib.sha256(b'original code').hexdigest()
            real_open, real_stat, real_lstat, real_fstat = os.open, os.stat, os.lstat, os.fstat
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_gid', 'st_mode', 'st_nlink')
            def trusted(info):
                row = {field: getattr(info, field) for field in fields}
                row.update(st_uid=0, st_gid=0, st_mode=info.st_mode & ~0o022)
                return SimpleNamespace(**row)
            replaced = False
            def replace_before_leaf(path, flags, *args, **kwargs):
                nonlocal replaced
                if str(path) in (str(target), 'worker.py') and not replaced:
                    parent.rename(retained)
                    parent.symlink_to(outside, target_is_directory=True)
                    replaced = True
                return real_open(path, flags, *args, **kwargs)
            with patch.object(m.os, 'stat', side_effect=lambda *a, **k: trusted(real_stat(*a, **k))), patch.object(m.os, 'lstat', side_effect=lambda *a, **k: trusted(real_lstat(*a, **k))), patch.object(m.os, 'fstat', side_effect=lambda *a, **k: trusted(real_fstat(*a, **k))):
                self.assertTrue(m.trusted_file(str(target), 4096, expected)['expectedShaMatches'])
                with patch.object(m.os, 'open', side_effect=replace_before_leaf):
                    with self.assertRaises(m.Blocked):
                        m.trusted_file(str(target), 4096, expected)
            self.assertTrue(replaced)

    def test_actual_process_uid_mismatch_is_rejected(self):
        m = self.load()
        with self.assertRaisesRegex(m.Blocked, 'BRIDGE_PROCESS_UID_CHANGED'):
            m.process_identity(os.getpid(), os.getuid() + 1)

    def test_collect_detects_unit_or_start_tick_changes(self):
        m = self.load()
        args = SimpleNamespace(runtime_uid=1000, hold_sha='a' * 64, component=[], unit=[])
        before = {'MainPID': '123', 'ActiveState': 'active', 'InvocationID': 'first'}
        bridge = {'pid': 123, 'startTick': '100', 'runtimeUid': 1000, 'holdPinPresent': True, 'holdPinMatches': True, 'releaseSha': 'b' * 40}
        for after, tick in [({**before, 'InvocationID': 'second'}, '100'), (before, '101')]:
            with self.subTest(after=after, tick=tick), patch.object(m, 'unit_info', side_effect=[before, after]), patch.object(m, 'bridge_info', return_value=bridge), patch.object(m, 'trusted_file', return_value={'expectedShaMatches': True}), patch.object(m, 'process_identity', return_value=tick):
                with self.assertRaisesRegex(m.Blocked, 'BRIDGE_CHANGED_DURING_OBSERVATION'):
                    m.collect(args)
        with patch.object(m, 'unit_info', side_effect=[before, before]), patch.object(m, 'bridge_info', return_value=bridge), patch.object(m, 'trusted_file', return_value={'expectedShaMatches': True}), patch.object(m, 'process_identity', return_value='100'):
            result = m.collect(args)
        self.assertEqual(result['status'], 'OBSERVED_ONLY')
        self.assertEqual(result['productionGo'], 'UNKNOWN')
        self.assertEqual(result['nativeControllerFence'], 'UNKNOWN')
        self.assertEqual(result['originalWriterDisposition'], 'UNKNOWN')

    def test_environment_discloses_only_selected_keys(self):
        m = self.load()
        raw = b'API_TOKEN=never-print\0RBRIDGE_RELEASE_SHA=' + b'a' * 40 + b'\0RBRIDGE_OWNER_HOLD_SHA256=' + b'b' * 64 + b'\0'
        values = m.selected_environment(raw)
        self.assertEqual(values, {'RBRIDGE_RELEASE_SHA': 'a' * 40, 'RBRIDGE_OWNER_HOLD_SHA256': 'b' * 64})
        self.assertNotIn('never-print', str(values))
        with self.assertRaisesRegex(m.Blocked, 'DUPLICATED_ENV_KEY'):
            m.selected_environment(raw + b'RBRIDGE_RELEASE_SHA=' + b'c' * 40 + b'\0')


if __name__ == '__main__':
    unittest.main()
