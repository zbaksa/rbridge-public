"""MCP Source data never substitutes protected original-artifact producer origin."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from _loader import toolkit

toolkit()
from rbridge_installation.profile import parse_profile


class McpCollectorTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.mcp_collector import collect_root_mcp_cases,verify_root_mcp_observation,_RootMcpObservation
        except ImportError:self.fail('Concrete protected MCP case producer is absent')
        self.collect,self.verify,self.Token=collect_root_mcp_cases,verify_root_mcp_observation,_RootMcpObservation
        source=json.loads((Path(__file__).parents[1]/'fixtures/rbridge-artifact-preimages.json').read_text())
        self.profile=parse_profile(source['profile'])

    def test_source_context_refuses_root_open_original_origin_and_sdk_launch(self):
        with patch('rbridge_installation.mcp_collector.os.open',side_effect=AssertionError('Source Root open')), \
             patch('rbridge_installation.mcp_collector.verify_root_artifact_for_reader_profile',side_effect=AssertionError('Source Root origin')):
            self.assertRaisesRegex(ValueError,'MCP_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,self.profile,None,None,None,{})

    def test_caller_scope_or_constructed_token_cannot_register_producer_origin(self):
        token=self.Token('a'*64,'{}','{}','{}')
        for value in (token,{'scope':'ROOT_PROTECTED_MCP_FIXTURE_PRODUCER','status':'PASS'}):
            with patch('rbridge_installation.mcp_collector.os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'MCP_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.profile,value,{})

    def test_equal_metadata_from_another_original_artifact_does_not_substitute_origin(self):
        # Source negative only. Even matching this temporary private test entry
        # must still encounter the real protected Root context refusal.
        from rbridge_installation import mcp_collector as collector
        from rbridge_installation.artifact_collector import _RootArtifactObservation
        from rbridge_installation.models import report_sha256
        home=self.profile.binding.home+'/.rbridge-artifact-'+'a'*32
        original=_RootArtifactObservation(report_sha256(self.profile),'{}','{}',home)
        substituted=_RootArtifactObservation(report_sha256(self.profile),'{}','{}',home)
        token=self.Token(report_sha256(self.profile),'{}','{}','{}')
        collector._observations[token]=(report_sha256(token),None,None,original,self.profile)
        try:
            with patch('rbridge_installation.mcp_collector.os.open',side_effect=AssertionError('Source Root open')):
                self.assertRaisesRegex(ValueError,'MCP_COLLECTOR_ARTIFACT_ORIGIN_CHANGED',self.verify,self.profile,token,{},artifact_observation=substituted)
                self.assertRaisesRegex(ValueError,'MCP_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.verify,self.profile,token,{},artifact_observation=original)
        finally:del collector._observations[token]


if __name__=='__main__':unittest.main()
