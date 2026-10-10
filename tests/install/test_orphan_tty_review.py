"""A typed TTY acknowledgement is only data, never Root admission."""
import unittest
import stat
from types import SimpleNamespace
from unittest.mock import patch
from _loader import toolkit
import test_orphan_intent_review_packet as fixtures

class OrphanTTYReviewTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.orphan_tty_review import (
            compare_tty_review_response,collect_root_tty_review_data)
        self.compare=compare_tty_review_response
        self.collect=collect_root_tty_review_data
        self.peer=fixtures.OrphanReviewPacketTests(
            'test_exact_claim_is_only_unverified_data')
        self.peer.setUp()
        self.nonce='a'*32
        self.response=b'ACKNOWLEDGE UNKNOWN '+self.nonce.encode()+b'\n'

    def test_exact_response_matches_without_authority(self):
        value=self.compare(self.nonce,self.response)
        self.assertEqual(value['status'],'BYTE_MATCH_ONLY')
        self.assertEqual(value['schema'],'RBRIDGE_ORPHAN_TTY_COMPARISON_V1')
        for name in ('owner_authenticated','may_launch',
                     'may_resume_qualification','may_change_production'):
            self.assertIs(value[name],False)

    def test_replay_with_different_challenge_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'ORPHAN_TTY_RESPONSE_MISMATCH'):
            self.compare('b'*32,self.response)

    def test_unqualified_responses_are_rejected(self):
        for response in (
            self.response[:-1],
            self.response+b'EXTRA',
            b'ACKNOWLEDGE UNKNOWN '+b'a'*32+b'\r\n',
            b'APPROVE RESTART '+b'a'*32+b'\n',
            b'',b'x'*129):
            with self.subTest(length=len(response)):
                with self.assertRaises(ValueError):
                    self.compare(self.nonce,response)

    def test_invalid_challenge_types_are_rejected(self):
        for nonce in ('0'*32,'A'*32,'x',True,1,'a'*31):
            with self.subTest(nonce=nonce):
                with self.assertRaises(ValueError):
                    self.compare(nonce,self.response)

    def test_root_collector_refuses_nonroot_before_tty_io(self):
        import os
        if os.getuid()!=0:
            with self.assertRaisesRegex(ValueError,'ORPHAN_TTY_ROOT_REQUIRED'):
                self.collect(self.peer.observation,self.peer.claim)

    def test_not_a_crypto_signature_or_settlement(self):
        value=self.compare(self.nonce,self.response)
        self.assertNotIn('signature',value)
        self.assertNotIn('settled',value)
        self.assertNotIn('root_disposition_written',value)
        self.assertIs(value['owner_authenticated'],False)

    def _simulate_real_root_foreground(self, *, tty_paths=None,
                                      tty_owner=1027, foreground=True,
                                      tty_kind=stat.S_IFCHR):
        """Mock-only source test: never reads a real Root terminal."""
        from rbridge_installation import orphan_tty_review as mod
        from rbridge_installation import host_backend
        paths=tty_paths or {0:'/dev/pts/5',1:'/dev/pts/5',2:'/dev/pts/5'}
        tty=SimpleNamespace(st_uid=tty_owner,st_mode=stat.S_IFCHR|0o600)
        readback=b'ACKNOWLEDGE UNKNOWN '+b'a'*32+b'\n'
        with patch.object(mod.os,'getuid',return_value=0), \
             patch.object(mod.os,'geteuid',return_value=0), \
             patch.object(mod.os,'getgid',return_value=0), \
             patch.object(mod.os,'getegid',return_value=0), \
             patch.object(mod.sys,'flags',
                          SimpleNamespace(isolated=1,no_site=1,
                                          dont_write_bytecode=1)), \
             patch.object(mod.os,'getcwd',return_value='/'), \
             patch.object(host_backend,'_assert_kernel_namespace'), \
             patch.object(mod.os,'isatty',return_value=True), \
             patch.object(mod.os,'open',return_value=99), \
             patch.object(mod.os,'fstat',
                          return_value=SimpleNamespace(st_mode=tty_kind|0o600)), \
             patch.object(mod.os,'ttyname',side_effect=lambda fd:paths[fd]), \
             patch.object(mod.os,'stat',return_value=tty), \
             patch.object(mod.os,'tcgetpgrp',return_value=7), \
             patch.object(mod.os,'getpgrp',return_value=7 if foreground else 8), \
             patch.object(mod.termios,'tcgetattr',
                          return_value=[0,0,0,mod.termios.ICANON,0,0,[]]), \
             patch.object(mod.secrets,'token_hex',return_value='a'*32), \
             patch.object(mod.os,'write',return_value=160), \
             patch.object(mod.select,'select',
                          return_value=([99],[],[])), \
             patch.object(mod.os,'read',return_value=readback), \
             patch.object(mod.os,'close'):
            return mod.collect_root_tty_review_data(
                self.peer.observation,self.peer.claim)

    def test_foreground_real_pts_owner_can_receive_data_only_review(self):
        # libc ttyname(open("/dev/tty")) may be "/dev/tty",
        # unlike ttyname(0..2), which returns "/dev/pts/N".
        # This is an explicit production-predicate fixture, not Root PASS.
        observed=self._simulate_real_root_foreground()
        self.assertEqual(observed['status'],'ATTENDED_DATA_ONLY')
        self.assertIs(observed['local_tty_present'],True)
        for k in ('owner_authenticated','may_settle','may_launch',
                  'may_resume_qualification','may_change_production'):
            self.assertIs(observed[k],False)

    def test_foreground_tty_cannot_be_mixed_or_spoofed(self):
        cases=(
            {'tty_paths':{0:'/dev/pts/5',1:'/dev/pts/6',2:'/dev/pts/5'}},
            {'tty_paths':{0:'/dev/pts/5',1:'/dev/pts/5',2:'/dev/pts/6'}},
            {'tty_paths':{0:'/dev/tty',1:'/dev/tty',2:'/dev/tty'}},
            {'tty_paths':{0:'/dev/pts/../pts/5',
                          1:'/dev/pts/../pts/5',2:'/dev/pts/../pts/5'}},
            {'tty_owner':0},
            {'tty_owner':1028},
            {'foreground':False},
            {'tty_kind':stat.S_IFREG},
        )
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                with self.assertRaisesRegex(
                        ValueError,'ORPHAN_TTY_FOREGROUND_UNQUALIFIED'):
                    self._simulate_real_root_foreground(**kwargs)

if __name__=='__main__':
    unittest.main()
