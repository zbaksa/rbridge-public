import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(state:'open'|'closed'){
  const base=await mkdtemp(join(tmpdir(),'rb-audit-cli-'));roots.push(base);
  const stateRoot=join(base,'state');await mkdir(stateRoot);
  await writeFile(join(stateRoot,'req-cli.json'),JSON.stringify({
    schema:'COCWIN_REMOTE_BRIDGE_STORE_V1',requestId:'req-cli',requestSha256:'a'.repeat(64),
    issueNumber:1,jobId:'job-1',phase:'SUBMITTED',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:01:00.000Z'
  }));
  const ghPath=join(base,'gh');
  const response={number:1,state,title:'[COCWIN BRIDGE REQUEST] req-cli',user:{login:'bridge-owner'}};
  await writeFile(ghPath,`#!${process.execPath}\nif(process.argv.slice(2).join(' ')!=='api repos/example/control/issues/1')process.exit(20);console.log(${JSON.stringify(JSON.stringify(response))});\n`,{mode:0o700});
  return {stateRoot,ghPath};
}
function run(stateRoot:string,ghPath:string){
  return spawnSync(process.execPath,['--import','tsx',resolve('src/server/remoteBridgeDurableAudit.ts'),
    '--state-root',stateRoot,'--repository','example/control','--author','bridge-owner','--gh-path',ghPath],
    {encoding:'utf8',timeout:20000,maxBuffer:128*1024});
}

describe('durable audit command gate',()=>{
  it('returns a nonzero exit code when trusted unresolved work blocks cutover',async()=>{
    const {stateRoot,ghPath}=await fixture('open'),result=run(stateRoot,ghPath);
    expect(JSON.parse(result.stdout)).toMatchObject({auditStatus:'PASS',cutoverGate:'BLOCKED',unresolvedOpenTrusted:1});
    expect(result.status).toBe(4);
  });
  it('writes machine-readable UNKNOWN to the report stream when evidence is unreadable',async()=>{
    const {stateRoot,ghPath}=await fixture('closed');await writeFile(join(stateRoot,'req-cli.json'),'{broken');
    const result=run(stateRoot,ghPath);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({auditStatus:'UNKNOWN',cutoverGate:'UNKNOWN'});
  });
});
