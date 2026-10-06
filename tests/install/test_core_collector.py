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


if __name__=='__main__':unittest.main()
