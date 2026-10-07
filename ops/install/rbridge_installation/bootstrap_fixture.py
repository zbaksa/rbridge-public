"""Fixed bootstrap copy/readback/collision mechanics; all outputs remain data."""
import base64
import hashlib
import os
from pathlib import Path
import stat
from .artifact import _identity,open_artifact_root
from .bootstrap_collector import decode_bootstrap_body
from .models import InstallationError,encode_report,report_sha256
from .protected_copy import FILE_FLAGS
from .readonly_helper import _json


class BootstrapFixtureError(InstallationError):pass
def _fail(reason):raise BootstrapFixtureError(reason)


def _pins(profile,manifest,binding):
    if (type(binding) is not dict or binding.get('repository')!=profile.binding.repository
            or binding.get('author')!=profile.binding.author):_fail('BOOTSTRAP_FIXTURE_BINDING_CHANGED')
    if (type(manifest) is not dict or manifest.get('source_sha')!=profile.toolkit.source_sha
            or manifest.get('tree_sha')!=profile.toolkit.tree_sha
            or manifest.get('toolkit_manifest_sha256')!=profile.toolkit.manifest_sha256):_fail('BOOTSTRAP_FIXTURE_PINS_CHANGED')


def _read(path,expected):
    parent=open_artifact_root(path.parent);fd=None
    try:
        fd=os.open(path.name,FILE_FLAGS,dir_fd=parent);before=os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or before.st_nlink!=1
                or before.st_mode&0o7777!=0o400 or before.st_size>49152):_fail('BOOTSTRAP_FIXTURE_COPY_UNPROTECTED')
        raw=bytearray()
        while len(raw)<=49152:
            part=os.read(fd,min(65536,49153-len(raw)))
            if not part:break
            raw.extend(part)
        if _identity(before)!=_identity(os.fstat(fd)) or _identity(before)!=_identity(os.stat(path.name,dir_fd=parent,follow_symlinks=False)):
            _fail('BOOTSTRAP_FIXTURE_COPY_CHANGED')
        if bytes(raw)!=expected:_fail('BOOTSTRAP_FIXTURE_BYTES_CHANGED')
        return bytes(raw),before
    finally:
        if fd is not None:os.close(fd)
        os.close(parent)


def _produce(parent,profile,module,payload,manifest,capture,binding,publish,guard=lambda:None):
    _pins(profile,manifest,binding)
    guard();root=Path(parent);before=root.lstat()
    if (not stat.S_ISDIR(before.st_mode) or before.st_uid!=os.getuid() or before.st_mode&0o7777!=0o700
            or any(root.iterdir())):_fail('BOOTSTRAP_FIXTURE_PARENT_UNQUALIFIED')
    proof=module.verify_bootstrap_artifact(payload,manifest,capture,binding);guard()
    publication=publish(root,payload,manifest,capture,binding);path=Path(publication['path'])
    original,metadata=_read(path,payload);guard()
    try:publish(root,payload,manifest,capture,binding)
    except module.BootstrapError as error:collision_reason=str(error)
    else:_fail('BOOTSTRAP_FIXTURE_COLLISION_NOT_REFUSED')
    after,_=_read(path,payload)
    # The owner deliberately alters only its isolated copy. Restore mode400 and
    # retain the damaged bytes; neither copy is ever imported or executed.
    parent_fd=open_artifact_root(path.parent);held=None;fd=None
    try:
        held=os.open(path.name,FILE_FLAGS,dir_fd=parent_fd)
        if _identity(os.fstat(held))!=_identity(metadata):_fail('BOOTSTRAP_FIXTURE_COPY_CHANGED')
        os.fchmod(held,0o600);pin=os.fstat(held)
        fd=os.open(path.name,os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent_fd)
        if _identity(os.fstat(fd))!=_identity(pin):_fail('BOOTSTRAP_FIXTURE_COPY_CHANGED')
        changed=payload[:-1]+b'#';view=memoryview(changed)
        while view:
            count=os.write(fd,view)
            if count<=0:_fail('BOOTSTRAP_FIXTURE_WRITE_UNCERTAIN')
            view=view[count:]
        os.fchmod(fd,0o400);os.fsync(fd)
    finally:
        if fd is not None:os.close(fd)
        if held is not None:os.close(held)
        os.close(parent_fd)
    try:_read(path,payload)
    except BootstrapFixtureError as error:tamper_reason=str(error)
    else:_fail('BOOTSTRAP_FIXTURE_TAMPER_NOT_REFUSED')
    tampered,_=_read(path,changed);guard()
    inputs={'schema':'RBRIDGE_BOOTSTRAP_FIXTURE_INPUT_V1','profile_sha256':report_sha256(profile),'parent':str(root),
        'payload_base64':base64.b64encode(payload).decode(),'manifest':manifest,'capture':capture,'binding':binding}
    output={'uid':os.getuid(),'euid':os.geteuid(),'proof':proof,'publication':publication,
        'original_base64':base64.b64encode(original).decode(),'original_mode':metadata.st_mode&0o7777,
        'collision_reason':collision_reason,'collision_unchanged':after==original,'tamper_reason':tamper_reason,
        'tampered_base64':base64.b64encode(tampered).decode()}
    case={'schema':'RBRIDGE_BOOTSTRAP_FIXTURE_CASE_V1','scope':'ISOLATED_BOOTSTRAP_SOURCE_DATA_ONLY','status':'PASS',
        'input_json':encode_report(inputs).decode(),'output_json':encode_report(output).decode()}
    case.update(input_sha256=hashlib.sha256(case['input_json'].encode()).hexdigest(),output_sha256=hashlib.sha256(case['output_json'].encode()).hexdigest())
    compare_bootstrap_case(profile,module,case);return case


def produce_bootstrap_case(parent,profile,module,payload,manifest,capture,binding):
    return _produce(parent,profile,module,payload,manifest,capture,binding,module._publish_fixture_bootstrap)


def compare_bootstrap_case(profile,module,case):
    if len(encode_report(case))>profile.budget.carrier_bytes:_fail('BOOTSTRAP_FIXTURE_BYTE_LIMIT')
    if (type(case) is not dict or set(case)!={'schema','scope','status','input_json','output_json','input_sha256','output_sha256'}
            or case['schema']!='RBRIDGE_BOOTSTRAP_FIXTURE_CASE_V1' or case['scope']!='ISOLATED_BOOTSTRAP_SOURCE_DATA_ONLY'
            or case['status']!='PASS'):_fail('BOOTSTRAP_FIXTURE_CASE_INVALID')
    rows=[]
    for raw,digest in [('input_json','input_sha256'),('output_json','output_sha256')]:
        if type(case[raw]) is not str or hashlib.sha256(case[raw].encode()).hexdigest()!=case[digest]:_fail('BOOTSTRAP_FIXTURE_PREIMAGE_CHANGED')
        value=_json(case[raw].encode(),profile.budget.carrier_bytes)
        if encode_report(value).decode()!=case[raw]:_fail('BOOTSTRAP_FIXTURE_NONCANONICAL')
        rows.append(value)
    inputs,out=rows
    if (type(inputs) is not dict or set(inputs)!={'schema','profile_sha256','parent','payload_base64','manifest','capture','binding'}
            or inputs['schema']!='RBRIDGE_BOOTSTRAP_FIXTURE_INPUT_V1' or inputs['profile_sha256']!=report_sha256(profile)
            or type(inputs['parent']) is not str or not Path(inputs['parent']).is_absolute()):_fail('BOOTSTRAP_FIXTURE_INPUT_INVALID')
    payload=decode_bootstrap_body(inputs['capture']['body'],inputs['manifest'])
    if base64.b64encode(payload).decode()!=inputs['payload_base64']:_fail('BOOTSTRAP_FIXTURE_PAYLOAD_CHANGED')
    manifest=inputs['manifest']
    _pins(profile,manifest,inputs['binding'])
    proof=module.verify_bootstrap_artifact(payload,manifest,inputs['capture'],inputs['binding'])
    fields={'uid','euid','proof','publication','original_base64','original_mode','collision_reason','collision_unchanged','tamper_reason','tampered_base64'}
    if (type(out) is not dict or set(out)!=fields or any(type(out[k]) is not int or out[k]<0 for k in ('uid','euid','original_mode'))
            or out['original_mode']!=0o400 or encode_report(out['proof'])!=encode_report(proof)
            or out['original_base64']!=inputs['payload_base64'] or out['tampered_base64']!=base64.b64encode(payload[:-1]+b'#').decode()
            or out['collision_reason']!='BOOTSTRAP_PUBLICATION_UNCERTAIN' or out['collision_unchanged'] is not True
            or out['tamper_reason']!='BOOTSTRAP_FIXTURE_BYTES_CHANGED'):_fail('BOOTSTRAP_FIXTURE_OUTPUT_CHANGED')
    publication=out['publication']
    if (type(publication) is not dict or set(publication)!=set(proof)|{'path','identity'}
            or any(publication[k]!=v for k,v in proof.items() if k!='scope')
            or publication['scope'] not in ('FIXTURE_AUTHORITY_ONLY','ROOT_PROTECTED_BYTES_ONLY')
            or publication['path']!=str(Path(inputs['parent'])/('bootstrap-'+manifest['payload_sha256'])/'payload.py')
            or type(publication['identity']) is not list or len(publication['identity'])!=9
            or any(type(v) is not str or not v.isascii() or not v.isdecimal() for v in publication['identity'])
            or int(publication['identity'][2])!=stat.S_IFREG|0o400 or int(publication['identity'][3])!=out['uid']
            or int(publication['identity'][5])!=1 or int(publication['identity'][6])!=len(payload)):
        _fail('BOOTSTRAP_FIXTURE_PUBLICATION_CHANGED')
    return {'status':'PASS','scope':'ISOLATED_BOOTSTRAP_SOURCE_DATA_ONLY','case':'bootstrap','physical_origin':'UNQUALIFIED',
        'bootstrap_execution':'NOT_PERFORMED','full_privileged_qualification':'INCOMPLETE','may_execute':False}
