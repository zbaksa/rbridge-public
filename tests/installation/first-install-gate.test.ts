import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {afterEach,describe,expect,it} from 'vitest';
import {auditFirstInstallCore,collectFirstInstallGates,validateFirstInstallGateBundle} from '../../src/installation/firstInstallGate.js';
import {installHash} from '../../src/installation/gateContext.js';
import type {Gate,GateReport} from '../../src/installation/types.js';
import {fixtureGateContext} from './fixtureContext.js';
import {runInstallationDiscovery} from '../../src/cli/rbridgeInstallationAudit.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(core:'ABSENT'|'DIRECTORY'|'FILE'|'DANGLING'='ABSENT'){
  const root=await mkdtemp(join(tmpdir(),'rbridge-first-install-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  if(core==='DIRECTORY')await mkdir(join(root,'execution-v2'),{mode:0o700});
  if(core==='FILE')await writeFile(join(root,'execution-v2'),'retained',{mode:0o600});
  if(core==='DANGLING')await symlink('missing',join(root,'execution-v2'));
  const context=await fixtureGateContext(root);cleanup.push(()=>context.snapshot.close());return {root,context};
}
const gates:Gate[]=['LEGACY','FLOWPILOT','PROCESS','TRANSFERS','CORE'];
describe('first-install Core and one complete paused bundle',()=>{
  it('source discovery cannot impersonate a qualified installed non-root helper',async()=>{
    const f=await fixture();const result=await runInstallationDiscovery({schema:'RBRIDGE_INSTALL_DISCOVERY_INPUT_V1',profile:f.context.profile,token:f.context.token});expect(result.status).toBe('UNKNOWN');expect(result.reason_codes).toContain('STATE_QUALIFIED_RUNTIME_REQUIRED');
  });
  it('only genuinely absent Core passes; even an empty directory blocks without initialization',async()=>{
    const absent=await fixture();expect((await auditFirstInstallCore(absent.context)).status).toBe('PASS');
    for(const kind of ['DIRECTORY','FILE','DANGLING'] as const){const f=await fixture(kind),before=f.context.snapshot.treeSHA256;expect((await auditFirstInstallCore(f.context)).status).toBe('BLOCKED');await f.context.snapshot.verify();expect(f.context.snapshot.treeSHA256).toBe(before);}
  });
  it('mixed tokens, duplicate/missing reports and malformed evidence can never pass',async()=>{
    const f=await fixture(),reports:GateReport[]=gates.map(gate=>({gate,status:'PASS',snapshot_sha256:installHash(f.context.token),evidence_sha256:installHash(gate),checks:[],reason_codes:[]}));
    expect(validateFirstInstallGateBundle(reports,f.context.token).status).toBe('PASS');
    const cases:GateReport[][]=[
      reports.slice(0,4),[reports[0]!,...reports.slice(0,4)],
      [...reports.slice(0,4),{...reports[4]!,snapshot_sha256:'f'.repeat(64)}],
      [...reports.slice(0,4),{...reports[4]!,evidence_sha256:''}],
      [...reports.slice(0,4),{...reports[4]!,reason_codes:['FORGED_PASS']}],
    ];
    for(const changed of cases)expect(validateFirstInstallGateBundle(changed,f.context.token).status).not.toBe('PASS');
  });
  it('all five gates share the snapshot and retain lookup or Core failure without partial PASS',async()=>{
    const f=await fixture(),good=await collectFirstInstallGates(f.context,[]);expect(good.status).toBe('PASS');expect(good.reports.map(r=>r.gate)).toEqual(gates);
    const core=await fixture('DIRECTORY'),blocked=await collectFirstInstallGates(core.context,[]);expect(blocked.status).toBe('BLOCKED');expect(blocked.reports).toHaveLength(5);expect(blocked.reason_codes).toContain('CORE_UNEXPECTED_EXISTING_STATE');
    const noLookup=await collectFirstInstallGates({...f.context,lookup:{...f.context.lookup,status:'UNKNOWN'}},[]);expect(noLookup.status).toBe('UNKNOWN');expect(noLookup.reason_codes).toContain('LEGACY_AUTHENTICATED_LOOKUP_REQUIRED');
    await writeFile(join(f.root,'unexpected'),'new',{mode:0o600});expect((await collectFirstInstallGates(f.context,[])).status).not.toBe('PASS');
  });
  it('fixed source CLI rejects duplicate-key and missing evidence input without a qualified snapshot',async()=>{
    const result=await new Promise<{exit:number|null;out:string}>(resolve=>{const child=spawn(process.execPath,['--import','tsx','src/cli/rbridgeInstallationAudit.ts'],{cwd:process.cwd(),env:{PATH:process.env.PATH??'/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});let out='';child.stdout.on('data',data=>{out+=String(data);});child.stderr.resume();child.on('close',exit=>resolve({exit,out}));child.stdin.end('{"schema":"RBRIDGE_INSTALL_AUDIT_INPUT_V1","schema":"forged"}');});
    expect(result.exit).not.toBe(0);expect(JSON.parse(result.out).status).toBe('UNKNOWN');expect(JSON.parse(result.out).reason_codes).toContain('AUDIT_INPUT_INVALID');
  });
});
