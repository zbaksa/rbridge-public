"""Known canary DATA on a shared parent; Source fixtures confer no Root authority."""
import hashlib
import os
from pathlib import Path
import stat
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from _loader import toolkit


class SharedCanaryDataTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.acceptance_transport import _observe_fixture_canary
        self.observe = _observe_fixture_canary
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.shared = self.root / 'shared'
        self.shared.mkdir(mode=0o777)
        self.shared.chmod(0o777)
        self.path = self.shared / 'canary.txt'
        self.data = b'rbridge P2A installation canary a29 r1\n'
        self.path.write_bytes(self.data)
        self.path.chmod(0o444)

    def open(self, path=None, data=None):
        observed = self.observe(path or self.path, self.data if data is None else data)
        self.addCleanup(observed.close)
        return observed

    def test_exact_existing_canary_on_shared_parent_is_read_without_permission_changes(self):
        before = self.path.stat()
        parent = self.shared.stat()
        observed = self.open()
        report = observed.readback()
        self.assertEqual(report['sha256'], hashlib.sha256(self.data).hexdigest())
        self.assertEqual(report['bytes'], 39)
        self.assertEqual(observed.read_bytes(), self.data)
        self.assertEqual(report['scope'], 'SOURCE_CANARY_DATA_FIXTURE_ONLY')
        for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'):
            self.assertEqual(getattr(before, key), getattr(self.path.stat(), key))
        for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid'):
            self.assertEqual(getattr(parent, key), getattr(self.shared.stat(), key))
        self.assertEqual(stat.S_IMODE(self.shared.stat().st_mode), 0o777)

    def test_shared_parent_is_still_refused_for_root_control_file_protection(self):
        from rbridge_installation.protected_copy import ProtectedParent, FilesystemAuthority
        with self.assertRaisesRegex(ValueError, 'COPY_PARENT_UNPROTECTED'):
            ProtectedParent(FilesystemAuthority(os.getuid(), 1027, self.shared, 'RUNTIME', False))

    def test_parent_rename_above_leaf_is_refused_even_when_leaf_bytes_and_inode_survive(self):
        nested = self.shared / 'nested'
        nested.mkdir(mode=0o755)
        target = nested / 'known.txt'
        target.write_bytes(self.data)
        target.chmod(0o444)
        observed = self.open(target)
        inode = target.stat().st_ino
        moved = self.root / 'moved'
        self.shared.rename(moved)
        self.shared.mkdir(mode=0o777)
        self.assertEqual((moved / 'nested/known.txt').stat().st_ino, inode)
        self.assertEqual((moved / 'nested/known.txt').read_bytes(), self.data)
        with self.assertRaises(ValueError):
            observed.readback()

    def test_named_same_byte_replacement_does_not_repin_a_retained_observation(self):
        observed = self.open()
        self.path.unlink()
        self.path.write_bytes(self.data)
        self.path.chmod(0o444)
        with self.assertRaises(ValueError):
            observed.read_bytes()

    def test_parent_metadata_drift_is_refused(self):
        observed = self.open()
        self.shared.chmod(0o775)
        with self.assertRaises(ValueError):
            observed.readback()

    def test_unrelated_shared_directory_activity_does_not_repin_or_invalidate_canary(self):
        observed = self.open()
        previous = observed.readback()
        (self.shared / 'unrelated.txt').write_text('unrelated Source work')
        self.assertEqual(observed.readback(), previous)

    def test_stat_open_same_byte_swap_is_refused_and_descriptors_close(self):
        from rbridge_installation import canary_data
        real_open = os.open
        before = len(os.listdir('/proc/self/fd'))
        replaced = False

        def changing_open(path, flags, *args, **kwargs):
            nonlocal replaced
            if path == self.path.name and kwargs.get('dir_fd') is not None and not replaced:
                replaced = True
                self.path.rename(self.shared / 'preserved-original')
                self.path.write_bytes(self.data)
                self.path.chmod(0o444)
            return real_open(path, flags, *args, **kwargs)

        with patch.object(canary_data.os, 'open', changing_open):
            with self.assertRaisesRegex(ValueError, 'CANARY_DATA_FILE_CHANGED'):
                self.observe(self.path, self.data)
        self.assertTrue(replaced)
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)
        self.assertEqual((self.shared / 'preserved-original').read_bytes(), self.data)

    def test_change_during_read_is_refused(self):
        from rbridge_installation import canary_data
        observed = self.open()
        real_read = os.read
        changed = False

        def changing_read(fd, count):
            nonlocal changed
            raw = real_read(fd, count)
            if fd == observed.fd and not changed:
                changed = True
                self.path.chmod(0o644)
                self.path.write_bytes(self.data + b'x')
                self.path.chmod(0o444)
            return raw

        with patch.object(canary_data.os, 'read', changing_read):
            with self.assertRaises(ValueError):
                observed.read_bytes()
        self.assertTrue(changed)

    def test_reopened_same_byte_replacement_cannot_match_committed_data_identity(self):
        from rbridge_installation.canary_data import compare_canary_observation
        original = self.open()
        previous = original.readback()
        original.close()
        self.path.rename(self.shared / 'original-identity')
        self.path.write_bytes(self.data)
        self.path.chmod(0o444)
        current = self.open().readback()
        self.assertEqual(previous['sha256'], current['sha256'])
        self.assertNotEqual(previous['identity'], current['identity'])
        with self.assertRaisesRegex(ValueError, 'CANARY_DATA_OBSERVATION_CHANGED'):
            compare_canary_observation(current, previous)

    def test_wrong_source_owner_is_refused_before_file_open(self):
        from rbridge_installation import canary_data
        owner = os.getuid()
        with patch.object(canary_data.os, 'getuid', return_value=owner + 1):
            with self.assertRaisesRegex(ValueError, 'CANARY_DATA_FILE_UNQUALIFIED'):
                self.observe(self.path, self.data)

    def test_source_context_cannot_open_a_production_profile_canary(self):
        from _fixtures import valid_profile
        from rbridge_installation.canary_data import observe_profile_canary
        with patch('os.open', side_effect=AssertionError('Source cannot open a Root canary')):
            with self.assertRaisesRegex(ValueError, 'CANARY_DATA_ROOT_CONTEXT_UNQUALIFIED'):
                observe_profile_canary(valid_profile())

    def test_production_directory_metadata_policy_has_one_exact_shared_anchor(self):
        from rbridge_installation.canary_data import _CanaryDataObservation
        # Source-only predicate inputs: no Root path is opened and no origin
        # is issued. Owner/group/other search permission must not fall through.
        cases = [
            ('/', 0, 0, 0o755, None),
            ('/mnt', 0, 0, 0o755, None),
            ('/mnt/data', 1000, 1000, 0o777, None),
            ('/mnt/data', 1000, 1000, 0o1777, None),
            ('/mnt/data/child', 0, 0, 0o755, None),
            ('/mnt/data/child', 0, 0, 0o555, None),
            ('/', 1000, 1000, 0o755, 'CANARY_DATA_PARENT_UNPROTECTED'),
            ('/mnt', 1000, 1000, 0o755, 'CANARY_DATA_PARENT_UNPROTECTED'),
            ('/mnt/data/child', 1000, 1000, 0o755, 'CANARY_DATA_PARENT_UNPROTECTED'),
            ('/mnt/data/child', 0, 0, 0o775, 'CANARY_DATA_PARENT_UNPROTECTED'),
            ('/mnt/data/child', 0, 0, 0o757, 'CANARY_DATA_PARENT_UNPROTECTED'),
            ('/mnt/data/child', 0, 0, 0o4755, 'CANARY_DATA_PARENT_UNPROTECTED'),
            ('/mnt/data/child', 0, 0, 0o2755, 'CANARY_DATA_PARENT_UNPROTECTED'),
            ('/mnt/data', 1027, 1027, 0o700, None),
            ('/mnt/data', 1027, 1027, 0o611, 'CANARY_DATA_PARENT_UNREADABLE'),
            ('/mnt/data', 1000, 1027, 0o710, None),
            ('/mnt/data', 1000, 1027, 0o741, 'CANARY_DATA_PARENT_UNREADABLE'),
            ('/mnt/data', 1000, 1000, 0o701, None),
            ('/mnt/data', 1000, 1000, 0o710, 'CANARY_DATA_PARENT_UNREADABLE'),
            ('/mnt/data/child', 0, 1027, 0o710, None),
            ('/mnt/data/child', 0, 1027, 0o741, 'CANARY_DATA_PARENT_UNREADABLE'),
        ]
        policy = SimpleNamespace(production=True)
        with patch('os.open', side_effect=AssertionError('metadata predicate must not open paths')):
            for path, uid, gid, mode, error in cases:
                with self.subTest(path=path, uid=uid, gid=gid, mode=oct(mode)):
                    row = SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=uid, st_gid=gid)
                    if error is None:
                        _CanaryDataObservation._directory(policy, Path(path), row)
                    else:
                        with self.assertRaisesRegex(ValueError, error):
                            _CanaryDataObservation._directory(policy, Path(path), row)
            regular = SimpleNamespace(st_mode=stat.S_IFREG | 0o777, st_uid=1000, st_gid=1000)
            with self.assertRaisesRegex(ValueError, 'CANARY_DATA_PARENT_INVALID'):
                _CanaryDataObservation._directory(policy, Path('/mnt/data'), regular)

    def test_parent_and_leaf_symlinks_and_hardlinks_are_refused(self):
        link = self.root / 'alias'
        link.symlink_to(self.shared, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.observe(link / 'canary.txt', self.data)
        leaf = self.shared / 'link.txt'
        leaf.symlink_to(self.path)
        with self.assertRaises(ValueError):
            self.observe(leaf, self.data)
        hard = self.shared / 'hard.txt'
        os.link(self.path, hard)
        with self.assertRaises(ValueError):
            self.observe(self.path, self.data)
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_missing_special_oversized_wrong_bytes_and_writable_leaf_are_refused(self):
        with self.assertRaises(ValueError):
            self.observe(self.shared / 'absent', self.data)
        self.assertFalse((self.shared / 'absent').exists())
        fifo = self.shared / 'fifo'
        os.mkfifo(fifo, 0o444)
        before = time.monotonic()
        with self.assertRaises(ValueError):
            self.observe(fifo, self.data)
        self.assertLess(time.monotonic() - before, 1)
        large = self.shared / 'large'
        large.write_bytes(b'x' * 4097)
        large.chmod(0o444)
        with self.assertRaises(ValueError):
            self.observe(large, self.data)
        with self.assertRaises(ValueError):
            self.observe(self.path, b'different approved data\n')
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.observe(self.path, self.data)
        self.assertEqual(self.path.read_bytes(), self.data)

    def test_invalid_expected_data_and_path_are_refused(self):
        for data in (b'', b'x' * 4097, b'\xff', 'not bytes'):
            with self.subTest(data_type=type(data).__name__, size=len(data)):
                with self.assertRaises(ValueError):
                    self.observe(self.path, data)
        for path in ('relative/canary', str(self.shared) + '/../shared/canary.txt', str(self.path) + '\0', None, 17):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    self.observe(path, self.data)


if __name__ == '__main__':
    unittest.main()
