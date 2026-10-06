"""Kernel evidence comparisons, never an observed host authority."""
import unittest
from _loader import toolkit


class KernelNamespaceTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.host_backend import validate_kernel_namespace_evidence
        except ImportError:self.fail('Complete kernel namespace/mount comparison is not implemented')
        self.validate=validate_kernel_namespace_evidence
        self.value={'pid':17,'self_link':'17','self_status':'Pid:\t17\nNSpid:\t17\n',
            'pid1_status':'Pid:\t1\nNSpid:\t1\n','uid_map':'         0          0 4294967295\n',
            'gid_map':'         0          0 4294967295\n',
            'namespaces':{kind:[kind+':[123]',kind+':[123]'] for kind in ('pid','mnt','user','cgroup')},
            'mountinfo':'1 0 0:1 / /proc rw,nosuid - proc proc rw\n2 0 0:2 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup rw\n'}

    def test_full_process_view_maps_namespace_links_and_mounts_are_required(self):
        self.assertIsNone(self.validate(self.value))
        for change in ({'self_link':'18'}, {'self_status':'Pid:\t18\nNSpid:\t18\n'},
            {'self_status':'Pid:\t17\nNSpid:\t50\t17\n'}, {'pid1_status':'Pid:\t1\nNSpid:\t55\t1\n'},
            {'uid_map':'0 0 1\n'},{'gid_map':'0 0 1\n'},
            {'namespaces':{**self.value['namespaces'],'user':['user:[123]','user:[456]']}},
            {'mountinfo':self.value['mountinfo'].replace('- cgroup2','- tmpfs')},
            {'mountinfo':self.value['mountinfo'].replace('0:1 / /proc','0:1 /partial /proc')},
            {'mountinfo':self.value['mountinfo']+self.value['mountinfo'].splitlines()[1]+'\n'}):
            with self.subTest(change=change):self.assertRaises(ValueError,self.validate,{**self.value,**change})


if __name__=='__main__':unittest.main()
