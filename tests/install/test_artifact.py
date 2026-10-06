import json
import os
from pathlib import Path
import tempfile
import unittest
from dataclasses import replace
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

class ArtifactTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.artifact import inventory_artifact, verify_artifact, ArtifactError
        except ImportError:
            self.fail('Complete artifact inventory is not implemented')
        from rbridge_installation.profile import parse_profile
        self.inventory, self.verify, self.error = inventory_artifact, verify_artifact, ArtifactError
        self.profile = parse_profile(valid_profile())
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        files = {
            'package.json': json.dumps({'type': 'module', 'dependencies': {'fixture-dependency': '1.0.0'}}),
            'package-lock.json': '{}',
            'dist/server/server/remoteBridgeMain.js': "import 'fixture-dependency';\n",
            'dist/server/server/rbridgeMcpMain.js': "import 'fixture-dependency';\n",
            'node_modules/fixture-dependency/package.json': '{"name":"fixture-dependency","version":"1.0.0"}',
            'node_modules/fixture-dependency/index.js': 'export default 1;\n',
        }
        for name, content in files.items():
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)

    def test_artifact_rejects_missing_dependency_after_prune(self):
        before = self.inventory(self.root, 'RUNTIME', self.profile)
        (self.root/'node_modules/fixture-dependency/index.js').unlink()
        with self.assertRaises(self.error): self.verify(self.root, before)

    def test_every_byte_extra_file_and_confined_link_are_bound(self):
        os.symlink('fixture-dependency/index.js', self.root/'node_modules/link')
        before = self.inventory(self.root, 'RUNTIME', self.profile)
        self.assertEqual(self.verify(self.root, before).status, 'PASS')
        (self.root/'node_modules/fixture-dependency/index.js').write_text('export default 2;\n')
        with self.assertRaises(self.error): self.verify(self.root, before)
        (self.root/'unmanifested').write_text('extra')
        with self.assertRaises(self.error): self.verify(self.root, before)

    def test_special_hardlink_escape_and_unexpected_roots_fail(self):
        for case in ['fifo','hardlink','escape','secret']:
            name=self.root/'forbidden'
            with self.subTest(case=case):
                if case=='fifo': os.mkfifo(name)
                elif case=='hardlink': os.link(self.root/'package.json',name)
                elif case=='escape': os.symlink('/etc/passwd',name)
                else: name.write_text('never ship private profile')
                with self.assertRaises(self.error): self.inventory(self.root,'RUNTIME',self.profile)
                name.unlink()

    def test_toolkit_runtime_source_pins_are_distinct(self):
        before=self.inventory(self.root,'RUNTIME',self.profile)
        with self.assertRaises(self.error): self.inventory(self.root,'OTHER',self.profile)
        self.assertEqual(before.source_sha,'b5881fd8367b4249e82683f1f884f2392cb696d4')
        self.assertNotEqual(before.source_sha,self.profile.toolkit.source_sha)

    def test_toolkit_binds_its_own_tree_and_locked_client_dependency(self):
        raw = valid_profile()
        self.assertEqual(getattr(self.profile.toolkit, 'tree_sha', None), '3'*40)
        package = {'type':'module','dependencies':{'fixture-dependency':'1.0.0'},'devDependencies':{'@modelcontextprotocol/client':'2.3.0'}}
        (self.root/'package.json').write_text(json.dumps(package))
        for name in ['ops/install/rbridge_install.py','ops/install/rbridge_bootstrap.py','docs/contracts/P2A_INSTALLATION_TOOLKIT_V1.json']:
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('{}')
        with self.assertRaises(self.error): self.inventory(self.root,'TOOLKIT',self.profile)
        p=self.root/'node_modules/@modelcontextprotocol/client/package.json'
        p.parent.mkdir(parents=True);p.write_text('{"name":"@modelcontextprotocol/client","version":"2.3.0"}')
        manifest=self.inventory(self.root,'TOOLKIT',self.profile)
        self.assertEqual(manifest.tree_sha,'3'*40)
        self.assertEqual(manifest.source_sha,'2'*40)

    def test_manifest_paths_and_parent_links_cannot_redirect_reads(self):
        manifest=self.inventory(self.root,'RUNTIME',self.profile)
        entry=next(e for e in manifest.entries if e.kind=='FILE')
        from rbridge_installation.artifact import read_manifest_file
        with self.assertRaises(self.error): read_manifest_file(self.root,replace(entry,path='../outside'))
        redirect=self.root.parent/(self.root.name+'-redirect')
        os.symlink(self.root,redirect)
        self.addCleanup(redirect.unlink)
        with self.assertRaises(self.error): self.inventory(redirect/'dist'/'..','RUNTIME',self.profile)

    def test_inventory_has_a_monotonic_deadline(self):
        with patch('rbridge_installation.artifact.time.monotonic',side_effect=[0,1000]):
            with self.assertRaises(self.error): self.inventory(self.root,'RUNTIME',self.profile)
