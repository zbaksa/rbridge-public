import {describe,expect,it} from 'vitest';
import {parseRemoteBridgeRequestV2,remoteBridgeRequestV2Digest} from '../../src/domain/remoteBridgeStage2Protocol.js';

const NOW=new Date('2026-09-16T20:40:00.000Z');
const REQUEST_ID='stage2.req.1';
const INPUT_BASE={title:`[COCWIN BRIDGE REQUEST] ${REQUEST_ID}`,author:'bridge-owner',repository:'example/rbridge-control',expectedAuthor:'bridge-owner',expectedRepository:'example/rbridge-control',now:NOW};
const appRun={kind:'APP_RUN',appId:'cocwin',jobId:'stage2-probe-1',payload:{tool:'probe',cwd:'/home/cocwin/backend',args:[],timeout_ms:30_000,max_bytes:65_536}};
const fileOp={kind:'FILE',action:'READ',target:'/mnt/data/stage2-canary.txt',args:{maxBytes:4096}};
const processOp={kind:'PROCESS',action:'STATUS',sessionId:'session-abc123',args:{}};
const chunkOp={kind:'CHUNK',action:'GET',transferId:'transfer-abc123',args:{index:0}};
const healthOp={kind:'HEALTH',action:'STATUS'};
function body(operation:unknown,patch:Record<string,unknown>={}){return {schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:REQUEST_ID,createdAt:'2026-09-16T20:39:00.000Z',expiresAt:'2026-09-16T20:49:00.000Z',operation,...patch};}
function parse(operation:unknown,patch:Record<string,unknown>={},inputPatch:Record<string,unknown>={}){return parseRemoteBridgeRequestV2({...INPUT_BASE,body:JSON.stringify(body(operation,patch)),...inputPatch});}

describe('COCWIN remote bridge Stage-2 protocol',()=>{
  it('parses only the five exact discriminated operation kinds',()=>{
    for(const [operation,kind] of [[appRun,'APP_RUN'],[fileOp,'FILE'],[processOp,'PROCESS'],[chunkOp,'CHUNK'],[healthOp,'HEALTH']] as const){expect(parse(operation).operation.kind).toBe(kind);}
    expect(()=>parse({kind:'SHELL',action:'RUN',args:{}})).toThrow(/REMOTE_BRIDGE_V2_OPERATION_KIND_INVALID/);
  });
  it('accepts explicit bounded binary FILE actions and still rejects unknown actions',()=>{
    expect(parse({kind:'FILE',action:'READ_BINARY',target:'/mnt/data/a.bin',args:{}}).operation.kind).toBe('FILE');
    expect(parse({kind:'FILE',action:'WRITE_BINARY',target:'/mnt/data/a.bin',args:{dataBase64:'AA==',sha256:'0'.repeat(64)}}).operation.kind).toBe('FILE');
    expect(()=>parse({kind:'FILE',action:'WRITE_BYTES',target:'/mnt/data/a.bin',args:{}})).toThrow(/REMOTE_BRIDGE_V2_FILE_ACTION_INVALID/);
  });
  it('produces a stable semantic digest that changes with semantic content',()=>{
    const first=parse(fileOp);const second=parse({...fileOp,args:{maxBytes:4096}});
    expect(remoteBridgeRequestV2Digest(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(remoteBridgeRequestV2Digest(second)).toBe(remoteBridgeRequestV2Digest(first));
    expect(remoteBridgeRequestV2Digest(parse({...fileOp,target:'/mnt/data/other.txt'}))).not.toBe(remoteBridgeRequestV2Digest(first));
    const ordered=parse({...fileOp,args:{alpha:1,zeta:2}});const reordered=parse({...fileOp,args:{zeta:2,alpha:1}});
    expect(remoteBridgeRequestV2Digest(reordered)).toBe(remoteBridgeRequestV2Digest(ordered));
  });
  it('rejects unknown top-level and operation fields',()=>{
    expect(()=>parse(fileOp,{unexpected:true})).toThrow(/REMOTE_BRIDGE_V2_FIELDS_INVALID/);
    expect(()=>parse({...fileOp,unexpected:true})).toThrow(/REMOTE_BRIDGE_V2_OPERATION_FIELDS_INVALID/);
  });
  it('enforces author, repository, title, ID, body and TTL bounds',()=>{
    expect(()=>parse(fileOp,{}, {author:'someone-else'})).toThrow(/REMOTE_BRIDGE_V2_AUTHOR_INVALID/);
    expect(()=>parse(fileOp,{}, {repository:'other/repo'})).toThrow(/REMOTE_BRIDGE_V2_REPOSITORY_INVALID/);
    expect(()=>parse(fileOp,{}, {title:'wrong'})).toThrow(/REMOTE_BRIDGE_V2_TITLE_INVALID/);
    expect(()=>parse(fileOp,{requestId:'Bad ID'})).toThrow(/REMOTE_BRIDGE_V2_REQUEST_ID_INVALID/);
    expect(()=>parse({...appRun,appId:'Bad App'})).toThrow(/REMOTE_BRIDGE_V2_APP_ID_INVALID/);
    expect(()=>parse({...appRun,jobId:'Bad Job'})).toThrow(/REMOTE_BRIDGE_V2_JOB_ID_INVALID/);
    expect(()=>parse({...processOp,sessionId:'Bad Session!'})).toThrow(/REMOTE_BRIDGE_V2_SESSION_ID_INVALID/);
    expect(()=>parse({...chunkOp,transferId:'Bad Transfer!'})).toThrow(/REMOTE_BRIDGE_V2_TRANSFER_ID_INVALID/);
    const huge=JSON.stringify({...body(fileOp),padding:'x'.repeat(70_000)});
    expect(()=>parseRemoteBridgeRequestV2({...INPUT_BASE,body:huge})).toThrow(/REMOTE_BRIDGE_V2_BODY_TOO_LARGE/);
    const ttl=body(fileOp,{expiresAt:'2026-09-16T21:09:00.001Z'});
    expect(()=>parseRemoteBridgeRequestV2({...INPUT_BASE,body:JSON.stringify(ttl)})).toThrow(/REMOTE_BRIDGE_V2_TTL_INVALID/);
    const skewed=body(fileOp,{createdAt:"2026-09-16T20:42:00.000Z",expiresAt:"2026-09-16T20:52:00.000Z"});
    expect(parseRemoteBridgeRequestV2({...INPUT_BASE,body:JSON.stringify(skewed)}).createdAt).toBe("2026-09-16T20:42:00.000Z");
    const future=body(fileOp,{createdAt:"2026-09-16T20:42:00.001Z",expiresAt:"2026-09-16T20:52:00.001Z"});
    expect(()=>parseRemoteBridgeRequestV2({...INPUT_BASE,body:JSON.stringify(future)})).toThrow(/REMOTE_BRIDGE_V2_CREATED_AT_FUTURE/);
    const expired=body(fileOp,{expiresAt:'2026-09-16T20:40:00.000Z'});
    expect(()=>parseRemoteBridgeRequestV2({...INPUT_BASE,body:JSON.stringify(expired)})).toThrow(/REMOTE_BRIDGE_V2_REQUEST_EXPIRED/);
    expect(parseRemoteBridgeRequestV2({...INPUT_BASE,body:JSON.stringify(expired),allowExpired:true}).requestId).toBe(REQUEST_ID);
  });
  it('rejects request-controlled PROCESS executable paths',()=>{
    expect(()=>parse({kind:'PROCESS',action:'START',args:{profileId:'git-read',executable:'/bin/sh'}})).toThrow(/REMOTE_BRIDGE_V2_PROCESS_EXECUTABLE_REQUEST_CONTROLLED/);
  });
  it('rejects request-controlled FILE allow roots',()=>{
    expect(()=>parse({kind:'FILE',action:'READ',target:'/mnt/data/a.txt',args:{allowedRoots:['/'],maxBytes:4096}})).toThrow(/REMOTE_BRIDGE_V2_FILE_ROOTS_REQUEST_CONTROLLED/);
    expect(()=>parse({kind:'FILE',action:'READ',target:'/mnt/data/a b.txt',args:{maxBytes:4096}})).toThrow(/REMOTE_BRIDGE_V2_FILE_TARGET_INVALID/);
  });
});