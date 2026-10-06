"""Closed helper-family predicates; source fixtures grant no Root authority."""
import copy
import os
import unittest
from unittest.mock import patch
from _loader import toolkit


class OwnedProcessTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.owned_process import validate_owned_session, run_owned_process
        except ImportError:
            self.fail('Fixed helper-family settlement is not implemented')
        self.validate, self.run = validate_owned_session, run_owned_process
        self.parent = {'pid': 20, 'start_ticks': '100', 'ppid': 10, 'session': 20,
            'uid': [0] * 4, 'gid': [0] * 4, 'groups': [0],
            'exe': '/usr/sbin/runuser', 'argv': ['/usr/sbin/runuser', '--user', 'rbridge', '--', '/usr/bin/node', '/protected/reader.js']}
        self.node = {'pid': 21, 'start_ticks': '101', 'ppid': 20, 'session': 20,
            'uid': [1027] * 4, 'gid': [1027] * 4, 'groups': [1027],
            'exe': '/usr/bin/node', 'argv': ['/usr/bin/node', '/protected/reader.js']}
        self.mcp = {**self.node, 'pid': 22, 'start_ticks': '102', 'ppid': 21,
            'argv': ['/usr/bin/node', '/protected/mcp.js']}
        self.specs = [
            {'exe': '/usr/bin/node', 'argv': self.node['argv'], 'uid': 1027,
             'gid': 1027, 'groups': [], 'parent_argv': self.parent['argv'], 'max_count': 1},
            {'exe': '/usr/bin/node', 'argv': self.mcp['argv'], 'uid': 1027,
             'gid': 1027, 'groups': [], 'parent_argv': self.node['argv'], 'max_count': 2}]

    def test_exact_reader_and_two_sdk_children_form_one_owned_session(self):
        second = {**self.mcp, 'pid': 23, 'start_ticks': '103'}
        self.assertEqual(self.validate(self.parent, [self.parent, self.node, self.mcp, second], self.specs), [20, 21, 22, 23])

    def test_unknown_argv_uid_group_parent_or_extra_child_cannot_settle(self):
        for key, value in [('argv', ['/usr/bin/node', '/unexpected.js']),
                           ('uid', [0] * 4), ('groups', [0, 1027]),
                           ('ppid', 1), ('session', 30), ('start_ticks', '90')]:
            with self.subTest(key=key):
                row = copy.deepcopy(self.mcp); row[key] = value
                self.assertRaises(ValueError, self.validate, self.parent,
                    [self.parent, self.node, row], self.specs)
        more = [{**self.mcp, 'pid': i, 'start_ticks': str(102 + i)} for i in (22, 23, 24)]
        self.assertRaises(ValueError, self.validate, self.parent,
            [self.parent, self.node, *more], self.specs)

    def test_reused_parent_pid_and_missing_parent_during_activity_are_unknown(self):
        reused = {**self.parent, 'start_ticks': '999'}
        self.assertRaises(ValueError, self.validate, self.parent,
            [reused, self.node], self.specs)
        self.assertRaises(ValueError, self.validate, self.parent,
            [self.node, self.mcp], self.specs)

    def test_nonroot_or_incoherent_namespace_blocks_before_process_launch(self):
        with patch('rbridge_installation.owned_process.subprocess.Popen') as launch:
            if os.getuid() != 0:
                self.assertRaises(ValueError, self.run, None, (), 1000, 4096)
            else:
                with patch('rbridge_installation.owned_process._assert_kernel_namespace', side_effect=ValueError('incoherent')):
                    self.assertRaises(ValueError, self.run, None, (), 1000, 4096)
            launch.assert_not_called()


if __name__ == '__main__': unittest.main()
