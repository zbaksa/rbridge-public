"""Root collector boundary negatives; this source suite grants no physical origin."""
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile


class ArtifactCollectorTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.artifact_collector import collect_root_artifact_fixture,verify_root_artifact_observation
        except ImportError:self.fail('Concrete Root artifact collector is not implemented')
        self.collect,self.verify=collect_root_artifact_fixture,verify_root_artifact_observation
        from rbridge_installation.profile import parse_profile
        self.profile=parse_profile(valid_profile())

    def test_source_context_cannot_open_files_or_launch_an_artifact_helper(self):
        with patch('rbridge_installation.artifact_collector.os.open',side_effect=AssertionError('Source collector must not open Root files')), \
             patch('rbridge_installation.owned_process.subprocess.Popen',side_effect=AssertionError('Source collector must not launch')):
            self.assertRaisesRegex(ValueError,'ARTIFACT_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,self.profile,None,None,{})

    def test_serialized_pass_or_caller_token_never_becomes_actual_collector_origin(self):
        from rbridge_installation.artifact_collector import _RootArtifactObservation
        token=_RootArtifactObservation('a'*64,'{}','{}','/home/rbridge/.rbridge-artifact-'+'b'*32)
        for value in (token,{'status':'PASS','scope':'ROOT_FINAL_ARTIFACT_OBSERVATION'},object()):
            with patch('rbridge_installation.artifact_collector.os.open',side_effect=AssertionError('Unqualified token filesystem access')):
                self.assertRaisesRegex(ValueError,'ARTIFACT_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.profile,value,{})


if __name__=='__main__':unittest.main()
