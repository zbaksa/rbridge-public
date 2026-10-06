import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,link,rm,mkdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach,describe,expect,it} from 'vitest';
import {openFixtureReadonlySnapshot,openReadonlySnapshot} from '../../src/installation/readonlySnapshot.js';
import {parseRBridgeInstallProfile} from '../../src/installation/types.js';
import {runInstallationState} from '../../src/installation/rbridge-installation-state.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'rbridge-snapshot-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'record.json'),'é retained\n',{mode:0o600});return root;}
describe('complete readonly installation snapshot',()=>{
  it('every read preserves fingerprint and detects mutation without repairing it',async()=>{
    const root=await fixture(),snapshot=await openFixtureReadonlySnapshot(root,process.getuid!());cleanup.push(()=>snapshot.close());
    const before=snapshot.treeSHA256,metadata=await lstat(join(root,'record.json'),{bigint:true});
    expect((await snapshot.read('record.json')).toString()).toBe('é retained\n');await snapshot.verify();expect(snapshot.treeSHA256).toBe(before);
    const after=await lstat(join(root,'record.json'),{bigint:true});expect([after.mode,after.uid,after.nlink,after.mtimeNs,after.ctimeNs]).toEqual([metadata.mode,metadata.uid,metadata.nlink,metadata.mtimeNs,metadata.ctimeNs]);
    await writeFile(join(root,'record.json'),'changed');await expect(snapshot.verify()).rejects.toThrow();await expect(snapshot.read('record.json')).rejects.toThrow();expect(await readFile(join(root,'record.json'),'utf8')).toBe('changed');
  });
  it('retains unknown names and internal hardlinks; traversal cannot select a new path',async()=>{
    const root=await fixture();await mkdir(join(root,'flowpilot'),{mode:0o700});await link(join(root,'record.json'),join(root,'flowpilot','two-link'));
    const snapshot=await openFixtureReadonlySnapshot(root,process.getuid!());cleanup.push(()=>snapshot.close());
    expect(snapshot.entries.filter(e=>e.kind==='FILE')).toHaveLength(2);expect(snapshot.entries.find(e=>e.path==='record.json')?.nlink).toBe(2);
    expect(snapshot.reasonCodes).toEqual([]);await expect(snapshot.read('../outside')).rejects.toThrow();await expect(snapshot.read('not-in-snapshot')).rejects.toThrow();
    const bytes=await snapshot.read('flowpilot/two-link');expect(createHash('sha256').update(bytes).digest('hex')).toBe(snapshot.entries.find(e=>e.path==='record.json')?.sha256);
  });
  it('production guard does not create absent Core or use a fixture authority',async()=>{
    const root=await fixture(),raw=JSON.parse(await readFile(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8'));
    raw.paths.state_root=root;expect(()=>parseRBridgeInstallProfile(raw)).toThrow();
    const p=parseRBridgeInstallProfile(JSON.parse(await readFile(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')));
    await expect(openReadonlySnapshot(p,{transaction_id:'a'.repeat(32),state_root_identity_sha256:'1'.repeat(64),tree_sha256:'1'.repeat(64),entries:0,bytes:0,pause_sha256:'1'.repeat(64),captured_at:'2026-10-06T00:00:00.000Z'})).rejects.toThrow();
    await expect(lstat(join(root,'execution-v2'))).rejects.toMatchObject({code:'ENOENT'});
    const token={transaction_id:'a'.repeat(32),state_root_identity_sha256:'1'.repeat(64),tree_sha256:'1'.repeat(64),entries:0,bytes:0,pause_sha256:'1'.repeat(64),captured_at:'2026-10-06T00:00:00.000Z'};
    expect(await runInstallationState({schema:'RBRIDGE_INSTALLATION_STATE_INPUT_V1',profile:p,token})).toMatchObject({status:'UNKNOWN',scope:'READONLY_SNAPSHOT_BYTES_ONLY'});
  });
  it('matches the independent Python descriptor fingerprint including hardlinks and unknown bytes',async()=>{
    const root=await fixture();await link(join(root,'record.json'),join(root,'second'));await writeFile(join(root,'unknown'),Buffer.from([0,255,1]),{mode:0o600});
    const snapshot=await openFixtureReadonlySnapshot(root,process.getuid!());cleanup.push(()=>snapshot.close());
    const program="import sys,os\nfrom pathlib import Path\nfrom types import SimpleNamespace\nsys.path.insert(0,sys.argv[1])\nfrom rbridge_installation.pause_backup import _inventory,_fingerprint\nr,e,b,c=_inventory(Path(sys.argv[2]),os.getuid(),os.getgid(),SimpleNamespace(state_entries=40000,state_depth=64,state_bytes=68719476736,scan_ms=600000),())\nprint(_fingerprint(r,e))\n";
    const python=execFileSync('python3',['-I','-B','-c',program,fileURLToPath(new URL('../../ops/install',import.meta.url)),root],{encoding:'utf8',timeout:10000}).trim();
    expect(python).toBe(snapshot.treeSHA256);await snapshot.verify();
  });
});
