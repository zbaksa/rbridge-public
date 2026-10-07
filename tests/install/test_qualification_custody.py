"""Root custody is distinct from caller-signed Source data and live origins."""
import hashlib
import hmac
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


class CustodyBytesTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import qualification_custody as c
        except ImportError:self.fail('Protected qualification custody is absent')
        self.c=c;self.p=parse_profile(valid_profile());self.key=b'SOURCE_FIXTURE_KEY_ONLY_32_BYTES'
        self.assertEqual(len(self.key),32)
        self.evidence=encode_report({'schema':'SOURCE_DATA_ONLY','original_raw':'complete original Source bytes'})
        self.body={'schema':'RBRIDGE_ROOT_QUALIFICATION_CUSTODY_V1','scope':'ROOT_ISSUER_CUSTODY_PREPARATION_ONLY',
            'directory':'/root/.rbridge-privileged-'+'a'*32,'profile_sha256':report_sha256(self.p),
            'toolkit_manifest_sha256':self.p.toolkit.manifest_sha256,'bundle_pin':'b'*64,
            'evidence_sha256':hashlib.sha256(self.evidence).hexdigest(),
            'qualification_request':{'python_closure_sha256':'c'*64},'key_sha256':hashlib.sha256(self.key).hexdigest(),
            'key_identity':['1','2','33024','0','0','1','32','3','4']}
        # Independent stdlib Source signature. This is never a Root origin.
        self.capsule={**self.body,'mac_sha256':hmac.digest(self.key,b'RBRIDGE_ROOT_QUALIFICATION_CUSTODY_V1\x00'+encode_report(self.body),'sha256').hex()}
        self.raw=encode_report(self.capsule)
        self.locator={'schema':'RBRIDGE_QUALIFICATION_CUSTODY_LOCATOR_V1','directory':self.body['directory'],
            'profile_sha256':self.body['profile_sha256'],'bundle_pin':self.body['bundle_pin'],
            'evidence_sha256':self.body['evidence_sha256'],'capsule_sha256':hashlib.sha256(self.raw).hexdigest(),
            'request_sha256':report_sha256(self.body['qualification_request'])}

    def compare(self,**values):
        args={'profile':self.p,'locator':self.locator,'capsule_raw':self.raw,'evidence_raw':self.evidence,
            'key':self.key,'key_identity':self.body['key_identity'],'qualification_request':self.body['qualification_request']}
        return self.c.compare_custody_bytes(**{**args,**values})

    def test_independent_source_mac_preserves_complete_bytes_but_grants_no_origin(self):
        result=self.compare()
        self.assertEqual(result['scope'],'QUALIFICATION_CUSTODY_BYTES_ONLY');self.assertEqual(result['status'],'PASS')
        self.assertEqual(result['capsule'],self.capsule);self.assertFalse(result['may_execute'])
        self.assertFalse(result['service_action_authorized']);self.assertEqual(result['physical_origin'],'UNQUALIFIED')
        self.assertNotIn('key',result)

    def test_rehashed_original_evidence_or_capsule_metadata_cannot_reuse_signature(self):
        for field,value in [('directory','/root/.rbridge-privileged-'+'d'*32),('bundle_pin','d'*64),
                ('scope','SWITCH_AUTHORIZED'),('key_identity',['1']*9),('evidence_sha256','d'*64)]:
            capsule={**self.capsule,field:value};raw=encode_report(capsule)
            locator={**self.locator,'capsule_sha256':hashlib.sha256(raw).hexdigest()}
            if field in locator:locator[field]=value
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,capsule_raw=raw,locator=locator)
        evidence=self.evidence+b' ';capsule={**self.capsule,'evidence_sha256':hashlib.sha256(evidence).hexdigest()}
        raw=encode_report(capsule);locator={**self.locator,'capsule_sha256':hashlib.sha256(raw).hexdigest(),
            'evidence_sha256':capsule['evidence_sha256']}
        self.assertRaises(ValueError,self.compare,capsule_raw=raw,locator=locator,evidence_raw=evidence)

    def test_key_identity_request_and_profile_are_exact_even_with_valid_source_signature(self):
        for values in ({'key':b'x'*32},{'key_identity':['0']*9},
                {'qualification_request':{'python_closure_sha256':'d'*64}},
                {'locator':{**self.locator,'profile_sha256':'d'*64}}):
            with self.subTest(values=values):self.assertRaises(ValueError,self.compare,**values)
        for key in (b'',b'x'*31,b'x'*33,'x'*32):self.assertRaises(ValueError,self.compare,key=key)

    def test_complete_evidence_and_capsule_must_be_canonical_bounded_strict_json(self):
        for raw in (self.raw+b' ',b'{"schema":"x","schema":"x"}',b'null',b'{}',b'\xff'):
            locator={**self.locator,'capsule_sha256':hashlib.sha256(raw).hexdigest()}
            self.assertRaises(ValueError,self.compare,capsule_raw=raw,locator=locator)
        for evidence in (self.evidence+b' ',b'{"x":NaN}',b'null'):
            body={**self.body,'evidence_sha256':hashlib.sha256(evidence).hexdigest()}
            raw=encode_report({**body,'mac_sha256':hmac.digest(self.key,b'RBRIDGE_ROOT_QUALIFICATION_CUSTODY_V1\x00'+encode_report(body),'sha256').hex()})
            locator={**self.locator,'evidence_sha256':body['evidence_sha256'],'capsule_sha256':hashlib.sha256(raw).hexdigest()}
            self.assertRaises(ValueError,self.compare,evidence_raw=evidence,capsule_raw=raw,locator=locator)

    def test_domain_separation_and_exact_locator_fields_are_required(self):
        raw=encode_report({**self.body,'mac_sha256':hmac.digest(self.key,encode_report(self.body),'sha256').hex()})
        self.assertRaises(ValueError,self.compare,capsule_raw=raw,
            locator={**self.locator,'capsule_sha256':hashlib.sha256(raw).hexdigest()})
        for locator in ({**self.locator,'extra':True},{**self.locator,'directory':'/tmp/source-custody'},
                {k:v for k,v in self.locator.items() if k!='bundle_pin'}):
            self.assertRaises(ValueError,self.compare,locator=locator)

    def test_create_only_protected_mechanics_retain_original_key_and_refuse_links(self):
        # Real filesystem mechanics under an explicitly Source temporary parent.
        # The current user's identity supplies no host Root custody authority.
        with tempfile.TemporaryDirectory() as directory:
            parent=Path(directory);fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
            try:
                self.c._write_immutable(fd,'custody.key',self.key)
                self.assertEqual((parent/'custody.key').read_bytes(),self.key)
                self.assertEqual((parent/'custody.key').stat().st_mode&0o777,0o400)
                self.assertRaises(ValueError,self.c._write_immutable,fd,'custody.key',b'changed')
                self.assertEqual((parent/'custody.key').read_bytes(),self.key)
                raw,_identity=self.c._read_immutable(fd,'custody.key',32,os.getuid());self.assertEqual(raw,self.key)
                (parent/'custody.json').symlink_to(parent/'custody.key')
                self.assertRaises(ValueError,self.c._write_immutable,fd,'custody.json',b'{}')
                self.assertRaises(ValueError,self.c._read_immutable,fd,'custody.json',65536,os.getuid())
            finally:os.close(fd)

    def test_same_length_tamper_hardlink_or_changed_mode_refuses_actual_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            parent=Path(directory);fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY)
            try:
                self.c._write_immutable(fd,'custody.key',self.key);path=parent/'custody.key'
                os.link(path,parent/'unowned-link')
                self.assertRaises(ValueError,self.c._read_immutable,fd,'custody.key',32,os.getuid())
                (parent/'unowned-link').unlink();path.chmod(0o600)
                self.assertRaises(ValueError,self.c._read_immutable,fd,'custody.key',32,os.getuid())
                path.write_bytes(b'x'*32);path.chmod(0o400)
                key,identity=self.c._read_immutable(fd,'custody.key',32,os.getuid())
                self.assertRaises(ValueError,self.compare,key=key,key_identity=identity)
            finally:os.close(fd)


class CustodyRootGuardsTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import qualification_custody as c
        except ImportError:self.fail('Protected qualification custody is absent')
        self.c=c;self.p=parse_profile(valid_profile())

    def source_negative_bundle(self):
        from rbridge_installation import qualification as q
        p=self.p
        rm=SimpleNamespace(kind='RUNTIME',sha256=p.runtime.manifest_sha256,source_sha=p.runtime.source_sha,
            tree_sha=p.runtime.tree_sha,node_sha256=p.runtime.node_sha256)
        tm=SimpleNamespace(kind='TOOLKIT',sha256=p.toolkit.manifest_sha256,source_sha=p.toolkit.source_sha,
            tree_sha=p.toolkit.tree_sha,node_sha256=p.runtime.node_sha256)
        artifact=SimpleNamespace(path=Path(p.paths.release_parent)/p.runtime.source_sha,
            manifest_sha256=p.runtime.manifest_sha256,source_sha=p.runtime.source_sha,scope='ROOT_DESCRIPTOR_PUBLICATION')
        bundle=q._QualifiedBundle(p,artifact,rm,tm,'a'*64,'b'*64,'c'*64,b'Source canary','d'*64,hashlib.sha256(b'{}').hexdigest())
        request={'python_closure_sha256':bundle.python_closure_sha256}
        locator={'schema':'RBRIDGE_QUALIFICATION_CUSTODY_LOCATOR_V1','directory':'/root/.rbridge-privileged-'+'a'*32,
            'profile_sha256':report_sha256(p),'bundle_pin':q._bundle_pin(bundle),'evidence_sha256':bundle.evidence_sha256,
            'capsule_sha256':'e'*64,'request_sha256':report_sha256(request)}
        # Deliberately false private Source staging remains a negative test.
        self.c._origins[bundle]=(q._bundle_pin(bundle),p,rm,tm,artifact,encode_report(locator).decode(),
            encode_report(request).decode(),'{}')
        self.addCleanup(lambda:self.c._origins.pop(bundle,None))
        return bundle

    def test_source_sealing_blocks_before_original_issuer_or_secret_io(self):
        with patch('os.open',side_effect=AssertionError('Source secret filesystem')), \
             patch.object(self.c,'_issuer_registered',side_effect=AssertionError('Source issuer origin')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_CUSTODY_ROOT_CONTEXT_UNQUALIFIED',
                self.c.seal_root_qualification_bundle,self.p,None,{})

    def test_source_cold_open_blocks_before_key_or_protected_evidence_io(self):
        with patch('os.open',side_effect=AssertionError('Source cold Root open')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_CUSTODY_ROOT_CONTEXT_UNQUALIFIED',
                self.c.open_root_qualification_custody,self.p,{'scope':'ROOT_ISSUER_CUSTODY_PREPARATION_ONLY'},{})

    def test_caller_signed_source_data_cannot_register_cold_root_origin(self):
        for value in ({'scope':'ROOT_ISSUER_CUSTODY_PREPARATION_ONLY','status':'PASS'},object()):
            with patch('os.open',side_effect=AssertionError('Caller cold Root open')):
                self.assertRaisesRegex(ValueError,'QUALIFICATION_ISSUER_ORIGIN_UNQUALIFIED',
                    self.c.verify_root_custody_origin,self.p,value)

    def test_fixed_signing_key_factory_cannot_create_or_read_any_root_anchor_from_source(self):
        factory=getattr(self.c,'_SigningKeys',None)
        self.assertIsNotNone(factory,'A caller-selected carrier key is not a trusted issuer anchor')
        with patch('os.open',side_effect=AssertionError('Source anchor Root open')), \
             patch('os.mkdir',side_effect=AssertionError('Source anchor Root mkdir')):
            for create in (False,True):
                self.assertRaisesRegex(ValueError,'QUALIFICATION_CUSTODY_ROOT_CONTEXT_UNQUALIFIED',factory,
                    self.p,{},create=create,bundle=None)

    def test_false_complete_cold_source_origin_still_refuses_actual_root_context(self):
        bundle=self.source_negative_bundle()
        with patch('os.open',side_effect=AssertionError('False cold Root open')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_CUSTODY_ROOT_CONTEXT_UNQUALIFIED',
                self.c.verify_root_custody_origin,self.p,bundle)

    def test_changed_retained_full_evidence_or_request_refuses_before_root_key_io(self):
        bundle=self.source_negative_bundle();original=self.c._origins[bundle]
        for index,value in ((7,'{"status":"PASS"}'),(6,encode_report({'python_closure_sha256':'f'*64}).decode())):
            row=list(original);row[index]=value;self.c._origins[bundle]=tuple(row)
            with patch('os.open',side_effect=AssertionError('Changed cold Root key open')):
                self.assertRaisesRegex(ValueError,'QUALIFICATION_CUSTODY_ORIGIN_CHANGED',
                    self.c.verify_root_custody_origin,self.p,bundle)
        self.c._origins[bundle]=original


if __name__=='__main__':unittest.main()
