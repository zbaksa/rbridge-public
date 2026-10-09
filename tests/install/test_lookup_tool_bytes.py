"""Real tool-byte fixtures with Source ownership; no Root or command origin."""
import hashlib
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from _loader import toolkit


class _SourceOwnedStat:
    def __init__(self, row):
        self.row = row

    def __getattr__(self, name):
        if name == 'st_uid' and self.row.st_uid == os.getuid():
            return 0
        return getattr(self.row, name)


class LookupToolBytesTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation import github_lookup, host_backend, protected_copy
        self.lookup, self.host = github_lookup, host_backend
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name) / 'protected'
        self.parent.mkdir(mode=0o700)
        self.tool = self.parent / 'gh-fixture'
        # The deployed pinned Go executable exceeds the old 16 MiB ceiling.
        # A sparse fixture keeps disk use small; hashing must read its final byte.
        with self.tool.open('xb') as output:
            output.write(b'SOURCE_TOOL_BYTES_ONLY\n')
            output.seek(35_248_672 - 1)
            output.write(b'Z')
        self.tool.chmod(0o755)
        with self.tool.open('rb') as source:
            self.expected = hashlib.file_digest(source, 'sha256').hexdigest()
        self.backend = object.__new__(github_lookup.QualifiedGitHubReadBackend)
        self.backend.tool = SimpleNamespace(path=str(self.tool), sha256=self.expected)

        # Adapt only ownership to the Source fixture account. The actual parent
        # descriptors, no-follow opens, reads, lengths, hashes and mode/link checks
        # remain production code. This adapter cannot issue a Root observation.
        def fixture_parent(authority):
            return protected_copy.ProtectedParent(protected_copy.FilesystemAuthority(
                os.getuid(), os.getuid(), authority.parent_path,
                authority.role, production=False))

        self.source_os = SimpleNamespace(**vars(os))
        self.source_os.fstat = lambda fd: _SourceOwnedStat(os.fstat(fd))
        self.source_os.stat = lambda *args, **kwargs: _SourceOwnedStat(os.stat(*args, **kwargs))
        self.enterContext(patch.object(host_backend, 'ProtectedParent', fixture_parent))
        self.enterContext(patch.object(host_backend, 'os', self.source_os))

    def test_complete_pinned_tool_larger_than_sixteen_mib_is_qualified(self):
        try:
            self.backend._qualify()
        except self.lookup.LookupError as error:
            self.fail('Complete pinned 35 MB tool was rejected: ' + str(error))

    def test_changed_final_byte_beyond_sixteen_mib_is_rejected(self):
        with self.tool.open('r+b') as output:
            output.seek(-1, os.SEEK_END)
            output.write(b'X')
        with self.assertRaisesRegex(self.lookup.LookupError, 'LOOKUP_TOOL_UNQUALIFIED'):
            self.backend._qualify()

    def test_equal_bytes_at_symlink_or_hardlink_are_rejected(self):
        link = self.parent / 'linked-tool'
        link.symlink_to(self.tool.name)
        self.backend.tool.path = str(link)
        with self.assertRaisesRegex(self.lookup.LookupError, 'LOOKUP_TOOL_UNQUALIFIED'):
            self.backend._qualify()
        link.unlink()
        os.link(self.tool, link)
        self.backend.tool.path = str(self.tool)
        with self.assertRaisesRegex(self.lookup.LookupError, 'LOOKUP_TOOL_UNQUALIFIED'):
            self.backend._qualify()

    def test_writable_parent_or_tool_is_rejected(self):
        self.parent.chmod(0o777)
        with self.assertRaisesRegex(self.lookup.LookupError, 'LOOKUP_TOOL_UNQUALIFIED'):
            self.backend._qualify()
        self.parent.chmod(0o700)
        self.tool.chmod(0o777)
        with self.assertRaisesRegex(self.lookup.LookupError, 'LOOKUP_TOOL_UNQUALIFIED'):
            self.backend._qualify()

    def test_wrong_digest_or_missing_pinned_path_is_rejected(self):
        self.backend.tool.sha256 = 'f' * 64
        with self.assertRaisesRegex(self.lookup.LookupError, 'LOOKUP_TOOL_UNQUALIFIED'):
            self.backend._qualify()
        self.backend.tool.sha256 = self.expected
        self.backend.tool.path = str(self.parent / 'missing-tool')
        with self.assertRaisesRegex(self.lookup.LookupError, 'LOOKUP_TOOL_UNQUALIFIED'):
            self.backend._qualify()

    def test_tool_exceeding_fixed_process_ceiling_is_rejected_before_read(self):
        with self.tool.open('r+b') as output:
            output.truncate(268_435_456 + 1)

        def unexpected_read(*_args):
            self.fail('Oversized executable was read before its size was refused')

        self.source_os.read = unexpected_read
        with self.assertRaisesRegex(self.lookup.LookupError, 'LOOKUP_TOOL_UNQUALIFIED'):
            self.backend._qualify()


if __name__ == '__main__':
    unittest.main()
