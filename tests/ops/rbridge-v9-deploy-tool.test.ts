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
  it('keeps app code build non-root, safe quiescence gates and rollback',()=>{
    expect(source).toContain('runuser');
    expect(source).toContain('rbridge-ci');
    expect(source).toContain('V9_QUIESCENCE_PASS');
    expect(source).toContain('UNRESOLVED_START_CLAIM');
    expect(source).toContain('V9_ROLLBACK_OLD_SERVICE_RESTORED');
    expect(source).toContain('V9_GITHUB_HEALTH_AND_CONCURRENCY_CANARY_REQUIRED');
    expect(source).not.toContain('systemctl daemon-reload');
    expect(source).not.toContain('os.system(');
  });
});
