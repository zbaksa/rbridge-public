from pathlib import Path
import os
import tempfile
import threading
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import runtime_stage,valid_profile

class CopyTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.protected_copy import publish_artifact,verify_published,FilesystemAuthority,CopyError
        except ImportError:self.fail('Descriptor publication is not implemented')
        from rbridge_installation.artifact import inventory_artifact
        from rbridge_installation.profile import parse_profile
        self.publish,self.verify,self.Authority,self.error=publish_artifact,verify_published,FilesystemAuthority,CopyError
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.stage=self.root/'stage';self.parent=self.root/'protected'
        self.stage.mkdir();self.parent.mkdir();runtime_stage(self.stage)
        self.manifest=inventory_artifact(self.stage,'RUNTIME',parse_profile(valid_profile()))
        flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
        self.stage_fd=os.open(self.stage,flags);self.parent_fd=os.open(self.parent,flags)
        self.addCleanup(os.close,self.stage_fd);self.addCleanup(os.close,self.parent_fd)
        self.authority=self.Authority(root_uid=os.getuid(),runtime_uid=os.getuid(),parent_path=self.parent,role='RUNTIME',production=False)

    def test_copy_rejects_existing_release_or_escaping_link(self):
        dest=self.parent/self.manifest.source_sha;dest.mkdir();old=dest/'keep';old.write_text('old release')
        with self.assertRaises(self.error):self.publish(self.stage_fd,self.parent_fd,self.manifest,self.authority)
        self.assertEqual(old.read_text(),'old release')
        old.unlink();dest.rmdir()
        (self.stage/'node_modules/escape').symlink_to('/etc/passwd')
        with self.assertRaises(self.error):self.publish(self.stage_fd,self.parent_fd,self.manifest,self.authority)
        self.assertFalse(dest.exists())

    def test_copy_parent_swap_never_publishes_replacement(self):
        old=self.parent/'old-release';old.write_text('untouched')
        entered_r,entered_w=os.pipe();done_r,done_w=os.pipe()
        for fd in (entered_r,entered_w,done_r,done_w):self.addCleanup(os.close,fd)
        moved=self.root/'original-parent';real_open=os.open;swapped=False
        def actor():
            os.read(entered_r,1);self.parent.rename(moved);self.parent.mkdir();os.write(done_w,b'x')
        thread=threading.Thread(target=actor);thread.start()
        def guarded_open(path,*args,**kwargs):
            nonlocal swapped
            fd=real_open(path,*args,**kwargs)
            if path=='dist' and kwargs.get('dir_fd')==self.stage_fd and not swapped:
                swapped=True;os.write(entered_w,b'x');os.read(done_r,1)
            return fd
        try:
            with patch('rbridge_installation.protected_copy.os.open',side_effect=guarded_open):
                with self.assertRaises(self.error):self.publish(self.stage_fd,self.parent_fd,self.manifest,self.authority)
        finally:
            if not swapped:os.write(entered_w,b'x')
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive());self.assertEqual((moved/'old-release').read_text(),'untouched')
        for parent in (self.parent,moved):self.assertFalse((parent/self.manifest.source_sha).exists())

    def test_copy_hashes_files_and_preserves_confined_links(self):
        (self.stage/'node_modules/link').symlink_to('fixture-dependency/index.js')
        from rbridge_installation.artifact import inventory_artifact
        from rbridge_installation.profile import parse_profile
        manifest=inventory_artifact(self.stage,'RUNTIME',parse_profile(valid_profile()))
        result=self.publish(self.stage_fd,self.parent_fd,manifest,self.authority)
        self.assertEqual(result.manifest_sha256,manifest.sha256)
        self.assertEqual(self.verify(result.path,manifest,self.authority).status,'PASS')
        self.assertTrue((result.path/'node_modules/link').is_symlink())
        self.assertEqual(os.stat(result.path/'package.json').st_mode&0o777,0o644)

    def test_stage_inode_swap_between_stat_and_open_fails(self):
        entered_r,entered_w=os.pipe();done_r,done_w=os.pipe()
        for fd in (entered_r,entered_w,done_r,done_w):self.addCleanup(os.close,fd)
        real_open=os.open;swapped=False
        def actor():
            os.read(entered_r,1);(self.stage/'package.json').rename(self.stage/'old-package');os.mkfifo(self.stage/'package.json');os.write(done_w,b'x')
        thread=threading.Thread(target=actor);thread.start()
        def guarded_open(path,*args,**kwargs):
            nonlocal swapped
            if path=='package.json' and kwargs.get('dir_fd')==self.stage_fd and not swapped:
                swapped=True;os.write(entered_w,b'x');os.read(done_r,1)
            return real_open(path,*args,**kwargs)
        try:
            with patch('rbridge_installation.protected_copy.os.open',side_effect=guarded_open):
                with self.assertRaises(self.error):self.publish(self.stage_fd,self.parent_fd,self.manifest,self.authority)
        finally:
            if not swapped:os.write(entered_w,b'x')
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive());self.assertFalse((self.parent/self.manifest.source_sha).exists())

    def test_atomic_destination_collision_cannot_overwrite_new_release(self):
        from rbridge_installation import protected_copy
        actual=protected_copy._rename_exclusive
        def race(fd,old,new):
            os.mkdir(new,dir_fd=fd)
            parent=os.open(new,os.O_RDONLY|os.O_DIRECTORY,dir_fd=fd)
            try:
                handle=os.open('keep',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=parent)
                try:os.write(handle,b'concurrent release')
                finally:os.close(handle)
            finally:os.close(parent)
            return actual(fd,old,new)
        with patch('rbridge_installation.protected_copy._rename_exclusive',side_effect=race):
            with self.assertRaises(self.error):self.publish(self.stage_fd,self.parent_fd,self.manifest,self.authority)
        self.assertEqual((self.parent/self.manifest.source_sha/'keep').read_text(),'concurrent release')

    def test_writable_parent_or_modified_published_file_is_rejected(self):
        self.parent.chmod(0o777)
        with self.assertRaises(self.error):self.publish(self.stage_fd,self.parent_fd,self.manifest,self.authority)
        self.parent.chmod(0o700)
        result=self.publish(self.stage_fd,self.parent_fd,self.manifest,self.authority)
        (result.path/'package.json').write_text('replacement')
        with self.assertRaises(self.error):self.verify(result.path,self.manifest,self.authority)

    def test_production_authority_requires_approved_manifest_before_copy(self):
        authority=self.Authority(0,1027,self.parent,'RUNTIME')
        with self.assertRaises(self.error) as caught:self.publish(self.stage_fd,self.parent_fd,self.manifest,authority)
        self.assertEqual(caught.exception.reason,'COPY_APPROVED_MANIFEST_REQUIRED')
