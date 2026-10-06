"""Bounded, descriptor-based final material inventory; never builds as root."""
from dataclasses import dataclass, asdict
from pathlib import Path
import hashlib
import json
import os
import posixpath
import re
import stat
import time
from .models import ArtifactError, report_sha256, encode_report, validate_contract

@dataclass(frozen=True)
class ArtifactEntry:
    path: str
    kind: str
    size: int
    mode: int
    sha256: str
    target: str

@dataclass(frozen=True)
class ArtifactManifest:
    schema: str
    kind: str
    source_sha: str
    tree_sha: str
    node_sha256: str
    uid_policy: str
    entries: tuple
    sha256: str

@dataclass(frozen=True)
class ArtifactProof:
    manifest_sha256: str
    observed_sha256: str
    source_sha: str
    node_sha256: str
    status: str
    scope: str = 'BYTES_INVENTORY_ONLY'

def _identity(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

def _confined(path, target):
    if not target or target.startswith('/') or '\x00' in target or '\n' in target:
        raise ArtifactError('ARTIFACT_LINK_INVALID')
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
    if resolved in ('', '.', '..') or resolved.startswith('../'):
        raise ArtifactError('ARTIFACT_LINK_ESCAPE')
    return resolved

def _relative(path):
    if not isinstance(path,str) or not path or len(path)>4096 or any(c in path for c in '\x00\r\n') or any(p in ('','.','..') for p in path.split('/')):
        raise ArtifactError('ARTIFACT_PATH_INVALID')
    path.encode('utf-8',errors='strict')
    return path.split('/')

def open_artifact_root(root):
    text=os.fspath(root)
    if not text.startswith('/') or text=='/': raise ArtifactError('ARTIFACT_PATH_INVALID')
    parts=_relative(text[1:])
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
    fd=os.open('/',flags)
    try:
        for part in parts:
            before=os.stat(part,dir_fd=fd,follow_symlinks=False)
            child=os.open(part,flags,dir_fd=fd)
            if _identity(before)!=_identity(os.fstat(child)):
                os.close(child)
                raise ArtifactError('ARTIFACT_CHANGED')
            os.close(fd)
            fd=child
        return fd
    except BaseException:
        os.close(fd)
        raise

def validate_manifest(manifest):
    try: validate_contract(json.loads(encode_report(manifest)), 'ArtifactManifest')
    except (ValueError,UnicodeError,TypeError): raise ArtifactError('ARTIFACT_MANIFEST_INVALID') from None
    expected=_manifest(manifest.kind,manifest.source_sha,manifest.tree_sha,manifest.node_sha256,manifest.entries)
    if expected!=manifest: raise ArtifactError('ARTIFACT_MANIFEST_INVALID')
    paths={}
    size=0
    for e in manifest.entries:
        parts=_relative(e.path)
        if e.path in paths or (paths and e.path.encode()<=next(reversed(paths)).encode()): raise ArtifactError('ARTIFACT_MANIFEST_INVALID')
        if len(parts)>129 or any('/'.join(parts[:i]) not in paths or paths['/'.join(parts[:i])].kind!='DIRECTORY' for i in range(1,len(parts))): raise ArtifactError('ARTIFACT_MANIFEST_INVALID')
        if e.kind=='FILE':
            if e.mode not in (0o644,0o755) or e.target or not re.fullmatch('[0-9a-f]{64}',e.sha256): raise ArtifactError('ARTIFACT_MANIFEST_INVALID')
            size+=e.size
        elif e.kind=='DIRECTORY':
            if e.mode!=0o755 or e.size or e.sha256 or e.target: raise ArtifactError('ARTIFACT_MANIFEST_INVALID')
        elif e.mode!=0o777 or e.sha256 or e.size!=len(e.target.encode()): raise ArtifactError('ARTIFACT_MANIFEST_INVALID')
        paths[e.path]=e
    if size>1073741824: raise ArtifactError('ARTIFACT_BYTE_LIMIT')
    for e in manifest.entries:
        if e.kind=='SYMLINK':
            components=e.path.split('/')[:-1]+e.target.split('/')
            resolved=[]
            hops=0
            while components:
                part=components.pop(0)
                if part in ('','.'): continue
                if part=='..':
                    if not resolved: raise ArtifactError('ARTIFACT_LINK_ESCAPE')
                    resolved.pop()
                    continue
                resolved.append(part)
                target=paths.get('/'.join(resolved))
                if target is None: raise ArtifactError('ARTIFACT_DANGLING_LINK')
                if target.kind=='SYMLINK':
                    hops+=1
                    if hops>40 or target.target.startswith('/'): raise ArtifactError('ARTIFACT_LINK_INVALID')
                    resolved.pop()
                    components=target.target.split('/')+components
                elif components and target.kind!='DIRECTORY': raise ArtifactError('ARTIFACT_LINK_INVALID')
            if not resolved: raise ArtifactError('ARTIFACT_LINK_INVALID')

def inventory_entries(root: Path, budget):
    entries = []
    total = 0
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    deadline=time.monotonic()+getattr(budget,'scan_ms',600000)/1000
    def timely():
        if time.monotonic()>=deadline: raise ArtifactError('ARTIFACT_SCAN_DEADLINE')
    try:
        root_stat = root.lstat()
        root_fd = open_artifact_root(root)
        try:
            if _identity(root_stat) != _identity(os.fstat(root_fd)): raise ArtifactError('ARTIFACT_ROOT_CHANGED')
            def walk(parent_fd, prefix='', depth=0):
                nonlocal total
                if depth > budget.artifact_depth: raise ArtifactError('ARTIFACT_DEPTH_LIMIT')
                before = os.fstat(parent_fd)
                timely()
                names = sorted(os.listdir(parent_fd),key=lambda n:n.encode('utf-8',errors='strict'))
                for name in names:
                    timely()
                    path = prefix + name
                    _relative(path)
                    path.encode('utf-8', errors='strict')
                    if len(entries) >= budget.artifact_entries: raise ArtifactError('ARTIFACT_ENTRY_LIMIT')
                    s = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                    if not stat.S_ISLNK(s.st_mode) and s.st_mode & 0o6022: raise ArtifactError('ARTIFACT_MODE_INVALID')
                    if not stat.S_ISDIR(s.st_mode) and s.st_nlink != 1: raise ArtifactError('ARTIFACT_HARDLINK')
                    if stat.S_ISDIR(s.st_mode):
                        child = os.open(name, flags, dir_fd=parent_fd)
                        try:
                            if _identity(s) != _identity(os.fstat(child)): raise ArtifactError('ARTIFACT_CHANGED')
                            entries.append(ArtifactEntry(path, 'DIRECTORY', 0, 0o755, '', ''))
                            walk(child, path+'/', depth+1)
                            if _identity(s) != _identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)): raise ArtifactError('ARTIFACT_CHANGED')
                        finally: os.close(child)
                    elif stat.S_ISREG(s.st_mode):
                        if s.st_size > budget.artifact_bytes - total: raise ArtifactError('ARTIFACT_BYTE_LIMIT')
                        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent_fd)
                        try:
                            if _identity(s) != _identity(os.fstat(fd)): raise ArtifactError('ARTIFACT_CHANGED')
                            digest = hashlib.sha256()
                            count = 0
                            while True:
                                timely()
                                chunk = os.read(fd, 1048576)
                                if not chunk: break
                                count += len(chunk)
                                if count > s.st_size: raise ArtifactError('ARTIFACT_CHANGED')
                                digest.update(chunk)
                            if count != s.st_size or _identity(s) != _identity(os.fstat(fd)): raise ArtifactError('ARTIFACT_CHANGED')
                            total += count
                            entries.append(ArtifactEntry(path, 'FILE', count, 0o755 if s.st_mode & 0o111 else 0o644, digest.hexdigest(), ''))
                        finally: os.close(fd)
                        if _identity(s) != _identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)): raise ArtifactError('ARTIFACT_CHANGED')
                    elif stat.S_ISLNK(s.st_mode):
                        target = os.readlink(name, dir_fd=parent_fd)
                        _confined(path, target)
                        if _identity(s) != _identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)): raise ArtifactError('ARTIFACT_CHANGED')
                        entries.append(ArtifactEntry(path, 'SYMLINK', len(target.encode()), 0o777, '', target))
                    else: raise ArtifactError('ARTIFACT_SPECIAL_OBJECT')
                if names != sorted(os.listdir(parent_fd),key=lambda n:n.encode()) or _identity(before) != _identity(os.fstat(parent_fd)): raise ArtifactError('ARTIFACT_CHANGED')
            walk(root_fd)
            if _identity(root_stat) != _identity(os.fstat(root_fd)) or _identity(root_stat) != _identity(root.lstat()): raise ArtifactError('ARTIFACT_ROOT_CHANGED')
        finally: os.close(root_fd)
        ordered = tuple(sorted(entries, key=lambda e: e.path.encode()))
        paths = {e.path for e in ordered}
        for e in ordered:
            if e.kind == 'SYMLINK' and _confined(e.path, e.target) not in paths: raise ArtifactError('ARTIFACT_DANGLING_LINK')
        return ordered
    except (OSError, UnicodeError):
        raise ArtifactError('ARTIFACT_READ_UNAVAILABLE') from None

def read_manifest_file(root: Path, entry: ArtifactEntry, limit=2097152):
    _relative(entry.path)
    if entry.kind != 'FILE' or entry.size > limit: raise ArtifactError('ARTIFACT_METADATA_LIMIT')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try: fd = open_artifact_root(root)
    except OSError: raise ArtifactError('ARTIFACT_READ_UNAVAILABLE') from None
    try:
        parts = entry.path.split('/')
        for part in parts[:-1]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(file_fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != entry.size: raise ArtifactError('ARTIFACT_CHANGED')
            raw = bytearray()
            while len(raw) <= limit:
                chunk = os.read(file_fd, min(1048576, limit+1-len(raw)))
                if not chunk: break
                raw.extend(chunk)
            if len(raw) != entry.size or _identity(before) != _identity(os.fstat(file_fd)) or hashlib.sha256(raw).hexdigest() != entry.sha256: raise ArtifactError('ARTIFACT_CHANGED')
            return bytes(raw)
        finally: os.close(file_fd)
    except OSError: raise ArtifactError('ARTIFACT_READ_UNAVAILABLE') from None
    finally: os.close(fd)

def _manifest(kind, source, tree, node, entries):
    base = {'schema': 'RBRIDGE_INSTALL_ARTIFACT_V1' if kind == 'RUNTIME' else 'RBRIDGE_INSTALL_TOOLKIT_V1',
            'kind': kind, 'source_sha': source, 'tree_sha': tree, 'node_sha256': node,
            'uid_policy': 'ROOT_IMMUTABLE_RUNTIME_READABLE', 'entries': entries}
    return ArtifactManifest(**base, sha256=report_sha256(base))

def inventory_artifact(root: Path, kind: str, profile) -> ArtifactManifest:
    if kind not in ('RUNTIME', 'TOOLKIT'): raise ArtifactError('ARTIFACT_KIND_INVALID')
    entries = inventory_entries(root, profile.budget)
    paths = {e.path: e for e in entries}
    allowed = {'dist', 'node_modules', 'package.json', 'package-lock.json'}
    if kind == 'TOOLKIT': allowed |= {'ops', 'docs'}
    if any(e.path.split('/')[0] not in allowed for e in entries): raise ArtifactError('ARTIFACT_UNEXPECTED_ROOT')
    required = ['package.json', 'package-lock.json']
    if kind == 'RUNTIME': required += ['dist/server/server/remoteBridgeMain.js', 'dist/server/server/rbridgeMcpMain.js']
    else: required += ['ops/install/rbridge_install.py', 'ops/install/rbridge_bootstrap.py', 'docs/contracts/P2A_INSTALLATION_TOOLKIT_V1.json']
    if any(p not in paths or paths[p].kind != 'FILE' for p in required): raise ArtifactError('ARTIFACT_REQUIRED_FILE_MISSING')
    try:
        package = json.loads(read_manifest_file(root, paths['package.json']))
        dependencies = dict(package['dependencies'])
        if kind == 'TOOLKIT':
            dependencies['@modelcontextprotocol/client'] = package['devDependencies']['@modelcontextprotocol/client']
        if not dependencies: raise ValueError()
        for dependency, version in dependencies.items():
            if not isinstance(dependency, str) or not re.fullmatch(r'(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*', dependency): raise ValueError()
            path = f'node_modules/{dependency}/package.json'
            if path not in paths or paths[path].kind != 'FILE': raise ValueError()
            module = json.loads(read_manifest_file(root, paths[path]))
            if module.get('name') != dependency or module.get('version') != version: raise ValueError()
    except (ValueError, KeyError, TypeError, OSError): raise ArtifactError('ARTIFACT_DEPENDENCY_MISSING') from None
    if kind == 'RUNTIME': return _manifest(kind, profile.runtime.source_sha, profile.runtime.tree_sha, profile.runtime.node_sha256, entries)
    return _manifest(kind, profile.toolkit.source_sha, profile.toolkit.tree_sha, profile.runtime.node_sha256, entries)

def verify_artifact(root: Path, manifest: ArtifactManifest) -> ArtifactProof:
    # Re-inventory every name/byte; this proof does not assert a successful boot.
    class Bounds:
        artifact_depth = 128
        artifact_entries = 100000
        artifact_bytes = 1073741824
    validate_manifest(manifest)
    observed = _manifest(manifest.kind, manifest.source_sha, manifest.tree_sha, manifest.node_sha256, inventory_entries(root, Bounds()))
    if observed != manifest: raise ArtifactError('ARTIFACT_BYTES_MISMATCH')
    return ArtifactProof(manifest.sha256, observed.sha256, manifest.source_sha, manifest.node_sha256, 'PASS')
