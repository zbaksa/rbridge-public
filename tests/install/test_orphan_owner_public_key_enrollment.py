"""Root create-once public-key enrollment is non-authorizing and fail-closed.

Source tests never create /root storage, use the real owner key, invoke sudo,
or simulate a complete owner-authenticated Root enrollment.
"""
import hashlib
import os
from types import SimpleNamespace
import stat
import unittest
from unittest.mock import patch
from _loader import toolkit

# RFC 8032 public test key: NOT an enrolled owner credential.
_PUBLIC=bytes.fromhex(
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c')

class OwnerEnrollmentDataOnlyTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation import orphan_owner_public_key_enrollment as mod
        self.mod=mod
        self.sha=hashlib.sha256(_PUBLIC).hexdigest()

    def test_public_key_input_review_never_enrolls_owner(self):
        row=self.mod.review_public_key_enrollment_data(_PUBLIC,self.sha)
        self.assertEqual(row['status'],'PUBLIC_KEY_BYTES_MATCH_UNTRUSTED_FINGERPRINT')
        self.assertEqual(row['public_key_bytes'],32)
        self.assertEqual(row['public_key_sha256'],self.sha)
        for key in ('owner_key_enrolled','owner_authenticated',
                    'may_settle','may_launch','may_resume_qualification',
                    'may_change_production'):
            self.assertIs(row[key],False)

    def test_forged_matching_key_still_cannot_grant_authority(self):
        for candidate in (_PUBLIC,b'\x19'*32,b'\xff'*32):
            with self.subTest(sha=hashlib.sha256(candidate).hexdigest()):
                row=self.mod.review_public_key_enrollment_data(
                    candidate,hashlib.sha256(candidate).hexdigest())
                self.assertIs(row['owner_authenticated'],False)
                self.assertIs(row['may_launch'],False)

    def test_mismatch_zero_key_wrong_length_wrong_sha_fail_closed(self):
        for raw,sha in (
            (_PUBLIC,'f'*64),(_PUBLIC,'X'*64),(_PUBLIC,'0'*63),
            (_PUBLIC,None),(_PUBLIC,123),(_PUBLIC,self.sha.upper()),
            (bytes(32),hashlib.sha256(bytes(32)).hexdigest()),
            (b'\x55'*31,hashlib.sha256(b'\x55'*31).hexdigest()),
            (b'\x55'*33,hashlib.sha256(b'\x55'*33).hexdigest()),
            (None,self.sha),(123,self.sha),("not bytes",self.sha)):
            with self.subTest(t=str(type(raw)),sha=str(sha)[:16]):
                with self.assertRaises(ValueError):
                    self.mod.review_public_key_enrollment_data(raw,sha)

    def test_nonroot_refuses_before_filesystem_or_tty_access(self):
        if os.getuid()!=0 and os.geteuid()!=0:
            with patch.object(self.mod.os,'open',side_effect=AssertionError(
                    'unexpected Root or TTY path access')):
                with self.assertRaisesRegex(
                        ValueError,'ORPHAN_OWNER_ENROLL_ROOT_REQUIRED'):
                    self.mod.enroll_owner_public_key_create_once(_PUBLIC,self.sha)

    def test_direct_tty_requires_foreground_and_exact_fingerprint_ack(self):
        fakefd=123456
        statement=('ENROLL-ED25519-PUBLIC-KEY '+self.sha.upper()).encode('ascii')
        reads=[bytes([c]) for c in statement+b'\n']
        ttystat=SimpleNamespace(st_mode=stat.S_IFCHR|0o600)
        with patch.object(self.mod.os,'open',return_value=fakefd), \
             patch.object(self.mod.os,'fstat',return_value=ttystat), \
             patch.object(self.mod.os,'isatty',return_value=True), \
             patch.object(self.mod.os,'tcgetpgrp',return_value=101), \
             patch.object(self.mod.os,'getpgrp',return_value=101), \
             patch.object(self.mod.os,'read',side_effect=reads), \
             patch.object(self.mod.os,'write',return_value=123), \
             patch.object(self.mod.os,'close'):
            self.assertIs(self.mod._read_direct_owner_tty(self.sha),True)

    def test_direct_tty_mismatch_fails_without_provisioning(self):
        tty=SimpleNamespace(st_mode=stat.S_IFCHR|0o600)
        for fake_read in ([b'X',b'\n'],[b''],[b'\x41']*129):
            with self.subTest(length=len(fake_read)), \
                 patch.object(self.mod.os,'open',return_value=23), \
                 patch.object(self.mod.os,'fstat',return_value=tty), \
                 patch.object(self.mod.os,'isatty',return_value=True), \
                 patch.object(self.mod.os,'tcgetpgrp',return_value=1), \
                 patch.object(self.mod.os,'getpgrp',return_value=1), \
                 patch.object(self.mod.os,'read',side_effect=fake_read), \
                 patch.object(self.mod.os,'write',return_value=123), \
                 patch.object(self.mod.os,'close'):
                with self.assertRaises(ValueError):
                    self.mod._read_direct_owner_tty(self.sha)

    def test_background_terminal_is_never_confirmation(self):
        tty=SimpleNamespace(st_mode=stat.S_IFCHR|0o600)
        with patch.object(self.mod.os,'open',return_value=23), \
             patch.object(self.mod.os,'fstat',return_value=tty), \
             patch.object(self.mod.os,'isatty',return_value=True), \
             patch.object(self.mod.os,'tcgetpgrp',return_value=101), \
             patch.object(self.mod.os,'getpgrp',return_value=102), \
             patch.object(self.mod.os,'close'):
            with self.assertRaisesRegex(
                    ValueError,'ORPHAN_OWNER_ENROLL_FOREGROUND_TTY_REQUIRED'):
                self.mod._read_direct_owner_tty(self.sha)

    def test_expected_parent_mtime_change_does_not_change_identity(self):
        x=SimpleNamespace(st_dev=1,st_ino=9,st_mode=stat.S_IFDIR|0o700,
                          st_uid=0,st_gid=0,st_nlink=2,st_size=4096,
                          st_mtime_ns=100,st_ctime_ns=200)
        y=SimpleNamespace(st_dev=1,st_ino=9,st_mode=stat.S_IFDIR|0o700,
                          st_uid=0,st_gid=0,st_nlink=2,st_size=4128,
                          st_mtime_ns=110,st_ctime_ns=210)
        self.assertEqual(self.mod._protected_directory_id(x),
                         self.mod._protected_directory_id(y))
        self.assertNotEqual(self.mod._stat_identity(x),
                            self.mod._stat_identity(y))
        changed=SimpleNamespace(**{**vars(y),'st_ino':10})
        self.assertNotEqual(self.mod._protected_directory_id(x),
                            self.mod._protected_directory_id(changed))

    def test_no_private_key_field_or_qualification_entitlement(self):
        report=self.mod.review_public_key_enrollment_data(_PUBLIC,self.sha)
        for key in ('private_key','private_key_pem','owner_signature',
                    'owner_key_authenticated','root_qualification_authorized',
                    'signed_root_lease','journal_settled'):
            self.assertNotIn(key,report)

if __name__=='__main__':
    unittest.main()
