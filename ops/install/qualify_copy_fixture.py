"""Root-only bounded copy fixture. Does not build, execute, or install runtime."""
from pathlib import Path
from types import SimpleNamespace
import json
import errno
import os
import shutil
import sys
import tempfile

sys.path.insert(0,str(Path(__file__).resolve().parent))
from rbridge_installation.artifact import inventory_entries,_manifest
from rbridge_installation.protected_copy import FilesystemAuthority,publish_artifact,verify_published,CopyError

def main():
    if os.getuid()!=0 or os.geteuid()!=0:raise SystemExit('COPY_FIXTURE_ROOT_REQUIRED')
    os.umask(0o077)
    root=Path(tempfile.mkdtemp(prefix='rbridge-copy-fixture.',dir='/root'))
    try:
        stage=root/'stage';parent=root/'protected';stage.mkdir();parent.mkdir()
        (stage/'file.txt').write_bytes(b'fixture bytes; never executed\n')
        try:os.chown(stage,1027,1027);os.chown(stage/'file.txt',1027,1027)
        except OSError as error:
            if error.errno not in (errno.EINVAL,errno.EPERM):raise
            print(json.dumps({'schema':'RBRIDGE_ROOT_COPY_FIXTURE_V1','scope':'LOCAL_PROTECTED_COPY_ONLY_SYNTHETIC_BYTES','status':'UNKNOWN','reason':'RUNTIME_UID_GID_UNAVAILABLE','uid':os.getuid(),'euid':os.geteuid(),'runtimeBoot':'NOT_PERFORMED','productionChanged':False},sort_keys=True))
            return 2
        entries=inventory_entries(stage,SimpleNamespace(artifact_depth=8,artifact_entries=16,artifact_bytes=4096,scan_ms=10000))
        # Deliberately synthetic provenance; this is no runtime artifact proof.
        manifest=_manifest('RUNTIME','a'*40,'b'*40,'c'*64,entries)
        authority=FilesystemAuthority(0,1027,parent,'RUNTIME',manifest_sha256=manifest.sha256,source_sha=manifest.source_sha,tree_sha=manifest.tree_sha)
        flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
        source=os.open(stage,flags);destination=os.open(parent,flags)
        try:
            published=publish_artifact(source,destination,manifest,authority)
            proof=verify_published(published.path,manifest,authority)
            try:publish_artifact(source,destination,manifest,authority)
            except CopyError:collision='REJECTED'
            else:raise RuntimeError('COPY_FIXTURE_COLLISION_ACCEPTED')
        finally:os.close(source);os.close(destination)
        print(json.dumps({'schema':'RBRIDGE_ROOT_COPY_FIXTURE_V1','scope':'LOCAL_PROTECTED_COPY_ONLY_SYNTHETIC_BYTES','status':proof.status,'uid':os.getuid(),'euid':os.geteuid(),'sourceUid':1027,'publishedUid':published.path.stat().st_uid,'publishedMode':oct(published.path.stat().st_mode&0o777),'manifestSHA256':manifest.sha256,'existingDestination':collision,'runtimeBoot':'NOT_PERFORMED','productionChanged':False},sort_keys=True))
    finally:shutil.rmtree(root)

if __name__=='__main__':raise SystemExit(main())
