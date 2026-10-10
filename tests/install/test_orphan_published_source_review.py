"""Physical Root release proof accepts no untrusted source as authorization."""
import hashlib
import json
import os
from dataclasses import replace
import unittest
from _loader import toolkit

class OrphanPublishedSourceTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_published_source_review import (
            parse_exact_toolkit_manifest,describe_exact_manifest_data,
            inspect_published_toolkit_readonly)
        from rbridge_installation.artifact import (
            ArtifactEntry,_manifest)
        from rbridge_installation.models import encode_report
        self.parse=parse_exact_toolkit_manifest
        self.describe=describe_exact_manifest_data
        self.physical=inspect_published_toolkit_readonly
        self.encode=encode_report
        self.source='62ff6bc181024a633f688014b2d8fb92eee99603'
        self.tree='0c89d9fba9908764185a13335f475757054e9395'
        body=b'public reference fixture\n'
        entries=(
            ArtifactEntry('docs','DIRECTORY',0,0o755,'',''),
            ArtifactEntry('docs/readme.txt','FILE',len(body),0o644,
                          hashlib.sha256(body).hexdigest(),''))
        self.manifest=_manifest('TOOLKIT',self.source,self.tree,'3'*64,entries)
        self.raw=self.encode(self.manifest)
        self.file_sha=hashlib.sha256(self.raw).hexdigest()

    def check(self,raw=None,source=None,tree=None,digest=None):
        return self.parse(
            self.raw if raw is None else raw,
            self.source if source is None else source,
            self.tree if tree is None else tree,
            self.file_sha if digest is None else digest)

    def test_exact_canonical_manifest_matches_external_data_pins(self):
        result=self.check()
        self.assertEqual(result,self.manifest)
        summary=self.describe(result,self.raw)
        self.assertEqual(summary['status'],'MANIFEST_DATA_MATCH_ONLY')
        self.assertEqual(summary['source_sha'],self.source)
        self.assertEqual(summary['manifest_file_sha256'],self.file_sha)
        self.assertEqual(summary['manifest_logical_sha256'],result.sha256)
        for k in ('source_provenance_verified','owner_authenticated',
                  'may_settle','may_launch','may_resume_qualification',
                  'may_change_production'):
            self.assertIs(summary[k],False)

    def test_wrong_source_tree_or_manifest_digest_is_refused(self):
        for name,pin in (
            ('source_sha','a'*40),('tree_sha','a'*40),
            ('manifest_file_sha256','a'*64)):
            with self.subTest(name=name),self.assertRaises(ValueError):
                kwargs={name:pin}
                self.parse(self.raw,kwargs.get('source_sha',self.source),
                           kwargs.get('tree_sha',self.tree),
                           kwargs.get('manifest_file_sha256',self.file_sha))

    def test_malformed_pins_never_learn_root_authority(self):
        for value in (None,True,123,'','a'*39,'a'*41,'G'*40,
                      'toolkit-'+'a'*40):
            with self.subTest(value=str(value)),self.assertRaises(ValueError):
                self.parse(self.raw,value,self.tree,self.file_sha)
        with self.assertRaises(ValueError):
            self.parse(self.raw,self.source,self.tree,'f'*63)
        with self.assertRaises(ValueError):
            self.parse('not bytes',self.source,self.tree,self.file_sha)

    def test_noncanonical_whitespace_duplicate_keys_and_corruption(self):
        dup=self.raw.replace(b'"kind":"TOOLKIT"',
                             b'"kind":"TOOLKIT","kind":"TOOLKIT"',1)
        self.assertNotEqual(dup,self.raw)
        for bad in (b' '+self.raw,self.raw+b'\n',dup,b'\xff',
                    b'{"kind":NaN}',b'',b'a'*2097153):
            with self.subTest(size=len(bad)),self.assertRaises(ValueError):
                self.check(raw=bad,digest=hashlib.sha256(bad).hexdigest())

    def test_modified_manifest_and_unexpected_entry_rejected(self):
        for field,value in (
            ('kind','RUNTIME'),('schema','OTHER'),('source_sha','a'*40),
            ('uid_policy','UNTRUSTED'),('sha256','b'*64)):
            data=json.loads(self.raw);data[field]=value
            raw=self.encode(data)
            with self.subTest(field=field),self.assertRaises(ValueError):
                self.check(raw=raw,digest=hashlib.sha256(raw).hexdigest())
        for field,value in (
            ('mode',0o777),('sha256','g'*64),('kind','FIFO'),
            ('size',True),('target','../escape')):
            data=json.loads(self.raw);data['entries'][1][field]=value
            raw=self.encode(data)
            with self.subTest(field=field),self.assertRaises(ValueError):
                self.check(raw=raw,digest=hashlib.sha256(raw).hexdigest())

    def test_noncanonical_summary_cannot_be_accepted(self):
        with self.assertRaises(ValueError):
            self.describe(self.manifest,self.raw+b'\n')
        modified=replace(self.manifest,source_sha='a'*40)
        with self.assertRaises(ValueError):
            self.describe(modified,self.raw)

    def test_real_root_reader_cannot_be_invoked_as_nonroot(self):
        if os.getuid()!=0 or os.geteuid()!=0:
            with self.assertRaisesRegex(ValueError,
                                        'ORPHAN_SOURCE_ROOT_REQUIRED'):
                self.physical(self.source,self.tree,self.file_sha)

if __name__=='__main__':
    unittest.main()
