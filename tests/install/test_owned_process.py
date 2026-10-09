"""Closed helper-family predicates; source fixtures grant no Root authority."""
import copy
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
from types import SimpleNamespace
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

    def test_boolean_and_float_kernel_identities_cannot_equal_integer_rows(self):
        for key,value in [('uid',[False]*4),('gid',[False]*4),('groups',[False]),
                          ('ppid',10.0),('session',20.0)]:
            parent=copy.deepcopy(self.parent);parent[key]=value
            with self.subTest(key=key):
                self.assertRaises(ValueError,self.validate,parent,[parent,self.node,self.mcp],self.specs)

    def test_session_census_ignores_same_identity_that_becomes_zombie_during_row_capture(self):
        from rbridge_installation import owned_process as owned
        live = {'pid':31337,'state':'R','ppid':1,'session':31337,'start_ticks':'123456'}
        zombie = {**live,'state':'Z'}
        status = b'Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t0\n'
        def kernel(path, limit=65536):
            if path.endswith('/status'): return status
            if path.endswith('/cmdline'): return b''
            raise AssertionError(path)
        with patch.object(owned,'_assert_kernel_namespace',lambda:None), \
             patch.object(owned.os,'listdir',return_value=['31337']), \
             patch.object(owned,'_stat',side_effect=[live,zombie]), \
             patch.object(owned,'_kernel_bytes',side_effect=kernel):
            self.assertEqual(owned._session_rows(31337,10**12),[])

    def test_nonroot_or_incoherent_namespace_blocks_before_process_launch(self):
        with patch('rbridge_installation.owned_process.subprocess.Popen') as launch:
            if os.getuid() != 0:
                self.assertRaises(ValueError, self.run, None, (), 1000, 4096)
            else:
                with patch('rbridge_installation.owned_process._assert_kernel_namespace', side_effect=ValueError('incoherent')):
                    self.assertRaises(ValueError, self.run, None, (), 1000, 4096)
            launch.assert_not_called()

    def test_launch_and_heartbeat_callbacks_cannot_bypass_root_preconditions(self):
        from unittest.mock import Mock
        started, heartbeat, ready = Mock(), Mock(), Mock()
        with patch('rbridge_installation.owned_process.subprocess.Popen') as launch:
            with patch('rbridge_installation.owned_process._assert_kernel_namespace',side_effect=ValueError('incoherent')):
                self.assertRaises(ValueError,self.run,None,(),1000,4096,
                    started=started,heartbeat=heartbeat,ready=ready)
            launch.assert_not_called();started.assert_not_called()
            heartbeat.assert_not_called();ready.assert_not_called()

    def helper_fixture(self,unclassified=False):
        """Actual child/pipes/pidfds with Source proc and journal adapters only."""
        from contextlib import ExitStack
        from rbridge_installation import owned_process as owned,helper_journal as journal
        from rbridge_installation.protected_copy import DIR_FLAGS
        stack=ExitStack();self.addCleanup(stack.close)
        root=Path(stack.enter_context(tempfile.TemporaryDirectory()));root.chmod(0o700)
        parent=os.open(root,DIR_FLAGS);stack.callback(os.close,parent)
        binary='/usr/bin/python3';binary_bytes=Path(binary).read_bytes()
        pin=SimpleNamespace(path=binary,sha256=hashlib.sha256(binary_bytes).hexdigest())
        args=['-I','-S','-c','import time; time.sleep(10)'];children=[]
        real_popen=subprocess.Popen
        def launch(*a,**kw):
            child=real_popen(*a,**kw);children.append(child);return child
        def token(pid):return {'pid':pid,'state':'S','ppid':os.getpid(),'session':pid,'start_ticks':'123456'}
        def row(pid,t):return {'pid':pid,'start_ticks':t['start_ticks'],'ppid':os.getpid(),'session':pid,
            'uid':[0]*4,'gid':[0]*4,'groups':[0],'exe':binary,'argv':[binary,*args]}
        censuses=[]
        def census(pid,deadline):
            child=next(c for c in children if c.pid==pid)
            if child.poll() is not None:return []
            value=row(pid,token(pid));censuses.append(pid)
            if unclassified and len(censuses)>1:value['argv']=[binary,'unexpected']
            return [value]
        def begin(pin,a,data,specs):
            for name in sorted(os.listdir(parent)):journal.inspect_helper_journal(parent,name,production=False)
            value={'argv':[pin.path,*a],'executable_sha256':pin.sha256,
                'input_sha256':hashlib.sha256(data).hexdigest(),'child_specs_sha256':journal.report_sha256(specs)}
            return journal._open_fixture_helper_journal(parent,secrets.token_hex(16),value)
        # Patch this module's os view; the fixture journal keeps the actual UID.
        root_os=SimpleNamespace(**{**vars(os),'getuid':lambda:0,'geteuid':lambda:0})
        for obj,name,value in [(owned,'os',root_os),(owned,'_assert_kernel_namespace',lambda:None),
                (owned,'_protected_bytes',lambda *a:binary_bytes),(owned,'_stat',token),
                (owned,'_row',row),(owned,'_session_rows',census),
                (owned.subprocess,'Popen',launch),(journal,'begin_root_helper',begin)]:
            stack.enter_context(patch.object(obj,name,value))
        def cleanup_pending():
            for child in children:owned._pending_sessions.pop(child.pid,None)
        stack.callback(cleanup_pending)
        return owned,journal,parent,root,pin,args,children

    def test_timed_out_identified_dead_family_settles_without_operation_success(self):
        owned,journal,parent,root,pin,args,children=self.helper_fixture()
        self.assertRaisesRegex(ValueError,'OWNED_HELPER_DEADLINE',owned.run_owned_process,pin,args,30,4096)
        self.assertIsNotNone(children[0].returncode)
        self.assertNotIn(children[0].pid,owned._pending_sessions)
        first=next(root.iterdir());record=journal.inspect_helper_journal(parent,first.name,production=False)
        self.assertEqual(record['origin_scope'],'FIXTURE_AUTHORITY_ONLY')
        # A separate fixed launch can reach Popen after the failed operation.
        self.assertRaisesRegex(ValueError,'OWNED_HELPER_DEADLINE',owned.run_owned_process,pin,args,30,4096)
        self.assertEqual(len(children),2)

    def test_observed_identity_change_keeps_dead_family_unsettled(self):
        owned,journal,parent,root,pin,args,children=self.helper_fixture(unclassified=True)
        self.assertRaisesRegex(ValueError,'OWNED_HELPER_PARENT_CHANGED|OWNED_HELPER_IDENTITY_CHANGED',
            owned.run_owned_process,pin,args,100,4096)
        self.assertIsNotNone(children[0].returncode)
        self.assertIn(children[0].pid,owned._pending_sessions)
        first=next(root.iterdir());self.assertFalse((first/'settled.json').exists())
        self.assertRaisesRegex(ValueError,'HELPER_JOURNAL_UNSETTLED',owned.run_owned_process,pin,args,30,4096)
        self.assertEqual(len(children),1)


if __name__ == '__main__': unittest.main()
