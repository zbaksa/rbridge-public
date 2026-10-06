"""Real descriptor tree fixtures, separate from actual host interpreter proof."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from _loader import toolkit


class PythonClosureTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.python_closure import verify_python_closure_tree
        except ImportError:self.fail('Protected complete Python closure verifier is not implemented')
        from rbridge_installation.models import report_sha256
        self.verify,self.hash=verify_python_closure_tree,report_sha256
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        os.chmod(self.root,0o700);self.stdlib=self.root/'stdlib';self.stdlib.mkdir(mode=0o755)
        self.file=self.stdlib/'module.py';self.file.write_bytes(b'# synthetic stdlib fixture\n');os.chmod(self.file,0o644)
        self.manifest={'schema':'RBRIDGE_PYTHON_CLOSURE_V1','python_version':'3.11.2',
            'interpreter_path':str(self.file),'interpreter_sha256':hashlib.sha256(self.file.read_bytes()).hexdigest(),
            'roots':[str(self.stdlib)],'entries':[
                {'path':str(self.stdlib),'kind':'DIRECTORY','mode':493,'size':0,'sha256':''},
                {'path':str(self.file),'kind':'FILE','mode':420,'size':self.file.stat().st_size,'sha256':hashlib.sha256(self.file.read_bytes()).hexdigest()}],
            'absent_paths':[str(self.root/'python311.zip')]}
        self.manifest['sha256']=self.hash(self.manifest)

    def test_complete_tree_full_bytes_and_explicit_absence(self):
        proof=self.verify(self.manifest,self.manifest['sha256'],production=False)
        self.assertEqual(proof['status'],'PASS');self.assertEqual(proof['scope'],'FIXTURE_AUTHORITY_ONLY')
        self.assertFalse(proof['execution_qualified'])

    def test_unlisted_file_changed_bytes_symlink_and_new_zip_are_refused(self):
        (self.stdlib/'unlisted.py').write_bytes(b'unreviewed')
        self.assertRaises(ValueError,self.verify,self.manifest,self.manifest['sha256'],production=False)
        (self.stdlib/'unlisted.py').unlink();self.file.write_bytes(b'changed bytes')
        self.assertRaises(ValueError,self.verify,self.manifest,self.manifest['sha256'],production=False)
        self.file.unlink();self.file.symlink_to(self.root/'other')
        self.assertRaises(ValueError,self.verify,self.manifest,self.manifest['sha256'],production=False)
        self.file.unlink();self.file.write_bytes(b'# synthetic stdlib fixture\n');os.chmod(self.file,0o644)
        (self.root/'python311.zip').write_bytes(b'unreviewed archive')
        self.assertRaises(ValueError,self.verify,self.manifest,self.manifest['sha256'],production=False)

    def test_manifest_tampering_or_absolute_root_cannot_broaden_the_closure(self):
        for change in ({'roots':['/']},{'entries':[]},{'python_version':'24.0.0'},{'sha256':'f'*64}):
            self.assertRaises(ValueError,self.verify,{**self.manifest,**change},self.manifest['sha256'],production=False)


if __name__=='__main__':unittest.main()
