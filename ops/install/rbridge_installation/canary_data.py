"""Exact nonsensitive canary DATA, never code, configuration or Root authority.

The fixed /mnt/data anchor may be shared. Retained descriptors and reviewed
bytes constrain each observation; they do not make that namespace immutable.
Control-file readers continue to require their complete protected ancestry.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from .artifact import _identity
from .models import InstallationError, encode_report
from .profile import parse_profile
from .protected_copy import DIR_FLAGS, FILE_FLAGS, _same


class CanaryDataError(InstallationError):
    pass


def _fail(reason):
    raise CanaryDataError(reason)


def _path(value):
    try:
        text = os.fspath(value)
    except TypeError:
        _fail('CANARY_DATA_PATH_INVALID')
    if (type(text) is not str or not text.startswith('/') or text == '/'
            or len(text.encode('utf-8', errors='strict')) > 4096
            or any(p in ('', '.', '..') for p in text.split('/')[1:])
            or any(c in text for c in '\0\r\n')):
        _fail('CANARY_DATA_PATH_INVALID')
    return Path(text)


def _expected(data):
    if type(data) is not bytes or not 1 <= len(data) <= 4096:
        _fail('CANARY_DATA_EXPECTED_BYTES_INVALID')
    try:
        data.decode('utf-8', errors='strict')
    except UnicodeError:
        _fail('CANARY_DATA_EXPECTED_BYTES_INVALID')
    return hashlib.sha256(data).hexdigest()


def _directory_identity(row):
    return list(map(str, (row.st_dev, row.st_ino, row.st_mode, row.st_uid, row.st_gid)))


class _CanaryDataObservation:
    """Read-only descriptor mechanics. This object is not a collector origin."""
    def __init__(self, path, expected_sha256, production, expected_data=None):
        self.path = _path(path)
        self.production = production
        self.owner = 0 if production else os.getuid()
        self.handles = []
        self.links = []
        self.fd = None
        self.closed = False
        if type(production) is not bool or type(expected_sha256) is not str or re.fullmatch('[0-9a-f]{64}', expected_sha256) is None:
            _fail('CANARY_DATA_EXPECTED_DIGEST_INVALID')
        if expected_data is not None and _expected(expected_data) != expected_sha256:
            _fail('CANARY_DATA_EXPECTED_BYTES_CHANGED')
        self.sha256 = expected_sha256
        self.expected_data = expected_data
        if production:
            if (not str(self.path).startswith('/mnt/data/') or os.getuid() != 0 or os.geteuid() != 0
                    or not sys.flags.isolated or not sys.flags.no_site or not sys.flags.dont_write_bytecode):
                _fail('CANARY_DATA_ROOT_CONTEXT_UNQUALIFIED')
            from .host_backend import _assert_kernel_namespace
            _assert_kernel_namespace()
        try:
            parent = os.open('/', DIR_FLAGS)
            self.handles.append(parent)
            self.root_identity = os.fstat(parent)
            self._directory(Path('/'), self.root_identity)
            current = Path('/')
            for name in self.path.parts[1:-1]:
                current = current / name
                before = os.stat(name, dir_fd=parent, follow_symlinks=False)
                self._directory(current, before)
                child = os.open(name, DIR_FLAGS, dir_fd=parent)
                self.handles.append(child)
                if not _same(before, os.fstat(child)):
                    _fail('CANARY_DATA_PARENT_CHANGED')
                self.links.append((parent, name, child, before, str(current)))
                parent = child
            self.parent = parent
            before = os.stat(self.path.name, dir_fd=parent, follow_symlinks=False)
            self._leaf(before)
            self.fd = os.open(self.path.name, FILE_FLAGS, dir_fd=parent)
            self.handles.append(self.fd)
            self.identity = _identity(before)
            if _identity(os.fstat(self.fd)) != self.identity:
                _fail('CANARY_DATA_FILE_CHANGED')
            self.read_bytes()
        except BaseException as error:
            self.close()
            if isinstance(error, OSError):
                _fail('CANARY_DATA_READ_UNAVAILABLE')
            raise

    def _directory(self, path, row):
        if not stat.S_ISDIR(row.st_mode):
            _fail('CANARY_DATA_PARENT_INVALID')
        if self.production:
            # Only the data mount itself is exempt from Root ancestry policy.
            # Any directory below it, and / plus /mnt, remains protected.
            if path != Path('/mnt/data') and (row.st_uid != 0 or row.st_mode & 0o6022):
                _fail('CANARY_DATA_PARENT_UNPROTECTED')
            searchable = (row.st_mode & (0o100 if row.st_uid == 1027 else 0o010 if row.st_gid == 1027 else 0o001))
            if not searchable:
                _fail('CANARY_DATA_PARENT_UNREADABLE')

    def _leaf(self, row):
        if (not stat.S_ISREG(row.st_mode) or row.st_uid != self.owner or row.st_nlink != 1
                or stat.S_IMODE(row.st_mode) != 0o444 or not 1 <= row.st_size <= 4096):
            _fail('CANARY_DATA_FILE_UNQUALIFIED')

    def _check(self):
        if self.closed:
            _fail('CANARY_DATA_OBSERVATION_CLOSED')
        if (not _same(self.root_identity, os.fstat(self.handles[0]))
                or not _same(self.root_identity, os.stat('/', follow_symlinks=False))):
            _fail('CANARY_DATA_PARENT_CHANGED')
        for parent, name, child, before, _path_value in self.links:
            if (not _same(before, os.fstat(child))
                    or not _same(before, os.stat(name, dir_fd=parent, follow_symlinks=False))):
                _fail('CANARY_DATA_PARENT_CHANGED')
        row = os.fstat(self.fd)
        self._leaf(row)
        if (_identity(row) != self.identity
                or _identity(os.stat(self.path.name, dir_fd=self.parent, follow_symlinks=False)) != self.identity):
            _fail('CANARY_DATA_FILE_CHANGED')

    def read_bytes(self):
        try:
            self._check()
            os.lseek(self.fd, 0, os.SEEK_SET)
            raw = bytearray()
            while len(raw) <= 4096:
                part = os.read(self.fd, 4097 - len(raw))
                if not part:
                    break
                raw.extend(part)
            self._check()
            data = bytes(raw)
            if (len(data) != self.identity[6] or hashlib.sha256(data).hexdigest() != self.sha256
                    or self.expected_data is not None and data != self.expected_data):
                _fail('CANARY_DATA_BYTES_CHANGED')
            data.decode('utf-8', errors='strict')
            return data
        except OSError:
            _fail('CANARY_DATA_READ_UNAVAILABLE')
        except UnicodeError:
            _fail('CANARY_DATA_UTF8_INVALID')

    def readback(self):
        data = self.read_bytes()
        ancestors = [{'path': '/', 'identity': _directory_identity(self.root_identity)}]
        ancestors.extend({'path': path, 'identity': _directory_identity(before)}
                         for _parent, _name, _child, before, path in self.links)
        return {'schema': 'RBRIDGE_CANARY_DATA_OBSERVATION_V1',
                'scope': 'ROOT_CANARY_DATA_OBSERVATION_ONLY' if self.production else 'SOURCE_CANARY_DATA_FIXTURE_ONLY',
                'path': str(self.path), 'sha256': self.sha256, 'identity': list(map(str, self.identity)),
                'bytes': len(data), 'mode': 0o444, 'owner': self.owner, 'ancestors': ancestors,
                'namespace_immutability': 'NOT_ASSERTED', 'control_file_authority': False}

    def close(self):
        for handle in reversed(self.handles):
            os.close(handle)
        self.handles = []
        self.fd = None
        self.closed = True


def observe_profile_canary(profile, expected_data=None, previous_observation=None):
    """Use only the parsed profile's fixed path and reviewed content commitment."""
    p = parse_profile(json.loads(encode_report(profile)))
    observed = _CanaryDataObservation(p.paths.canary_path, p.service.canary_sha256, True, expected_data)
    try:
        if previous_observation is not None:
            compare_canary_observation(observed.readback(), previous_observation)
        return observed
    except BaseException:
        observed.close()
        raise


def compare_canary_observation(current, previous):
    """Compare committed DATA identities; supplied metadata creates no origin."""
    if (type(previous) is not dict or type(current) is not dict
            or current.get('schema') != 'RBRIDGE_CANARY_DATA_OBSERVATION_V1'
            or encode_report(current) != encode_report(previous)):
        _fail('CANARY_DATA_OBSERVATION_CHANGED')


def read_profile_canary(profile, expected_data=None, previous_observation=None):
    observed = observe_profile_canary(profile, expected_data, previous_observation)
    try:
        data = observed.read_bytes()
        report = observed.readback()
        return data, report
    finally:
        observed.close()


def observe_fixture_canary(path, data):
    """Current-user test mechanics. No Root context, profile or origin is issued."""
    return _CanaryDataObservation(path, _expected(data), False, data)
