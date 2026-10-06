"""Authenticated bootstrap byte collection is separate from execution authority."""
import base64
import hashlib
import json
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile


class BootstrapCollectorTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.bootstrap_collector import collect_root_bootstrap_bytes,verify_root_bootstrap_observation,decode_bootstrap_body
        except ImportError:self.fail('Concrete authenticated bootstrap byte collector is not implemented')
        from rbridge_installation.profile import parse_profile
        self.collect,self.verify,self.decode=collect_root_bootstrap_bytes,verify_root_bootstrap_observation,decode_bootstrap_body
        self.profile=parse_profile(valid_profile());self.payload=b'print("SOURCE_BYTES_ONLY")\n'
        self.manifest={'schema':'RBRIDGE_BOOTSTRAP_MANIFEST_V1','source_sha':self.profile.toolkit.source_sha,
            'tree_sha':self.profile.toolkit.tree_sha,'payload_bytes':len(self.payload),
            'payload_sha256':hashlib.sha256(self.payload).hexdigest(),'toolkit_manifest_sha256':self.profile.toolkit.manifest_sha256,
            'python_closure_sha256':'d'*64}
        self.body=json.dumps({'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1','manifest':self.manifest,
            'payload_base64':base64.b64encode(self.payload).decode()})

    def test_complete_body_decoding_is_only_an_exact_byte_predicate(self):
        self.assertEqual(self.decode(self.body,self.manifest),self.payload)
        for body in (self.body[:-1],self.body.replace('"schema":','"schema":"duplicate","schema":',1),
                json.dumps({'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1','manifest':{**self.manifest,'payload_bytes':1},
                    'payload_base64':base64.b64encode(self.payload).decode()})):
            self.assertRaises(ValueError,self.decode,body,self.manifest)
        for value in (None,{},'x'*65537):self.assertRaises(ValueError,self.decode,value,self.manifest)

    def test_wrong_or_noncanonical_payload_never_survives_rehashed_carrier(self):
        for encoded in (base64.b64encode(self.payload+b'x').decode(),base64.b64encode(self.payload).decode()+'\n'):
            body=json.dumps({'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1','manifest':self.manifest,'payload_base64':encoded})
            self.assertRaises(ValueError,self.decode,body,self.manifest)
        bad=b'\xff\xfe';manifest={**self.manifest,'payload_bytes':len(bad),'payload_sha256':hashlib.sha256(bad).hexdigest()}
        self.assertRaises(ValueError,self.decode,json.dumps({'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1',
            'manifest':manifest,'payload_base64':base64.b64encode(bad).decode()}),manifest)

    def test_boolean_length_is_not_an_integer_manifest_even_when_python_equality_matches(self):
        payload=b'x';manifest={**self.manifest,'payload_bytes':1,'payload_sha256':hashlib.sha256(payload).hexdigest()}
        body=json.dumps({'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1',
            'manifest':{**manifest,'payload_bytes':True},'payload_base64':base64.b64encode(payload).decode()})
        self.assertRaises(ValueError,self.decode,body,manifest)

    def test_source_context_cannot_open_root_paths_authenticate_or_publish(self):
        with patch('rbridge_installation.bootstrap_collector.os.open',side_effect=AssertionError('Source Root open')), \
             patch('rbridge_installation.bootstrap_collector.QualifiedGitHubReadBackend',side_effect=AssertionError('Source authentication')):
            self.assertRaisesRegex(ValueError,'BOOTSTRAP_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,
                self.profile,None,None,self.manifest,17,{'python_closure_sha256':'d'*64})

    def test_caller_tokens_and_serialized_authenticated_pass_cannot_mint_origin(self):
        from rbridge_installation.bootstrap_collector import _RootBootstrapObservation
        token=_RootBootstrapObservation('a'*64,'{}','{}','{}',base64.b64encode(self.payload).decode())
        for value in (token,{'scope':'ROOT_AUTHENTICATED_BOOTSTRAP_BYTES','status':'PASS','may_execute':True}):
            with patch('rbridge_installation.bootstrap_collector.os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,
                    self.profile,value,None,None,{'python_closure_sha256':'d'*64})


if __name__=='__main__':unittest.main()
