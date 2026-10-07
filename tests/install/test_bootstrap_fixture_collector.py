"""Root bootstrap fixture requires its genuine authenticated byte observation."""
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import report_sha256
from rbridge_installation.profile import parse_profile


class BootstrapFixtureCollectorTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.bootstrap_fixture_collector import collect_root_bootstrap_fixture,verify_root_bootstrap_fixture_observation,_RootBootstrapFixtureObservation
        except ImportError:self.fail('Protected bootstrap fixture collector is absent')
        self.collect,self.verify,self.Token=collect_root_bootstrap_fixture,verify_root_bootstrap_fixture_observation,_RootBootstrapFixtureObservation
        self.p=parse_profile(valid_profile())

    def test_source_context_refuses_auth_origin_root_open_or_protected_module_import(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch('rbridge_installation.bootstrap_fixture_collector.verify_root_bootstrap_observation',side_effect=AssertionError('Source Root auth')):
            self.assertRaisesRegex(ValueError,'BOOTSTRAP_FIXTURE_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,self.p,None,None,None,{})

    def test_constructed_token_or_scope_cannot_register_origin(self):
        token=self.Token('a'*64,'b'*64,'{}','/root/.rbridge-bootstrap-fixture-'+'c'*32)
        for value in (token,{'scope':'ROOT_PROTECTED_BOOTSTRAP_FIXTURE_OBSERVATION','status':'PASS'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_FIXTURE_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.p,value,{})

    def test_equal_metadata_does_not_replace_original_authenticated_bootstrap_object(self):
        from rbridge_installation import bootstrap_fixture_collector as c
        from rbridge_installation.bootstrap_collector import _RootBootstrapObservation
        original=_RootBootstrapObservation(report_sha256(self.p),'{}','{}','{}','eA==')
        substitute=_RootBootstrapObservation(report_sha256(self.p),'{}','{}','{}','eA==')
        token=self.Token(report_sha256(self.p),report_sha256(original),'{}','/root/.rbridge-bootstrap-fixture-'+'c'*32)
        c._observations[token]=(report_sha256(token),original,None,None,self.p)
        try:
            with patch('os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_FIXTURE_COLLECTOR_AUTH_ORIGIN_CHANGED',self.verify,self.p,token,{},bootstrap_observation=substitute)
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_FIXTURE_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.verify,self.p,token,{},bootstrap_observation=original)
        finally:del c._observations[token]

    def test_mutated_private_test_entry_refuses_before_io(self):
        from rbridge_installation import bootstrap_fixture_collector as c
        token=self.Token(report_sha256(self.p),'b'*64,'{}','/root/.rbridge-bootstrap-fixture-'+'c'*32)
        c._observations[token]=(report_sha256(token),None,None,None,self.p)
        try:
            object.__setattr__(token,'fixture_path','/root/.rbridge-fake-unit-'+'c'*32)
            with patch('os.open',side_effect=AssertionError('Mutated Root open')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_FIXTURE_COLLECTOR_OBSERVATION_CHANGED',self.verify,self.p,token,{})
        finally:del c._observations[token]


if __name__=='__main__':unittest.main()
