import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import type {RemoteBridgeStage2Operation} from '../../src/domain/remoteBridgeStage2Protocol.js';
import {createRemoteBridgeFileOps} from '../../src/server/remoteBridgeFileOps.js';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRemoteBridgeWorker} from '../../src/server/remoteBridgeWorker.js';
type FileOperation=Extract<RemoteBridgeStage2Operation,{kind:'FILE'}>;
const TRANSPORT={repository:'example/rbridge-control',authorLogin:'bridge-owner',instanceId:'test-instance'} as const,roots:string[]=[];
const now=()=>new Date('2026-09-27T12:00:00.000Z'),requestId='rb001.missing-target';
const controller={submit:async()=>{throw new Error('FILE must not submit an application job');},status:async()=>{throw new Error('FILE must not query application status');},result:async()=>{throw new Error('FILE must not query application results');}};
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(action:FileOperation['action']){
 const root=await mkdtemp(join(tmpdir(),'rb001-'));roots.push(root);const files=join(root,'files');await mkdir(files);
 const missing=join(files,'missing.txt'),storeRoot=join(root,'store'),durable=createRemoteBridgeStore(storeRoot,now);
 const fileOps=createRemoteBridgeFileOps({allowedRoots:[files],maxReadBytes:65536,maxSearchResults:10});
 const operation:FileOperation={kind:'FILE',action,target:action==='READ_MANY'?files:missing,args:action==='READ_MANY'?{paths:['existing.txt','missing.txt']}:action==='SEARCH'?{query:'needle'}:action==='APPEND_TEXT'?{text:'once'}:action==='MOVE'?{destination:join(files,'moved.txt')}:{}};
 await writeFile(join(files,'existing.txt'),'MUST_NOT_LEAK_PARTIAL_CONTENT');
 const issue={number:1,title:`[COCWIN BRIDGE REQUEST] ${requestId}`,authorLogin:TRANSPORT.authorLogin,url:'https://github.com/example/rbridge-control/issues/1',body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId,createdAt:'2026-09-27T11:59:00.000Z',expiresAt:'2026-09-27T12:20:00.000Z',operation})};
 const published:unknown[]=[],github={listOpenRequests:async()=>[issue],publishResult:async(_n:number,result:unknown)=>{published.push(result);}};
 const worker=createRemoteBridgeWorker({...TRANSPORT,now,store:durable,github,controller,fileOps});
 return {files,missing,storeRoot,durable,fileOps,published,github,worker};
}
describe('RB-001 missing read-only FILE target',()=>{
 it.each(['STAT','READ','LIST','SEARCH','READ_MANY'] as const)('%s publishes a durable terminal result for real ENOENT',async action=>{const f=await fixture(action);expect(await f.worker.runOnce()).toEqual({seen:1,pending:0,published:1,blocked:1,errors:0});expect(f.published).toHaveLength(1);expect(f.published[0]).toMatchObject({schema:'COCWIN_REMOTE_BRIDGE_RESULT_V2',requestId,status:'BLOCKED',reason:'REMOTE_BRIDGE_FILE_TARGET_NOT_FOUND'});expect((await f.durable.get(requestId))?.phase).toBe('PUBLISHED');expect(JSON.stringify(f.published)).not.toContain(f.missing);expect(JSON.stringify(f.published)).not.toContain('MUST_NOT_LEAK_PARTIAL_CONTENT');});
 it('replays after worker recreation even when target appears',async()=>{const f=await fixture('READ');await f.worker.runOnce();await writeFile(f.missing,'NEW_CONTENT_MUST_NOT_BE_READ');const w=createRemoteBridgeWorker({...TRANSPORT,now,store:createRemoteBridgeStore(f.storeRoot,now),github:f.github,controller,fileOps:f.fileOps});expect(await w.runOnce()).toEqual({seen:1,pending:0,published:1,blocked:1,errors:0});expect(f.published[1]).toMatchObject({status:'BLOCKED',reason:'REPLAY'});expect(JSON.stringify(f.published)).not.toContain('NEW_CONTENT_MUST_NOT_BE_READ');});
 it('recovers publication failure without reexecuting read',async()=>{const f=await fixture('READ');const offline=createRemoteBridgeWorker({...TRANSPORT,now,store:f.durable,controller,fileOps:f.fileOps,github:{listOpenRequests:f.github.listOpenRequests,publishResult:async()=>{throw new Error('simulated publication outage');}}});expect(await offline.runOnce()).toEqual({seen:1,pending:0,published:0,blocked:0,errors:1});expect((await f.durable.get(requestId))?.phase).toBe('TERMINAL');await writeFile(f.missing,'CHANGED_AFTER_PUBLICATION_OUTAGE');const w=createRemoteBridgeWorker({...TRANSPORT,now,store:createRemoteBridgeStore(f.storeRoot,now),github:f.github,controller,fileOps:f.fileOps});expect(await w.runOnce()).toEqual({seen:1,pending:0,published:1,blocked:1,errors:0});expect(f.published[0]).toMatchObject({status:'BLOCKED',reason:'REPLAY'});expect(JSON.stringify(f.published)).not.toContain('CHANGED_AFTER_PUBLICATION_OUTAGE');});
 it('preserves APPEND_TEXT creation',async()=>{const f=await fixture('APPEND_TEXT');expect(await f.worker.runOnce()).toEqual({seen:1,pending:0,published:1,blocked:0,errors:0});expect(await readFile(f.missing,'utf8')).toBe('once');expect(f.published[0]).toMatchObject({status:'PASS',operationResult:{appended:true}});await f.worker.runOnce();expect(await readFile(f.missing,'utf8')).toBe('once');});
 it('does not broaden classification to MOVE failures',async()=>{const f=await fixture('MOVE');expect(await f.worker.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:1});expect((await f.durable.get(requestId))?.phase).toBe('SUBMITTED');expect(f.published).toHaveLength(0);});
 it('does not misclassify persistence ENOENT',async()=>{const f=await fixture('READ');await writeFile(f.missing,'exists');const broken={...f.durable,markTerminal:async()=>{throw Object.assign(new Error('simulated persistence failure'),{code:'ENOENT'});}};const w=createRemoteBridgeWorker({...TRANSPORT,now,store:broken,github:f.github,controller,fileOps:f.fileOps});expect(await w.runOnce()).toEqual({seen:1,pending:1,published:0,blocked:0,errors:1});expect((await f.durable.get(requestId))?.phase).toBe('SUBMITTED');expect(f.published).toHaveLength(0);});
});
