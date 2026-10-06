"""Descriptor canary and complete carrier fixtures, never live transport claims."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from _loader import toolkit
from _fixtures import valid_profile


class AcceptanceTransportTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.acceptance_transport import (
                _create_fixture_canary, build_carrier_capture, QualifiedAcceptanceBackend)
        except ImportError:
            self.fail('Fixed authenticated acceptance transport is not implemented')
        from rbridge_installation.profile import parse_profile
        self.create,self.capture,self.Backend=_create_fixture_canary,build_carrier_capture,QualifiedAcceptanceBackend
        self.profile=parse_profile(valid_profile())
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);os.chmod(self.root,0o700)
        self.bytes=b'bounded nonsensitive fixture\n'
        self.request={'schema':'COCWIN_REMOTE_BRIDGE_REQUEST_V2','requestId':'source-canary',
            'createdAt':'2026-10-06T00:00:00.000Z','expiresAt':'2026-10-06T00:02:00.000Z',
            'operation':{'kind':'HEALTH','action':'STATUS'}}
        from rbridge_installation.models import encode_report
        self.issue={'number':17,'title':'[COCWIN BRIDGE REQUEST] source-canary',
            'body':encode_report(self.request).decode(), 'user':{'login':self.profile.binding.author},
            'html_url':'https://github.com/'+self.profile.binding.repository+'/issues/17',
            'state':'closed','comments':1,'updated_at':'2026-10-06T00:02:00Z'}
        self.comment={'id':20,'user':{'login':self.profile.binding.author},'body':'fixture carrier',
            'html_url':self.issue['html_url']+'#issuecomment-20'}

    def test_create_only_canary_pins_full_descriptor_bytes_and_keeps_file(self):
        canary=self.create(self.root/'canary.txt',self.bytes)
        self.addCleanup(canary.close)
        self.assertEqual(canary.readback()['sha256'],hashlib.sha256(self.bytes).hexdigest())
        self.assertEqual((self.root/'canary.txt').read_bytes(),self.bytes)
        self.assertEqual((self.root/'canary.txt').stat().st_mode&0o777,0o444)

    def test_preexisting_file_or_symlink_is_preserved_and_replacement_fails_readback(self):
        target=self.root/'canary.txt';other=self.root/'other';other.write_bytes(b'original')
        target.symlink_to(other)
        self.assertRaises(ValueError,self.create,target,self.bytes)
        self.assertTrue(target.is_symlink());self.assertEqual(other.read_bytes(),b'original')
        target.unlink();target.write_bytes(b'original')
        self.assertRaises(ValueError,self.create,target,self.bytes)
        self.assertEqual(target.read_bytes(),b'original')
        target.unlink();canary=self.create(target,self.bytes);self.addCleanup(canary.close)
        target.unlink();target.write_bytes(self.bytes)
        self.assertRaises(ValueError,canary.readback)

    def test_full_closed_capture_preserves_request_comments_and_complete_hash(self):
        result=self.capture(self.profile,self.request,17,self.issue,[self.comment],dict(self.issue),self.profile.binding.author,'c'*64)
        self.assertEqual(result['scope'],'FIXTURE_AUTHORITY_ONLY')
        self.assertEqual(result['issue']['state'],'CLOSED');self.assertEqual(len(result['comments']),1)
        from rbridge_installation.models import report_sha256
        self.assertEqual(result['capture_sha256'],report_sha256({k:v for k,v in result.items() if k!='capture_sha256'}))

    def test_wrong_viewer_author_number_body_count_or_incomplete_capture_is_refused(self):
        for key,value in [('number',18),('body','changed'),('user',{'login':'attacker'}),('comments',2),('pull_request',{})]:
            with self.subTest(key=key):
                bad={**self.issue,key:value}
                self.assertRaises(ValueError,self.capture,self.profile,self.request,17,bad,[self.comment],bad,self.profile.binding.author,'c'*64)
        changed={**self.issue,'updated_at':'2026-10-06T00:03:00Z'}
        self.assertRaises(ValueError,self.capture,self.profile,self.request,17,self.issue,[self.comment],changed,self.profile.binding.author,'c'*64)
        self.assertRaises(ValueError,self.capture,self.profile,self.request,17,self.issue,[self.comment],self.issue,'attacker','c'*64)
        self.assertRaises(ValueError,self.capture,self.profile,self.request,17,self.issue,[self.comment,self.comment],self.issue,self.profile.binding.author,'c'*64)

    def test_plain_context_scope_strings_never_construct_actual_backend(self):
        self.assertRaises(ValueError,self.Backend,{'scope':'QUALIFIED_INSTALLED_ACCEPTANCE'},None)


if __name__=='__main__':unittest.main()
