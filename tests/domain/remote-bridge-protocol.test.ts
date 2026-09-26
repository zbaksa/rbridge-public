import { describe, expect, it } from 'vitest';
import { parseRemoteBridgeRequest, remoteBridgeRequestDigest } from '../../src/domain/remoteBridgeProtocol.js';

const NOW=new Date('2026-09-16T18:10:00.000Z');
const body=()=>({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',requestId:'bridge.req.1',createdAt:'2026-09-16T18:00:00.000Z',expiresAt:'2026-09-16T18:20:00.000Z',appId:'cocwin',jobId:'bridge-probe-1',operation:'RUN',payload:{tool:'probe',cwd:'/home/cocwin/backend',args:[],timeout_ms:30000,max_bytes:262144}});
const issue=(patch:Record<string,unknown>={})=>({title:'[COCWIN BRIDGE REQUEST] bridge.req.1',authorLogin:'zbaksa',body:JSON.stringify({...body(),...patch}),now:NOW});
const parse=(patch:Record<string,unknown>={})=>parseRemoteBridgeRequest(issue(patch));
const code=(fn:()=>unknown,expected:string)=>expect(fn).toThrowError(expected);

describe('COCWIN remote bridge request protocol',()=>{
  it('accepts the exact request contract and returns a stable semantic digest',()=>{
    const a=parse(); expect(a).toEqual(body());
    const d=remoteBridgeRequestDigest(a); expect(d).toMatch(/^[0-9a-f]{64}$/); expect(remoteBridgeRequestDigest(parse())).toBe(d);
    const reordered=JSON.stringify({operation:'RUN',jobId:'bridge-probe-1',appId:'cocwin',expiresAt:'2026-09-16T18:20:00.000Z',createdAt:'2026-09-16T18:00:00.000Z',requestId:'bridge.req.1',schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',payload:{max_bytes:262144,timeout_ms:30000,args:[],cwd:'/home/cocwin/backend',tool:'probe'}});
    expect(remoteBridgeRequestDigest(parseRemoteBridgeRequest({...issue(),body:reordered}))).toBe(d);
    expect(remoteBridgeRequestDigest(parse({payload:{...body().payload,max_bytes:262145}}))).not.toBe(d);
  });

  it('rejects issue identity, schema and unexpected fields',()=>{
    code(()=>parseRemoteBridgeRequest({...issue(),authorLogin:'other'}),'REMOTE_BRIDGE_AUTHOR_INVALID');
    code(()=>parseRemoteBridgeRequest({...issue(),title:'other'}),'REMOTE_BRIDGE_TITLE_INVALID');
    code(()=>parseRemoteBridgeRequest({...issue(),title:'[COCWIN BRIDGE REQUEST] other'}),'REMOTE_BRIDGE_TITLE_REQUEST_ID_MISMATCH');
    code(()=>parse({schema:'OTHER'}),'REMOTE_BRIDGE_SCHEMA_INVALID');
    code(()=>parse({extra:true}),'REMOTE_BRIDGE_FIELDS_INVALID');
    code(()=>parse({payload:{...body().payload,secret:'x'}}),'REMOTE_BRIDGE_PAYLOAD_FIELDS_INVALID');
    code(()=>parse({command:'rm -rf /'}),'REMOTE_BRIDGE_FIELDS_INVALID');
  });

  it('rejects invalid identifiers and oversized bodies',()=>{
    code(()=>parse({requestId:'Bad ID'}),'REMOTE_BRIDGE_REQUEST_ID_INVALID');
    code(()=>parse({appId:'Bad App'}),'REMOTE_BRIDGE_APP_ID_INVALID');
    code(()=>parse({jobId:'Bad Job'}),'REMOTE_BRIDGE_JOB_ID_INVALID');
    code(()=>parseRemoteBridgeRequest({...issue(),body:' '.repeat(65537)}),'REMOTE_BRIDGE_BODY_TOO_LARGE');
  });

  it('enforces valid ISO time order, TTL and freshness',()=>{
    code(()=>parse({createdAt:'bad'}),'REMOTE_BRIDGE_CREATED_AT_INVALID');
    code(()=>parse({expiresAt:'bad'}),'REMOTE_BRIDGE_EXPIRES_AT_INVALID');
    code(()=>parse({expiresAt:'2026-09-16T18:00:00.000Z'}),'REMOTE_BRIDGE_TIME_ORDER_INVALID');
    code(()=>parse({expiresAt:'2026-09-16T18:30:00.001Z'}),'REMOTE_BRIDGE_TTL_INVALID');
    code(()=>parseRemoteBridgeRequest({...issue(),now:new Date('2026-09-16T18:20:00.001Z')}),'REMOTE_BRIDGE_REQUEST_EXPIRED');
  });

  it('mirrors app-execution payload structural bounds before forwarding',()=>{
    code(()=>parse({payload:{...body().payload,tool:'shell'}}),'REMOTE_BRIDGE_TOOL_INVALID');
    code(()=>parse({payload:{...body().payload,cwd:'relative'}}),'REMOTE_BRIDGE_CWD_INVALID');
    code(()=>parse({payload:{...body().payload,args:'x'}}),'REMOTE_BRIDGE_ARGS_INVALID');
    code(()=>parse({payload:{...body().payload,args:['a\0b']}}),'REMOTE_BRIDGE_ARGS_INVALID');
    code(()=>parse({payload:{...body().payload,args:Array(257).fill('x')}}),'REMOTE_BRIDGE_ARGS_INVALID');
    code(()=>parse({payload:{...body().payload,args:['x'.repeat(8193)]}}),'REMOTE_BRIDGE_ARGS_INVALID');
    expect(parse({payload:{...body().payload,tool:'opencode',args:['run','x'.repeat(24*1024)]}}).payload.args).toHaveLength(2);
    code(()=>parse({payload:{...body().payload,tool:'opencode',args:['run','x'.repeat(24*1024+1)]}}),'REMOTE_BRIDGE_ARGS_INVALID');
    code(()=>parse({payload:{...body().payload,args:Array(5).fill('x'.repeat(7000))}}),'REMOTE_BRIDGE_ARGS_INVALID');
    code(()=>parse({payload:{...body().payload,timeout_ms:999}}),'REMOTE_BRIDGE_TIMEOUT_INVALID');
    code(()=>parse({payload:{...body().payload,timeout_ms:1800001}}),'REMOTE_BRIDGE_TIMEOUT_INVALID');
    code(()=>parse({payload:{...body().payload,max_bytes:4095}}),'REMOTE_BRIDGE_MAX_BYTES_INVALID');
    code(()=>parse({payload:{...body().payload,max_bytes:1048577}}),'REMOTE_BRIDGE_MAX_BYTES_INVALID');
  });
});