import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const file='ops/upgrade_rbridge_app_waiting_v9.py';
const source=readFileSync(file,'utf8');
const OLD='008885e07394f20746f034cbd7fe52c6b520533d';
const NEW='dcf3cb9ad8b43532c19fff849eab086b280915d9';

describe('guarded live-base RBridge V9 installer (static-only)',()=>{
  it('has parseable Python 3 syntax without executing privileged code',()=>{
    const program='import ast,pathlib; ast.parse(pathlib.Path('+JSON.stringify(file)+').read_text())';
    expect(()=>execFileSync('/usr/bin/python3',['-I','-S','-B','-c',program],{timeout:5000})).not.toThrow();
  });
  it('pins the exact live base and CI-verified hotfix source',()=>{
    expect(source).toContain(OLD);
    expect(source).toContain(NEW);
    expect(source).toContain('SOURCE_SHA_MISMATCH');
    expect(source).toContain('LIVE_RELEASE_CHANGED');
  });
  it('accepts only an exact pinned historical digest, rejects changed and new unresolved jobs',()=>{
    const program=`import hashlib,json,pathlib,runpy,tempfile
x=runpy.run_path("ops/upgrade_rbridge_app_waiting_v9.py")
g=x["quiescence"].__globals__
with tempfile.TemporaryDirectory() as t:
 p=pathlib.Path(t);g["STATE"]=p;g["ARCHIVE_COUNT"]=1
 r={"schema":"COCWIN_REMOTE_BRIDGE_STORE_V1","requestId":"req-1","issueNumber":33,"requestSha256":"a"*64,"phase":"SUBMITTED"}
 (p/"req-1.json").write_text(json.dumps(r))
 s="req-1\\t33\\tSUBMITTED\\t"+"a"*64+"\\n"
 g["ARCHIVE_DIGEST"]=hashlib.sha256(s.encode()).hexdigest()
 assert x["quiescence"]() is True
 r["requestSha256"]="b"*64;(p/"req-1.json").write_text(json.dumps(r))
 try:x["quiescence"]()
 except RuntimeError as e:assert str(e)=="UNRESOLVED_SET_SHA256_CHANGED"
 else:raise AssertionError("tampered historical record accepted")
 r["requestSha256"]="a"*64;(p/"req-1.json").write_text(json.dumps(r))
 r2=dict(r,requestId="req-2",issueNumber=34)
 (p/"req-2.json").write_text(json.dumps(r2))
 try:x["quiescence"]()
 except RuntimeError as e:assert "UNRESOLVED_SET_COUNT_CHANGED" in str(e)
 else:raise AssertionError("new unresolved request accepted")
`;
    expect(()=>execFileSync('/usr/bin/python3',['-I','-S','-B','-c',program],{timeout:7000})).not.toThrow();
  });

  it('keeps app code build non-root, safe quiescence gates and rollback',()=>{
    expect(source).toContain('runuser');
    expect(source).toContain('rbridge-ci');
    expect(source).toContain('V9_QUIESCENCE_PASS');
    expect(source).toContain('UNRESOLVED_START_CLAIM');
    expect(source).toContain('V9_ROLLBACK_OLD_SERVICE_RESTORED');
    expect(source).toContain('V9_BACKUP_SHA256=');
    expect(source).toContain('STAGED_SHA256_MISMATCH');
    expect(source).toContain('UNRESOLVED_SET_SHA256_CHANGED');
    expect(source).toContain('V9_GITHUB_HEALTH_AND_CONCURRENCY_CANARY_REQUIRED');
    expect(source).not.toContain('systemctl daemon-reload');
    expect(source).not.toContain('os.system(');
  });
});
