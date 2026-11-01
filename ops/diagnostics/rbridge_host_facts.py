"""Read-only host observations; never an admission, installation, or GO proof."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import PurePosixPath
import re
import socket
import stat
import subprocess
import sys

SCHEMA = 'RBRIDGE_HOST_FACTS_RO_V1'
HOLD_PATH = '/etc/rbridge/owner-app-run-hold-v1.json'
SELECTED_KEYS = {'RBRIDGE_RELEASE_SHA', 'COCWIN_REMOTE_BRIDGE_RELEASE_SHA', 'RBRIDGE_OWNER_HOLD_SHA256'}
HASH = re.compile(r'[0-9a-f]{64}\Z')
UNIT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.@:-]{0,99}\.(?:service|path)\Z')


class Blocked(RuntimeError):
    pass


def need(condition, reason):
    if not condition:
        raise Blocked(reason)


def check_context(host, uid, gid, isolated, no_site, no_bytecode):
    need(socket.gethostname() == host, 'WRONG_HOST')
    need(uid == 0 and gid == 0, 'ROOT_READER_REQUIRED')
    need(isolated and no_site and no_bytecode, 'ISOLATED_INTERPRETER_REQUIRED')


def parse_component(value):
    parts = value.split('=')
    need(len(parts) == 3, 'COMPONENT_ARGUMENT_INVALID')
    name, path, digest = parts
    need(name != 'hold' and re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', name) is not None, 'COMPONENT_NAME_INVALID')
    need(path.startswith('/usr/local/libexec/') and path.endswith('.py') and len(path) <= 1024
         and str(PurePosixPath(path)) == path and '..' not in PurePosixPath(path).parts
         and not re.search(r'\s|\x00', path), 'COMPONENT_PATH_INVALID')
    need(HASH.fullmatch(digest) is not None, 'COMPONENT_SHA_INVALID')
    return name, path, digest


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_uid, info.st_gid, info.st_mode, info.st_nlink)


def read_regular(path, limit, dir_fd=None):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd)
    except OSError:
        raise Blocked('FILE_OPEN_UNAVAILABLE') from None
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and 0 < before.st_size <= limit, 'FILE_UNTRUSTED')
        raw = os.read(fd, limit + 1)
        after = os.fstat(fd)
        need(len(raw) == before.st_size and stamp(before) == stamp(after), 'FILE_CHANGED')
        current = os.stat(path, dir_fd=dir_fd, follow_symlinks=False)
        need(stamp(current) == stamp(after), 'FILE_PATH_CHANGED')
        return raw, {'uid': before.st_uid, 'gid': before.st_gid,
                     'mode': format(stat.S_IMODE(before.st_mode), '04o'), 'bytes': len(raw),
                     'dev': str(before.st_dev), 'ino': str(before.st_ino),
                     'mtimeNs': str(before.st_mtime_ns), 'ctimeNs': str(before.st_ctime_ns),
                     'sha256': hashlib.sha256(raw).hexdigest()}
    except OSError:
        raise Blocked('FILE_READ_UNAVAILABLE') from None
    finally:
        os.close(fd)


def trusted_file(path, limit, expected_sha):
    parts = PurePosixPath(path).parts
    need(parts[0] == '/' and str(PurePosixPath(path)) == path and '..' not in parts,
         'FILE_PATH_INVALID')
    held, links = [], []
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        parent = os.open('/', flags)
        held.append(parent)
        root_stamp = stamp(os.fstat(parent))
        for name in parts[1:-1]:
            info = os.fstat(parent)
            need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                 'PARENT_UNTRUSTED')
            child = os.open(name, flags, dir_fd=parent)
            held.append(child)
            links.append((parent, name, child, stamp(os.fstat(child))))
            parent = child
        info = os.fstat(parent)
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
             'PARENT_UNTRUSTED')
        _, metadata = read_regular(parts[-1], limit, dir_fd=parent)
        need(metadata['uid'] == 0 and not int(metadata['mode'], 8) & 0o022, 'FILE_OWNER_MODE_UNTRUSTED')
        need(stamp(os.fstat(held[0])) == root_stamp
             and stamp(os.stat('/', follow_symlinks=False)) == root_stamp, 'PARENT_CHANGED')
        for ancestor, name, child, identity in links:
            need(stamp(os.fstat(child)) == identity
                 and stamp(os.stat(name, dir_fd=ancestor, follow_symlinks=False)) == identity,
                 'PARENT_CHANGED')
        return {**metadata, 'expectedShaMatches': metadata['sha256'] == expected_sha}
    except OSError:
        raise Blocked('FILE_PATH_UNAVAILABLE') from None
    finally:
        for fd in reversed(held):
            os.close(fd)


def selected_environment(raw):
    need(len(raw) <= 65536, 'ENVIRONMENT_TOO_LARGE')
    selected = {}
    for item in raw.split(b'\x00'):
        key, separator, value = item.partition(b'=')
        if separator and key.decode('ascii', 'ignore') in SELECTED_KEYS:
            name = key.decode('ascii', 'strict')
            need(name not in selected, 'DUPLICATED_ENV_KEY')
            selected[name] = value.decode('ascii', 'strict')
    return selected


def unit_info(name):
    need(UNIT.fullmatch(name) is not None, 'UNIT_NAME_INVALID')
    result = subprocess.run(['/usr/bin/systemctl', 'show', '--no-pager',
                             '-p', 'MainPID', '-p', 'ActiveState', '-p', 'SubState',
                             '-p', 'UnitFileState', '-p', 'InvocationID', '--', name],
                            capture_output=True, text=True, timeout=5, check=False,
                            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    need(result.returncode == 0 and len(result.stdout) <= 8192, 'SYSTEMD_OBSERVATION_UNAVAILABLE')
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


def process_identity(pid, uid):
    info = os.stat('/proc/' + str(pid))
    need(info.st_uid == uid, 'BRIDGE_PROCESS_UID_CHANGED')
    with open('/proc/' + str(pid) + '/stat', encoding='ascii') as stream:
        value = stream.read(8192)
    return value[value.rfind(')') + 2:].split()[19]


def bridge_info(before, uid, expected_hold):
    need(before.get('ActiveState') == 'active', 'BRIDGE_NOT_ACTIVE')
    pid = int(before.get('MainPID', '0'))
    need(pid > 1, 'BRIDGE_PID_UNAVAILABLE')
    identity = process_identity(pid, uid)
    fd = os.open('/proc/' + str(pid) + '/environ', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        values = selected_environment(os.read(fd, 65537))
    finally:
        os.close(fd)
    pin = values.get('RBRIDGE_OWNER_HOLD_SHA256')
    release = values.get('RBRIDGE_RELEASE_SHA', values.get('COCWIN_REMOTE_BRIDGE_RELEASE_SHA', ''))
    observation = {'pid': pid, 'startTick': identity, 'runtimeUid': uid,
                   'holdPinPresent': bool(pin), 'holdPinMatches': pin == expected_hold,
                   'releaseSha': release if re.fullmatch(r'[0-9a-f]{40}', release) else None}
    return observation


def collect(args):
    need(args.runtime_uid > 0, 'RUNTIME_UID_INVALID')
    need(HASH.fullmatch(args.hold_sha) is not None, 'HOLD_SHA_INVALID')
    need(len(args.component) <= 4 and len(args.unit) <= 4, 'OBSERVATION_BUDGET_EXCEEDED')
    components = [parse_component(value) for value in args.component]
    need(len({name for name, _, _ in components}) == len(components), 'DUPLICATE_COMPONENT')
    for unit in args.unit:
        need(UNIT.fullmatch(unit) is not None, 'UNIT_NAME_INVALID')
    before = unit_info('rbridge.service')
    bridge = bridge_info(before, args.runtime_uid, args.hold_sha)
    files, errors = {}, {}
    targets = [('hold', HOLD_PATH, args.hold_sha)] + components
    for name, path, digest in targets:
        try:
            files[name] = trusted_file(path, 1_048_576, digest)
        except Blocked as error:
            errors[name] = str(error)
    units = {unit: unit_info(unit) for unit in args.unit}
    after = unit_info('rbridge.service')
    need(before == after and bridge['startTick'] == process_identity(bridge['pid'], args.runtime_uid),
         'BRIDGE_CHANGED_DURING_OBSERVATION')
    return {'schema': SCHEMA, 'status': 'OBSERVED_ONLY' if not errors else 'PARTIAL',
            'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'bridge': bridge,
            'bridgeUnit': after, 'componentFiles': files, 'units': units, 'errors': errors,
            'loadedComponentPolicy': 'UNKNOWN', 'nativeControllerFence': 'UNKNOWN',
            'originalWriterDisposition': 'UNKNOWN', 'productionGo': 'UNKNOWN',
            'secretValuesPrinted': False, 'protectedStateWrites': 0, 'serviceActions': 0}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--runtime-uid', required=True, type=int)
    parser.add_argument('--hold-sha', required=True)
    parser.add_argument('--component', action='append', default=[])
    parser.add_argument('--unit', action='append', default=[])
    args = parser.parse_args(argv)
    try:
        check_context(args.host, os.geteuid(), os.getegid(), sys.flags.isolated,
                      sys.flags.no_site, sys.dont_write_bytecode)
        result = collect(args)
    except (Blocked, OSError, ValueError, IndexError, UnicodeError, subprocess.TimeoutExpired) as error:
        result = {'schema': SCHEMA, 'status': 'BLOCKED',
                  'reason': str(error) if isinstance(error, Blocked) else type(error).__name__,
                  'productionGo': 'UNKNOWN', 'secretValuesPrinted': False,
                  'protectedStateWrites': 0, 'serviceActions': 0}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'OBSERVED_ONLY' else 1


if __name__ == '__main__':
    raise SystemExit(main())
