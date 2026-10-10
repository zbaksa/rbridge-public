"""Read-only physical toolkit byte comparison, never an authorization.

The expected source/tree/manifest digests are caller-supplied DATA. A Root
filesystem inventory matching those values does NOT prove the caller trusted
the pins, identify the human owner, settle a journal, or admit a helper.

This module is review-only. It must not be installed or used from a service
until its privileged execution contract receives separate approval.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from .artifact import ArtifactEntry,ArtifactManifest,validate_manifest
from .models import InstallationError,encode_report
from .protected_copy import (
    FILE_FLAGS,FilesystemAuthority,ProtectedParent,verify_published)

class OrphanPublishedSourceError(InstallationError):pass
def _fail(reason):raise OrphanPublishedSourceError(reason)

_RELEASE_PARENT=Path('/usr/local/libexec/rbridge/releases')
_MAX_MANIFEST_BYTES=2097152
_MANIFEST_KEYS={'schema','kind','source_sha','tree_sha','node_sha256',
                'uid_policy','entries','sha256'}
_ENTRY_KEYS={'path','kind','size','mode','sha256','target'}

def _is_sha(text,length):
    return (type(text) is str and
            re.fullmatch('[0-9a-f]{'+str(length)+'}',text) is not None)

def parse_exact_toolkit_manifest(raw,source_sha,tree_sha,manifest_file_sha256):
    """Validate exact canonical bytes against external DATA pins only."""
    if (type(raw) is not bytes or not 1<=len(raw)<=_MAX_MANIFEST_BYTES
            or not _is_sha(source_sha,40) or not _is_sha(tree_sha,40)
            or not _is_sha(manifest_file_sha256,64)):
        _fail('ORPHAN_SOURCE_MANIFEST_PIN_INVALID')
    if hashlib.sha256(raw).hexdigest()!=manifest_file_sha256:
        _fail('ORPHAN_SOURCE_MANIFEST_FILE_SHA_CHANGED')
    def unique(pairs):
        value={}
        for key,item in pairs:
            if key in value:_fail('ORPHAN_SOURCE_MANIFEST_DUPLICATE_KEY')
            value[key]=item
        return value
    def invalid_constant(_):
        _fail('ORPHAN_SOURCE_MANIFEST_INVALID_JSON')
    try:
        data=json.loads(raw.decode('utf-8'),object_pairs_hook=unique,
                        parse_constant=invalid_constant)
        if (type(data) is not dict or set(data)!=_MANIFEST_KEYS
                or data['schema']!='RBRIDGE_INSTALL_TOOLKIT_V1'
                or data['kind']!='TOOLKIT'
                or data['source_sha']!=source_sha
                or data['tree_sha']!=tree_sha
                or type(data['entries']) is not list
                or not 1<=len(data['entries'])<=100000):
            _fail('ORPHAN_SOURCE_MANIFEST_UNQUALIFIED')
        entries=[]
        for entry in data['entries']:
            if type(entry) is not dict or set(entry)!=_ENTRY_KEYS:
                _fail('ORPHAN_SOURCE_MANIFEST_ENTRY_INVALID')
            entries.append(ArtifactEntry(**entry))
        manifest=ArtifactManifest(
            schema=data['schema'],kind=data['kind'],
            source_sha=data['source_sha'],tree_sha=data['tree_sha'],
            node_sha256=data['node_sha256'],
            uid_policy=data['uid_policy'],entries=tuple(entries),
            sha256=data['sha256'])
        validate_manifest(manifest)
        if encode_report(manifest)!=raw:
            _fail('ORPHAN_SOURCE_MANIFEST_NONCANONICAL')
        return manifest
    except (ValueError,TypeError,KeyError,AttributeError,UnicodeError,
            RecursionError):
        _fail('ORPHAN_SOURCE_MANIFEST_UNQUALIFIED')

def describe_exact_manifest_data(manifest,raw):
    """Record matching source bytes without claiming trusted Root provenance."""
    if type(manifest) is not ArtifactManifest or type(raw) is not bytes:
        _fail('ORPHAN_SOURCE_MANIFEST_UNQUALIFIED')
    return {'schema':'RBRIDGE_ORPHAN_SOURCE_MANIFEST_DATA_V1',
            'status':'MANIFEST_DATA_MATCH_ONLY',
            'source_sha':manifest.source_sha,
            'tree_sha':manifest.tree_sha,
            'manifest_file_sha256':hashlib.sha256(raw).hexdigest(),
            'manifest_logical_sha256':manifest.sha256,
            'source_provenance_verified':False,
            'owner_authenticated':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,
            'may_change_production':False}

def inspect_published_toolkit_readonly(source_sha,tree_sha,
                                       manifest_file_sha256):
    """Potential future Root read-only physical check; no helper subprocess.

    Call only from the exact immutable published toolkit being checked.
    This has not been Root qualified, published or invoked on production.
    Even a physically successful check does not authenticate supplied pins.
    """
    if (os.getuid(),os.geteuid(),os.getgid(),os.getegid())!=(0,0,0,0):
        _fail('ORPHAN_SOURCE_ROOT_REQUIRED')
    if (not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'
            or os.uname().nodename.split('.')[0]!='aether-engine'):
        _fail('ORPHAN_SOURCE_CONTEXT_UNQUALIFIED')
    if (not _is_sha(source_sha,40) or not _is_sha(tree_sha,40)
            or not _is_sha(manifest_file_sha256,64)):
        _fail('ORPHAN_SOURCE_MANIFEST_PIN_INVALID')
    from .host_backend import _assert_kernel_namespace
    _assert_kernel_namespace()
    release=_RELEASE_PARENT/('toolkit-'+source_sha)
    module_root=Path(__file__).absolute().parents[3]
    if module_root!=release:
        _fail('ORPHAN_SOURCE_RUNNING_RELEASE_MISMATCH')
    authority=FilesystemAuthority(0,1027,_RELEASE_PARENT,'TOOLKIT',
        production=True,source_sha=source_sha,tree_sha=tree_sha)
    guard=None;fd=None
    try:
        guard=ProtectedParent(authority)
        leaf=release.name+'.manifest.json'
        fd=os.open(leaf,FILE_FLAGS,dir_fd=guard.fd)
        before=os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode)
                or before.st_uid!=0 or before.st_gid!=0 or before.st_nlink!=1
                or stat.S_IMODE(before.st_mode) not in (0o400,0o600)
                or not 1<=before.st_size<=_MAX_MANIFEST_BYTES):
            _fail('ORPHAN_SOURCE_SIDECAR_METADATA_INVALID')
        raw=bytearray()
        while len(raw)<=_MAX_MANIFEST_BYTES:
            chunk=os.read(fd,min(65536,_MAX_MANIFEST_BYTES+1-len(raw)))
            if not chunk:break
            raw.extend(chunk)
        after=os.fstat(fd)
        named=os.stat(leaf,dir_fd=guard.fd,follow_symlinks=False)
        def ident(s):
            return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,
                    s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        if (len(raw)!=before.st_size or ident(after)!=ident(before)
                or ident(named)!=ident(before)):
            _fail('ORPHAN_SOURCE_SIDECAR_CHANGED')
        manifest=parse_exact_toolkit_manifest(
            bytes(raw),source_sha,tree_sha,manifest_file_sha256)
        approved=FilesystemAuthority(
            0,1027,_RELEASE_PARENT,'TOOLKIT',production=True,
            manifest_sha256=manifest.sha256,
            source_sha=source_sha,tree_sha=tree_sha)
        proof=verify_published(release,manifest,approved)
        if (proof.status!='PASS' or proof.observed_sha256!=manifest.sha256
                or ident(os.fstat(fd))!=ident(before)
                or ident(os.stat(leaf,dir_fd=guard.fd,follow_symlinks=False))
                !=ident(before)):
            _fail('ORPHAN_SOURCE_PUBLISHED_BYTES_UNQUALIFIED')
        guard.check()
        return {
            'schema':'RBRIDGE_ORPHAN_PUBLISHED_ROOT_BYTES_V1',
            'status':'PHYSICAL_ROOT_TOOLKIT_BYTES_MATCH_UNTRUSTED_PINS',
            'source_sha':source_sha,'tree_sha':tree_sha,
            'manifest_file_sha256':manifest_file_sha256,
            'manifest_logical_sha256':manifest.sha256,
            'source_provenance_verified':False,
            'owner_authenticated':False,'may_settle':False,
            'may_launch':False,'may_resume_qualification':False,
            'may_change_production':False}
    except (OSError,ValueError,TypeError,UnicodeError):
        _fail('ORPHAN_SOURCE_PHYSICAL_PROOF_UNQUALIFIED')
    finally:
        if fd is not None:os.close(fd)
        if guard is not None:guard.close()
