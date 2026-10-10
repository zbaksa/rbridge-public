"""Two fresh kernel snapshots never prove the missing historical PID."""
import copy
import unittest
from unittest.mock import patch
from _loader import toolkit

class OrphanKernelCensusTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_kernel_census import (
            classify_process_snapshot,collect_root_kernel_census,
            _confirmed_kernel_thread)
        self.classify=classify_process_snapshot
        self.collect=collect_root_kernel_census
        self.kthread=_confirmed_kernel_thread
        self.row={'pid':109,'state':'S','ppid':1,'session':109,
                  'start_ticks':'98765','exe':'/usr/bin/python3'}

    def test_known_non_systemctl_snapshot_is_only_data(self):
        result=self.classify([self.row])
        self.assertEqual(result,{'count':1,'candidates':[]})

    def test_live_systemctl_or_deleted_executable_remains_candidate(self):
        for exe in ('/usr/bin/systemctl','/usr/lib/systemd/systemctl',
                    '/usr/bin/systemctl (deleted)'):
            with self.subTest(exe=exe):
                row={**self.row,'exe':exe}
                self.assertEqual(self.classify([row])['candidates'],[109])

    def test_zombie_never_becomes_live_systemctl_candidate(self):
        row={**self.row,'state':'Z','exe':'/usr/bin/systemctl'}
        self.assertEqual(self.classify([row])['candidates'],[])

    def test_empty_or_duplicate_roster_refused(self):
        for rows in ([],[self.row,self.row],
                     [dict(self.row,pid=True)],
                     [dict(self.row,pid=-1)]):
            with self.subTest(rows=rows):
                with self.assertRaises(ValueError):
                    self.classify(rows)

    def test_unknown_types_or_missing_fields_refused(self):
        for field,value in (
            ('pid',None),('ppid',True),('session',None),
            ('start_ticks','0'),('start_ticks','x'),('state','ZZ'),
            ('exe','systemctl'),('exe',None)):
            with self.subTest(field=field):
                altered=copy.deepcopy(self.row);altered[field]=value
                with self.assertRaises(ValueError):
                    self.classify([altered])
        altered=copy.deepcopy(self.row);altered['extra']='surprise'
        with self.assertRaises(ValueError):self.classify([altered])
        del altered['start_ticks']
        with self.assertRaises(ValueError):self.classify([altered])

    def test_kthreadd_requires_kernel_flag_and_empty_commandline(self):
        from rbridge_installation import host_backend,owned_process
        token={'pid':2,'state':'S','ppid':0,'session':2,
               'start_ticks':'98765'}
        fields=[b'S',b'0',b'2',b'2',b'0',b'0',b'2097152']+[b'0']*12+[b'98765']
        def check(flag,cmd=b'',prefix=b'2'):
            values=list(fields);values[6]=str(flag).encode()
            raw=prefix+b' (kthreadd) '+b' '.join(values)+b'\n'
            def read(path,limit=65536):
                if path.endswith('/stat'):return raw
                if path.endswith('/cmdline'):return cmd
                raise AssertionError(path)
            with patch.object(host_backend,'_kernel_bytes',side_effect=read), \
                 patch.object(owned_process,'_stat',return_value=token):
                return self.kthread(2,token)
        self.assertIs(check(0x00200000),True)
        self.assertIs(check(0),False)
        self.assertIs(check(0x00200000,b'fake-userspace'),False)
        with self.assertRaisesRegex(ValueError,'ORPHAN_CENSUS_KTHREAD_UNCLASSIFIED'):
            check(0x00200000,prefix=b'3')
        self.assertIs(self.kthread(109,{'ppid':1}),False)

    def test_no_source_fixture_can_issue_root_kernel_origin(self):
        import os
        if os.geteuid()!=0:
            with self.assertRaisesRegex(ValueError,'ORPHAN_CENSUS_ROOT_REQUIRED'):
                self.collect()

if __name__=='__main__':
    unittest.main()
