"""Source collector calls cannot create or operate even a fake Root unit."""
import unittest
from unittest.mock import Mock,patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import report_sha256
from rbridge_installation.profile import parse_profile


class FakeUnitCollectorTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.fake_unit_collector import collect_root_fake_unit_stop,verify_root_fake_unit_observation,_RootFakeUnitObservation
        except ImportError:self.fail('Protected fixed fake-unit Root collector is absent')
        self.collect,self.verify,self.Token=collect_root_fake_unit_stop,verify_root_fake_unit_observation,_RootFakeUnitObservation
        self.profile=parse_profile(valid_profile())

    def test_source_context_refuses_open_unit_symlink_chown_and_systemctl(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')),patch('os.symlink',side_effect=AssertionError('Source unit link')), \
             patch('rbridge_installation.owned_process.subprocess.Popen',side_effect=AssertionError('Source manager action')):
            self.assertRaisesRegex(ValueError,'FAKE_UNIT_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,self.profile,None,None,{})

    def test_scope_and_constructed_token_cannot_register_origin(self):
        token=self.Token('a'*64,'{}','/root/.rbridge-fake-unit-'+'b'*32)
        for value in (token,{'scope':'ROOT_PROTECTED_FAKE_UNIT_STOP_OBSERVATION','status':'PASS'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'FAKE_UNIT_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.profile,value,{})

    def test_matching_private_source_entry_still_meets_real_root_guard(self):
        from rbridge_installation import fake_unit_collector as collector
        token=self.Token(report_sha256(self.profile),'{}','/root/.rbridge-fake-unit-'+'b'*32)
        collector._observations[token]=(report_sha256(token),None,None,self.profile)
        try:
            with patch('os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'FAKE_UNIT_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.verify,self.profile,token,{})
        finally:del collector._observations[token]

    def test_mutated_private_source_entry_refuses_before_io(self):
        from rbridge_installation import fake_unit_collector as collector
        token=self.Token(report_sha256(self.profile),'{}','/root/.rbridge-fake-unit-'+'b'*32)
        collector._observations[token]=(report_sha256(token),None,None,self.profile)
        try:
            object.__setattr__(token,'evidence_json','{"status":"PASS"}')
            with patch('os.open',side_effect=AssertionError('Mutated Root open')):
                self.assertRaisesRegex(ValueError,'FAKE_UNIT_COLLECTOR_OBSERVATION_CHANGED',self.verify,self.profile,token,{})
        finally:del collector._observations[token]

    def test_fixed_file_names_refuse_traversal_before_open(self):
        from rbridge_installation.fake_unit_collector import _write_unit,_ready
        fixture=Mock()
        for name in ('../rbridge.service','rbridge.service','invalid.service'):
            with patch('os.open',side_effect=AssertionError('Unclassified unit file open')):
                self.assertRaisesRegex(ValueError,'FAKE_UNIT_COLLECTOR_UNIT_NAME_INVALID',_write_unit,fixture,name,b'fixture')
        with patch('os.open',side_effect=AssertionError('Unclassified readiness file open')):
            self.assertRaisesRegex(ValueError,'FAKE_UNIT_COLLECTOR_READY_NAME_INVALID',_ready,fixture,'../ready.json')


if __name__=='__main__':unittest.main()
