import json
from pathlib import Path
import unittest
from unittest.mock import patch
from _loader import toolkit

toolkit()
from rbridge_installation.profile import parse_profile


class CoreCollectorTests(unittest.TestCase):
    def setUp(self):
        from rbridge_installation.core_collector import collect_root_core_cases,verify_root_core_observation,_RootCoreObservation
        self.collect=collect_root_core_cases;self.verify=verify_root_core_observation;self.Token=_RootCoreObservation
        source=json.loads((Path(__file__).parents[1]/'fixtures/rbridge-artifact-preimages.json').read_text())
        self.profile=parse_profile(source['profile'])

    def test_source_context_cannot_open_a_fixture_or_relabel_artifact_origin(self):
        with patch('rbridge_installation.core_collector.os.open',side_effect=AssertionError('Source Root open')), \
             patch('rbridge_installation.core_collector.verify_root_artifact_for_reader_profile',side_effect=AssertionError('Source Root origin')):
            self.assertRaisesRegex(ValueError,'CORE_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,
                self.profile,None,None,None,'c'*64,{})

    def test_caller_scope_and_constructed_tokens_cannot_register_producer_origin(self):
        token=self.Token('a'*64,'{}','{}','{}')
        for value in (token,{'scope':'ROOT_PROTECTED_CORE_FIXTURE_PRODUCER','status':'PASS'}):
            with patch('rbridge_installation.core_collector.os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'CORE_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.profile,value,{})

    def test_same_profile_and_equal_artifact_bytes_do_not_substitute_another_fixture_origin(self):
        # Private registration is injected only inside this Source negative
        # fixture. Matching it still must hit the real Root context refusal.
        from rbridge_installation import core_collector as collector
        from rbridge_installation.artifact_collector import _RootArtifactObservation
        from rbridge_installation.models import report_sha256
        home=self.profile.binding.home+'/.rbridge-artifact-'+'a'*32
        original=_RootArtifactObservation(report_sha256(self.profile),'{}','{}',home)
        substituted=_RootArtifactObservation(report_sha256(self.profile),'{}','{}',home)
        token=self.Token(report_sha256(self.profile),'{}','{}','{}')
        collector._observations[token]=(report_sha256(token),None,None,original,self.profile)
        try:
            with patch('rbridge_installation.core_collector.os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'CORE_COLLECTOR_ARTIFACT_ORIGIN_CHANGED',self.verify,
                    self.profile,token,{},artifact_observation=substituted)
                self.assertRaisesRegex(ValueError,'CORE_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.verify,
                    self.profile,token,{},artifact_observation=original)
        finally:del collector._observations[token]


if __name__=='__main__':unittest.main()
