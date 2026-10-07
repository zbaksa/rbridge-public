"""Source data, matching metadata and temporary registries never bypass Root."""
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import report_sha256
from rbridge_installation.profile import parse_profile


class HelperFamilyCollectorTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.helper_family_collector import collect_root_helper_family,verify_root_helper_family_observation,_RootHelperFamilyObservation
        except ImportError:self.fail('Protected original-artifact helper-family collector is absent')
        self.collect,self.verify,self.Token=collect_root_helper_family,verify_root_helper_family_observation,_RootHelperFamilyObservation
        self.profile=parse_profile(valid_profile())

    def test_source_context_refuses_root_open_and_original_artifact_lookup(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch('rbridge_installation.helper_family_collector.verify_root_artifact_observation',side_effect=AssertionError('Source origin')):
            self.assertRaisesRegex(ValueError,'HELPER_FAMILY_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,self.profile,None,{})

    def test_scope_and_constructed_token_never_register_origin(self):
        token=self.Token('a'*64,'b'*64,'{}','/root/.rbridge-helper-family-'+'c'*32)
        for value in (token,{'scope':'ROOT_PROTECTED_HELPER_FAMILY_OBSERVATION','status':'PASS'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'HELPER_FAMILY_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.profile,value,{})

    def test_equal_metadata_from_another_artifact_does_not_replace_original_identity(self):
        from rbridge_installation import helper_family_collector as collector
        from rbridge_installation.artifact_collector import _RootArtifactObservation
        home=self.profile.binding.home+'/.rbridge-artifact-'+'a'*32
        artifact=_RootArtifactObservation(report_sha256(self.profile),'{}','{}',home)
        substituted=_RootArtifactObservation(report_sha256(self.profile),'{}','{}',home)
        token=self.Token(report_sha256(self.profile),report_sha256(artifact),'{}','/root/.rbridge-helper-family-'+'c'*32)
        collector._observations[token]=(report_sha256(token),artifact,self.profile)
        try:
            with patch('os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'HELPER_FAMILY_COLLECTOR_ARTIFACT_ORIGIN_CHANGED',self.verify,self.profile,token,{},artifact_observation=substituted)
                self.assertRaisesRegex(ValueError,'HELPER_FAMILY_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.verify,self.profile,token,{},artifact_observation=artifact)
        finally:del collector._observations[token]

    def test_mutated_private_test_entry_refuses_before_root_io(self):
        from rbridge_installation import helper_family_collector as collector
        token=self.Token(report_sha256(self.profile),'b'*64,'{}','/root/.rbridge-helper-family-'+'c'*32)
        collector._observations[token]=(report_sha256(token),None,self.profile)
        try:
            object.__setattr__(token,'artifact_sha256','c'*64)
            with patch('os.open',side_effect=AssertionError('Mutated Root open')):
                self.assertRaisesRegex(ValueError,'HELPER_FAMILY_COLLECTOR_OBSERVATION_CHANGED',self.verify,self.profile,token,{})
        finally:del collector._observations[token]


if __name__=='__main__':unittest.main()
