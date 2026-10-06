"""Bootstrap byte/origin/parent-shell source fixtures; no sudo or service action."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from _loader import ROOT


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        path=ROOT/'ops/install/rbridge_bootstrap.py'
        if not path.is_file():self.fail('Standalone protected bootstrap is not implemented')
        spec=importlib.util.spec_from_file_location('bootstrap_source_fixture',path)
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        self.module=module;self.payload=b'print("SOURCE_BYTES_ONLY")\n'
        self.manifest={'schema':'RBRIDGE_BOOTSTRAP_MANIFEST_V1','source_sha':'a'*40,'tree_sha':'b'*40,
            'payload_bytes':len(self.payload),'payload_sha256':hashlib.sha256(self.payload).hexdigest(),
            'toolkit_manifest_sha256':'c'*64,'python_closure_sha256':'d'*64}
        self.body={'schema':'RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1',
            'manifest':self.manifest,'payload_base64':base64.b64encode(self.payload).decode()}
        self.capture={'schema':'RBRIDGE_BOOTSTRAP_ARTIFACT_CAPTURE_V1','repository':'fixture/bootstrap',
            'viewer':'fixture-author','author':'fixture-author','issue_number':17,'is_pull_request':False,
            'url':'https://github.com/fixture/bootstrap/issues/17','body':json.dumps(self.body)}
        self.binding={'repository':'fixture/bootstrap','author':'fixture-author','issue_number':17}

    def test_exact_bytes_and_identity_are_only_a_byte_predicate(self):
        result=self.module.verify_bootstrap_artifact(self.payload,self.manifest,self.capture,self.binding)
        self.assertEqual(result['status'],'PASS');self.assertEqual(result['scope'],'ARTIFACT_BYTES_ONLY')
        self.assertFalse(result['may_execute'])

    def test_changed_payload_length_hash_author_or_capture_cannot_execute(self):
        for payload,manifest,capture in ((self.payload+b'x',self.manifest,self.capture),
            (self.payload,{**self.manifest,'payload_bytes':1},self.capture),
            (self.payload,{**self.manifest,'payload_sha256':'e'*64},self.capture),
            (self.payload,self.manifest,{**self.capture,'author':'attacker'}),
            (self.payload,self.manifest,{**self.capture,'viewer':'attacker'}),
            (self.payload,self.manifest,{**self.capture,'is_pull_request':True}),
            (self.payload,self.manifest,{**self.capture,'url':'https://attacker.invalid/17'})):
            with self.subTest(capture=capture['author'],size=len(payload)):
                self.assertRaises(ValueError,self.module.verify_bootstrap_artifact,payload,manifest,capture,self.binding)

    def test_duplicate_keys_nulls_noncanonical_base64_and_extra_fields_fail(self):
        for body in ('{"schema":"x","schema":"x"}',
            json.dumps({**self.body,'payload_base64':self.body['payload_base64']+'\n'}),
            json.dumps({**self.body,'extra':True}),json.dumps({**self.body,'manifest':None})):
            self.assertRaises(ValueError,self.module.verify_bootstrap_artifact,self.payload,self.manifest,
                {**self.capture,'body':body},self.binding)

    def test_wrapper_preserves_child_exit_and_interactive_parent(self):
        for code in (0,2,3,4,5):
            script=self.module.source_exit_wrapper(['/bin/sh','-c','exit '+str(code)])
            result=subprocess.run(['/bin/bash'],input=script+'\nprintf "PARENT_ALIVE:%s\\n" "$?"\n',
                text=True,capture_output=True,timeout=5)
            self.assertEqual(result.returncode,0);self.assertIn('RBRIDGE_OUTER_EXIT='+str(code),result.stdout)
            self.assertIn('PARENT_ALIVE:'+str(code),result.stdout)

    def test_byte_predicate_or_rehashed_scope_never_renders_a_root_command(self):
        result=self.module.verify_bootstrap_artifact(self.payload,self.manifest,self.capture,self.binding)
        self.assertRaises(ValueError,self.module.render_owner_command,result)
        self.assertRaises(ValueError,self.module.render_owner_command,{**result,'scope':'QUALIFIED_BOOTSTRAP','may_execute':True})

    def test_exclusive_publication_rehashes_descriptor_and_preserves_existing_object(self):
        with tempfile.TemporaryDirectory() as directory:
            parent=Path(directory);os.chmod(parent,0o700)
            publish=self.module._publish_fixture_bootstrap
            result=publish(parent,self.payload,self.manifest,self.capture,self.binding)
            target=Path(result['path']);self.assertEqual(target.read_bytes(),self.payload)
            self.assertEqual(target.stat().st_mode&0o777,0o400);self.assertFalse(result['may_execute'])
            self.assertEqual(result['scope'],'FIXTURE_AUTHORITY_ONLY')
            self.assertRaises(ValueError,publish,parent,self.payload,self.manifest,self.capture,self.binding)
            self.assertEqual(target.read_bytes(),self.payload)

    def test_symlink_parent_or_existing_stage_is_never_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);parent=root/'private';parent.mkdir(mode=0o700)
            link=root/'link';link.symlink_to(parent,target_is_directory=True)
            publish=self.module._publish_fixture_bootstrap
            self.assertRaises(ValueError,publish,link,self.payload,self.manifest,self.capture,self.binding)
            self.assertEqual(list(parent.iterdir()),[])
            stage=parent/('bootstrap-'+self.manifest['payload_sha256']);stage.symlink_to(root,target_is_directory=True)
            self.assertRaises(ValueError,publish,parent,self.payload,self.manifest,self.capture,self.binding)
            self.assertTrue(stage.is_symlink());self.assertFalse((root/'payload.py').exists())

    def test_named_parent_swap_after_create_preserves_bytes_and_refuses_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);parent=root/'private';parent.mkdir(mode=0o700);moved=root/'retained'
            original=self.module.os.fchmod;swapped=[]
            def replace_parent(fd,mode):
                original(fd,mode)
                if not swapped:
                    parent.rename(moved);parent.mkdir(mode=0o700);swapped.append(True)
            with patch.object(self.module.os,'fchmod',side_effect=replace_parent):
                self.assertRaises(ValueError,self.module._publish_fixture_bootstrap,
                    parent,self.payload,self.manifest,self.capture,self.binding)
            self.assertEqual(list(parent.iterdir()),[])
            target=moved/('bootstrap-'+self.manifest['payload_sha256'])/'payload.py'
            self.assertEqual(target.read_bytes(),self.payload)


if __name__=='__main__':unittest.main()
