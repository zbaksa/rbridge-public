"""Config Source data and caller-created tokens cannot claim Root origin."""
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.profile import parse_profile
from rbridge_installation.models import report_sha256


class ConfigCasCollectorTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.config_cas_collector import collect_root_config_cas_cases,verify_root_config_cas_observation,_RootConfigCasObservation
        except ImportError:self.fail('Concrete protected configuration CAS collector is absent')
        self.collect,self.verify,self.Token=collect_root_config_cas_cases,verify_root_config_cas_observation,_RootConfigCasObservation
        self.profile=parse_profile(valid_profile())

    def test_source_context_refuses_root_directory_creation_and_runtime_chown(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')),patch('os.chown',side_effect=AssertionError('Source Root chown')):
            self.assertRaisesRegex(ValueError,'CONFIG_CAS_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,self.profile,None,None,{})

    def test_scope_or_constructed_object_cannot_register_origin(self):
        token=self.Token('a'*64,'{}','/root/.rbridge-config-cas-'+'a'*32)
        for value in (token,{'scope':'ROOT_PROTECTED_CONFIG_CAS_FIXTURE_PRODUCER','status':'PASS'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'CONFIG_CAS_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.profile,value,{})

    def test_mutated_private_test_entry_refuses_before_root_io(self):
        from rbridge_installation import config_cas_collector as collector
        token=self.Token(report_sha256(self.profile),'{}','/root/.rbridge-config-cas-'+'a'*32)
        collector._observations[token]=(report_sha256(token),None,None,self.profile)
        try:
            object.__setattr__(token,'fixture_path','/root/.rbridge-copy-ledger-'+'a'*32)
            with patch('os.open',side_effect=AssertionError('Mutated Root open')):
                self.assertRaisesRegex(ValueError,'CONFIG_CAS_COLLECTOR_OBSERVATION_CHANGED',self.verify,self.profile,token,{})
        finally:del collector._observations[token]

    def test_matching_test_entry_still_refuses_real_source_context(self):
        from rbridge_installation import config_cas_collector as collector
        token=self.Token(report_sha256(self.profile),'{}','/root/.rbridge-config-cas-'+'a'*32)
        collector._observations[token]=(report_sha256(token),None,None,self.profile)
        try:
            with patch('os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'CONFIG_CAS_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.verify,self.profile,token,{})
        finally:del collector._observations[token]


if __name__=='__main__':unittest.main()
