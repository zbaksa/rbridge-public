"""A Source report and caller-made object cannot claim protected Root origin."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.profile import parse_profile
from rbridge_installation.models import report_sha256


class CopyLedgerCollectorTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.copy_ledger_collector import collect_root_copy_ledger_cases,verify_root_copy_ledger_observation,_RootCopyLedgerObservation
        except ImportError:self.fail('Protected Root copy/ledger collector is absent')
        self.collect,self.verify,self.Token=collect_root_copy_ledger_cases,verify_root_copy_ledger_observation,_RootCopyLedgerObservation
        self.profile=parse_profile(valid_profile())

    def test_source_context_refuses_directory_creation_and_child_launch(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')),patch('os.fork',side_effect=AssertionError('Source Root fork')):
            self.assertRaisesRegex(ValueError,'COPY_LEDGER_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,self.profile,None,None,{})

    def test_serialized_scope_and_constructed_token_never_register_origin(self):
        token=self.Token('a'*64,'{}','/root/.rbridge-copy-ledger-'+'a'*32)
        for value in (token,{'scope':'ROOT_PROTECTED_COPY_LEDGER_FIXTURE_PRODUCER','status':'PASS'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'COPY_LEDGER_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.profile,value,{})

    def test_mutated_registered_metadata_refuses_before_protected_io(self):
        from rbridge_installation import copy_ledger_collector as collector
        token=self.Token(report_sha256(self.profile),'{}','/root/.rbridge-copy-ledger-'+'a'*32)
        collector._observations[token]=(report_sha256(token),None,None,self.profile)
        try:
            object.__setattr__(token,'evidence_json','{"scope":"ROOT"}')
            with patch('os.open',side_effect=AssertionError('Mutated Root open')):
                self.assertRaisesRegex(ValueError,'COPY_LEDGER_COLLECTOR_OBSERVATION_CHANGED',self.verify,self.profile,token,{})
        finally:del collector._observations[token]

    def test_matching_test_registry_still_encounters_real_root_context_guard(self):
        from rbridge_installation import copy_ledger_collector as collector
        token=self.Token(report_sha256(self.profile),'{}','/root/.rbridge-copy-ledger-'+'a'*32)
        collector._observations[token]=(report_sha256(token),None,None,self.profile)
        try:
            with patch('os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'COPY_LEDGER_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.verify,self.profile,token,{})
        finally:del collector._observations[token]

    def test_fixture_directory_prefix_is_fixed_before_any_root_parent_open(self):
        from rbridge_installation.copy_ledger_collector import _FixtureDirectory
        for prefix in ('../../','caller-','/tmp/fixture-'):
            with patch('os.open',side_effect=AssertionError('Caller Root prefix open')):
                self.assertRaisesRegex(ValueError,'COPY_LEDGER_COLLECTOR_FIXTURE_PREFIX_INVALID',_FixtureDirectory,self.profile,prefix=prefix)


if __name__=='__main__':unittest.main()
