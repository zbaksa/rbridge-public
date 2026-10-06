#!/usr/bin/python3
"""Standalone stdlib bootstrap predicates and protected create-only publication.

Byte comparison is never execution authority. Production command rendering is
delegated to the concrete qualification bundle after its origin is revalidated.
This file imports no toolkit, runtime-owned module or external dependency while
verifying an artifact or copying its bytes.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys


class BootstrapError(ValueError):pass


def _fail(reason):raise BootstrapError(reason)


def _json(raw):
    if type(raw) is not bytes or not 0<len(raw)<=65536:_fail('BOOTSTRAP_CAPTURE_BYTE_LIMIT')
    def pairs(rows):
        out={}
        for k,v in rows:
            if k in out:_fail('BOOTSTRAP_DUPLICATE_KEY')
            out[k]=v
        return out
    try:return json.loads(raw.decode('utf-8',errors='strict'),object_pairs_hook=pairs,
        parse_constant=lambda _:(_ for _ in ()).throw(BootstrapError('BOOTSTRAP_NUMBER_INVALID')))
    except (UnicodeError,ValueError,RecursionError):_fail('BOOTSTRAP_JSON_INVALID')


def _hash(value,length=64):return type(value) is str and re.fullmatch('[0-9a-f]{'+str(length)+'}',value) is not None


def verify_bootstrap_artifact(payload,manifest,authenticated_capture,binding):
    """Compare complete data; origin belongs to the qualified retrieval driver.

    Even a matching fixture labelled authenticated cannot obtain may_execute.
    The exact expected manifest/binding must come from the reviewed owner bundle.
    """
    fields={'schema','source_sha','tree_sha','payload_bytes','payload_sha256',
        'toolkit_manifest_sha256','python_closure_sha256'}
    if (type(manifest) is not dict or set(manifest)!=fields or manifest['schema']!='RBRIDGE_BOOTSTRAP_MANIFEST_V1'
            or any(not _hash(manifest[k],40) for k in ('source_sha','tree_sha'))
            or any(not _hash(manifest[k]) for k in ('payload_sha256','toolkit_manifest_sha256','python_closure_sha256'))
            or type(manifest['payload_bytes']) is not int or not 1<=manifest['payload_bytes']<=49152
            or type(payload) is not bytes or len(payload)!=manifest['payload_bytes']
            or hashlib.sha256(payload).hexdigest()!=manifest['payload_sha256']):_fail('BOOTSTRAP_PAYLOAD_NOT_PINNED')
    try:payload.decode('utf-8',errors='strict')
    except UnicodeError:_fail('BOOTSTRAP_PAYLOAD_ENCODING_INVALID')
    if (type(binding) is not dict or set(binding)!={'repository','author','issue_number'}
            or type(binding['repository']) is not str or not re.fullmatch('[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}',binding['repository'])
            or type(binding['author']) is not str or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9-]{0,38}',binding['author'])
            or type(binding['issue_number']) is not int or not 1<=binding['issue_number']<=2147483647):_fail('BOOTSTRAP_BINDING_INVALID')
    capture=authenticated_capture
    if (type(capture) is not dict or set(capture)!={'schema','repository','viewer','author','issue_number','is_pull_request','url','body'}
            or capture['schema']!='RBRIDGE_BOOTSTRAP_ARTIFACT_CAPTURE_V1' or capture['repository']!=binding['repository']
            or capture['viewer']!=binding['author'] or capture['author']!=binding['author']
            or type(capture['issue_number']) is not int or capture['issue_number']!=binding['issue_number']
            or capture['is_pull_request'] is not False
            or capture['url']!='https://github.com/'+binding['repository']+'/issues/'+str(binding['issue_number'])
            or type(capture['body']) is not str):_fail('BOOTSTRAP_CAPTURE_IDENTITY_INVALID')
    body=_json(capture['body'].encode('utf-8',errors='strict'))
    if (type(body) is not dict or set(body)!={'schema','manifest','payload_base64'}
            or body['schema']!='RBRIDGE_ROOT_INSTALL_BOOTSTRAP_ARTIFACT_V1' or body['manifest']!=manifest
            or type(body['payload_base64']) is not str):_fail('BOOTSTRAP_ARTIFACT_INVALID')
    try:decoded=base64.b64decode(body['payload_base64'],validate=True)
    except (ValueError,TypeError):_fail('BOOTSTRAP_ARTIFACT_INVALID')
    if decoded!=payload or base64.b64encode(decoded).decode()!=body['payload_base64']:_fail('BOOTSTRAP_ARTIFACT_INVALID')
    return {'schema':'RBRIDGE_BOOTSTRAP_BYTE_PROOF_V1','status':'PASS','scope':'ARTIFACT_BYTES_ONLY',
        'may_execute':False,'payload_sha256':manifest['payload_sha256'],'payload_bytes':len(payload),
        'manifest_sha256':hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
        'capture_sha256':hashlib.sha256(json.dumps(capture,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()}


def source_exit_wrapper(argv):
    """Shell-status fixture and common wrapper shape, never an authority token."""
    if type(argv) not in (list,tuple) or not argv or any(type(a) is not str or '\0' in a or '\n' in a for a in argv):
        _fail('BOOTSTRAP_ARGV_INVALID')
    # The final subshell returns the child code without terminating the parent.
    # A caller's errexit/nounset settings must not destroy the interactive shell.
    return ('set +e\nset +u\nset +E\nset +o pipefail\n'+shlex.join(argv)+
        '\nrbridge_bootstrap_outer_exit=$?\nprintf "RBRIDGE_OUTER_EXIT=%s\\n" "$rbridge_bootstrap_outer_exit"\n'+
        '(exit "$rbridge_bootstrap_outer_exit")\n')


def render_owner_command(bundle):
    """Only the concrete private qualification module may supply command pins."""
    try:
        from rbridge_installation.qualification import qualified_owner_command
        command=qualified_owner_command(bundle)
    except (ImportError,AttributeError,ValueError,TypeError):_fail('BOOTSTRAP_QUALIFICATION_BLOCKED')
    return command


def _identity(s):
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)


def _publish(parent,payload,manifest,capture,binding,production):
    proof=verify_bootstrap_artifact(payload,manifest,capture,binding)
    path=Path(parent)
    if not path.is_absolute() or any(p in ('','..','.') for p in str(path).split('/')[1:]):_fail('BOOTSTRAP_PARENT_INVALID')
    owner=os.getuid();handles=[];links=[];payload_fd=None;stage_fd=None
    if production:
        if owner!=0 or os.geteuid()!=0 or not sys.flags.isolated:_fail('BOOTSTRAP_ROOT_ISOLATION_REQUIRED')
        if str(path)!='/var/lib/rbridge-maintenance':_fail('BOOTSTRAP_PARENT_UNQUALIFIED')
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
    def stable(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid)
    try:
        fd=os.open('/',flags);handles.append(fd)
        for i,part in enumerate(path.parts[1:]):
            before=os.stat(part,dir_fd=fd,follow_symlinks=False)
            expected=0 if production else owner
            # Source temporary ancestors can have the system sticky mode; the
            # named final fixture parent must still be exclusively private.
            final=i==len(path.parts)-2
            if (not stat.S_ISDIR(before.st_mode) or production and (before.st_uid!=expected or before.st_mode&0o6022)
                    or final and (before.st_uid!=owner or before.st_mode&0o7777!=0o700)):_fail('BOOTSTRAP_PARENT_UNQUALIFIED')
            child=os.open(part,flags,dir_fd=fd);handles.append(child)
            if stable(before)!=stable(os.fstat(child)):_fail('BOOTSTRAP_PARENT_CHANGED')
            links.append((fd,part,child,before));fd=child
        def check():
            for ancestor,name,child,before in links:
                if stable(before)!=stable(os.fstat(child)) or stable(before)!=stable(os.stat(name,dir_fd=ancestor,follow_symlinks=False)):
                    _fail('BOOTSTRAP_PARENT_CHANGED')
        check();name='bootstrap-'+manifest['payload_sha256'];os.mkdir(name,0o700,dir_fd=fd);os.fsync(fd)
        stage_fd=os.open(name,flags,dir_fd=fd);stage=os.fstat(stage_fd)
        if stage.st_uid!=owner or stage.st_mode&0o7777!=0o700:_fail('BOOTSTRAP_STAGE_UNQUALIFIED')
        payload_fd=os.open('payload.py',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=stage_fd)
        data=memoryview(payload)
        while data:
            count=os.write(payload_fd,data)
            if count<=0:_fail('BOOTSTRAP_WRITE_UNCERTAIN')
            data=data[count:]
        os.fchmod(payload_fd,0o400);os.fsync(payload_fd);before=os.fstat(payload_fd)
        os.fsync(stage_fd);check()
        os.lseek(payload_fd,0,os.SEEK_SET);readback=bytearray()
        while len(readback)<=len(payload):
            part=os.read(payload_fd,len(payload)+1-len(readback))
            if not part:break
            readback.extend(part)
        if (readback!=payload or before.st_uid!=owner or before.st_nlink!=1 or before.st_mode&0o7777!=0o400
                or _identity(before)!=_identity(os.fstat(payload_fd))
                or _identity(before)!=_identity(os.stat('payload.py',dir_fd=stage_fd,follow_symlinks=False))
                or stable(stage)!=stable(os.stat(name,dir_fd=fd,follow_symlinks=False))
                or os.listdir(stage_fd)!=['payload.py']):_fail('BOOTSTRAP_READBACK_UNCERTAIN')
        check()
        return {**proof,'path':str(path/name/'payload.py'),
            'scope':'ROOT_PROTECTED_BYTES_ONLY' if production else 'FIXTURE_AUTHORITY_ONLY','may_execute':False,
            'identity':list(map(str,_identity(before)))}
    except OSError:_fail('BOOTSTRAP_PUBLICATION_UNCERTAIN')
    finally:
        if payload_fd is not None:os.close(payload_fd)
        if stage_fd is not None:os.close(stage_fd)
        for handle in reversed(handles):os.close(handle)


def publish_bootstrap_artifact(parent,payload,manifest,capture,binding):
    return _publish(parent,payload,manifest,capture,binding,True)


def _publish_fixture_bootstrap(parent,payload,manifest,capture,binding):
    return _publish(parent,payload,manifest,capture,binding,False)


def main():
    # An unqualified standalone invocation cannot execute a payload or a service
    # action. Actual retrieval/closure qualification precedes command rendering.
    print(json.dumps({'schema':'RBRIDGE_BOOTSTRAP_ENTRY_V1','status':'BLOCKED',
        'scope':'UNQUALIFIED','may_execute':False,'reason_codes':['BOOTSTRAP_QUALIFICATION_REQUIRED']},sort_keys=True))
    return 2


if __name__=='__main__':raise SystemExit(main())
