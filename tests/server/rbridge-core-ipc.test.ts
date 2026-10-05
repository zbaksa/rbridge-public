import {chmod,lstat,rm,symlink,writeFile} from 'node:fs/promises';
import {Socket} from 'node:net';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {rbridgeOperationIntentDigest} from '../../src/domain/rbridgeExecutionContract.js';
import {connectRBridgeCoreIpcClient,startRBridgeCoreIpcServer} from '../../src/server/rbridgeCoreIpc.js';
import {cleanupRBridgeIpcFixtures,createRBridgeIpcFixture,rawRBridgeRpc} from '../fixtures/rbridge-ipc-owner.js';
const clients:Array<{close():Promise<void>}>=[];
afterEach(async()=>{await Promise.all(clients.splice(0).map(client=>client.close()));await cleanupRBridgeIpcFixtures();});
const frame=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
const result=(action:string,value:unknown)=>({schema:'RBRIDGE_CORE_RPC_RESULT_V1',action,value});

describe('private one-RPC core IPC',()=>{
  it('requires a held owner lock before creating a socket',async()=>{
    const f=await createRBridgeIpcFixture();await f.owner.close();await expect(f.start()).rejects.toThrow('RBRIDGE_OWNER_LOCK_REQUIRED');await expect(lstat(join(f.root,'core.sock'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('derives MCP authority locally and checks each action on separate connections',async()=>{
    const f=await createRBridgeIpcFixture();await f.start();const client=await connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files});clients.push(client);
    expect(await client.binding()).toEqual(f.binding);expect((await lstat(join(f.root,'core.sock'))).mode&0o7777).toBe(0o600);
    expect((await client.submit(f.submission,f.context,new AbortController().signal)).status).toBe('REJECTED');expect((await client.status('health-1',f.context)).status).toBe('NOT_FOUND');expect((await client.result('health-1',0,32768,f.context)).status).toBe('NOT_FOUND');expect((await client.requestCancel('health-1',rbridgeOperationIntentDigest(f.submission),f.context)).status).toBe('NOT_FOUND');
    expect(f.calls.map(c=>c.action)).toEqual(['SUBMIT','STATUS','RESULT','CANCEL_INTENT']);for(const call of f.calls){expect(call.context.transport).toBe('MCP');expect(call.context.authenticatedSubject).toBe(`uid:${f.uid}`);expect(call.context.principalId).toBe('operator');}
    await expect(client.status('health-1',{...f.context,transport:'GITHUB'})).rejects.toThrow();await expect(client.submit({...f.submission,targetInstanceId:'foreign'},f.context,new AbortController().signal)).rejects.toThrow();expect(f.calls).toHaveLength(4);
  });
  it('bounds fragmented frames and rejects every trailing or malformed frame before delegation',async()=>{
    const f=await createRBridgeIpcFixture();await f.start();const good=frame({schema:'RBRIDGE_CORE_RPC_V1',action:'SUBMIT',submission:f.submission});
    const reply=JSON.parse(await rawRBridgeRpc(f.root,[good.subarray(0,3),good.subarray(3,21),good.subarray(21)]));expect(reply.action).toBe('SUBMIT');expect(f.calls).toHaveLength(1);
    const hostile=[Buffer.from([0xff,10]),Buffer.concat([good,Buffer.from(' ')]),Buffer.concat([good,good]),good.subarray(0,good.length-1),frame({schema:'RBRIDGE_CORE_RPC_V1',action:'SUBMIT',submission:f.submission,transport:'GITHUB'}),frame({schema:'FOREIGN',action:'STATUS',operationId:'health-1'})];
    for(const bytes of hostile){const response=JSON.parse(await rawRBridgeRpc(f.root,[bytes.subarray(0,bytes.length-1),bytes.subarray(bytes.length-1)]));expect(response.schema).toBe('RBRIDGE_CORE_RPC_ERROR_V1');expect(response.reason).toBe('RBRIDGE_CORE_RPC_INVALID');}expect(f.calls).toHaveLength(1);
  });
  it('counts the request newline and refuses a too-large submission envelope before sending it',async()=>{
    const f=await createRBridgeIpcFixture();await f.start();const base=JSON.stringify({schema:'RBRIDGE_CORE_RPC_V1',action:'BINDING'}),exact=Buffer.from(base+' '.repeat(65536-Buffer.byteLength(base)-1)+'\n');expect(JSON.parse(await rawRBridgeRpc(f.root,[exact])).action).toBe('BINDING');expect(JSON.parse(await rawRBridgeRpc(f.root,[Buffer.concat([exact.subarray(0,-1),Buffer.from(' \n')])])).reason).toBe('RBRIDGE_CORE_RPC_LIMIT');
    const client=await connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files});clients.push(client);const submission={...f.submission,operation:{kind:'PROCESS' as const,action:'START' as const,args:{padding:''}}};submission.operation.args.padding='a'.repeat(65536-Buffer.byteLength(JSON.stringify(submission)));expect(Buffer.byteLength(JSON.stringify(submission))).toBe(65536);
    await expect(client.submit(submission,f.context,new AbortController().signal)).rejects.toThrow();expect(f.calls).toHaveLength(0);
  });
  it('bounds connection floods to64 and restores capacity after disconnect',async()=>{
    const f=await createRBridgeIpcFixture(),server=await f.start(),sockets:Socket[]=[];
    try{for(let n=0;n<64;n++){const socket=new Socket();sockets.push(socket);socket.on('error',()=>undefined);await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.connect(join(f.root,'core.sock'),resolve);});}await new Promise<void>(done=>setImmediate(done));expect(server.connectionCount()).toBe(64);
      const extra=new Socket();sockets.push(extra);extra.on('error',()=>undefined);await new Promise<void>(done=>{extra.once('close',()=>done());extra.connect(join(f.root,'core.sock'));});expect(server.connectionCount()).toBe(64);expect(f.calls).toHaveLength(0);
    }finally{for(const socket of sockets)socket.destroy();}
    const response=JSON.parse(await rawRBridgeRpc(f.root,[frame({schema:'RBRIDGE_CORE_RPC_V1',action:'BINDING'})]));expect(response.action).toBe('BINDING');
  });
  it('rejects socket modes, symlinks, ancestor modes, wrong UID and unavailable owner',async()=>{
    const f=await createRBridgeIpcFixture(),server=await f.start();const connect=()=>connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files});await expect(startRBridgeCoreIpcServer({root:f.root,binding:{...f.binding,runtimeUid:f.uid+1},core:f.core,files:f.files})).rejects.toThrow();await chmod(join(f.root,'core.sock'),0o666);await expect(connect()).rejects.toThrow();expect((await lstat(join(f.root,'core.sock'))).mode&0o777).toBe(0o666);await chmod(join(f.root,'core.sock'),0o600);
    await chmod(f.root,0o755);await expect(connect()).rejects.toThrow();await chmod(f.root,0o700);await expect(connectRBridgeCoreIpcClient({root:f.root,expectedBinding:{...f.deployment,runtimeUid:f.uid+1},files:f.files})).rejects.toThrow();await server.close();await expect(connect()).rejects.toThrow();
    await writeFile(join(f.root,'foreign'),'bytes',{mode:0o600});await symlink(join(f.root,'foreign'),join(f.root,'core.sock'));await expect(connect()).rejects.toThrow();await expect(f.start()).rejects.toThrow();expect((await lstat(join(f.root,'core.sock'))).isSymbolicLink()).toBe(true);await rm(join(f.root,'core.sock'));expect(f.calls).toHaveLength(0);
  });
  it('rejects wrong owner or malformed handshake before submit',async()=>{
    for(const patch of [{principalId:'foreign'},{runtimeUid:1},{policySha256:'wrong'},{journalSchema:'FOREIGN'},{enabledActions:['PROCESS/START']}]){
      const f=await createRBridgeIpcFixture();let submits=0;await f.rogue((request,socket)=>{if(request.action==='SUBMIT')submits++;socket.end(frame(result('BINDING',{...f.binding,...patch})));});await expect(connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files})).rejects.toThrow();expect(submits).toBe(0);
    }
  });
  it('validates response byte limits, fatal UTF8 and action/value matching',async()=>{
    const f=await createRBridgeIpcFixture();let response:Buffer|undefined;await f.rogue((request,socket)=>socket.end(response??frame(result('BINDING',f.binding))));const client=await connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files});clients.push(client);
    const value=JSON.stringify(result('BINDING',f.binding));response=Buffer.from(value+' '.repeat(131072-Buffer.byteLength(value)-1)+'\n');expect(await client.binding()).toEqual(f.binding);
    for(const invalid of [Buffer.concat([response.subarray(0,-1),Buffer.from(' \n')]),Buffer.from([0xff,10]),frame(result('STATUS',f.binding)),Buffer.concat([frame(result('BINDING',f.binding)),Buffer.from(' ')]),frame({...result('BINDING',f.binding),extra:1})]){response=invalid;await expect(client.binding()).rejects.toThrow();}
  });
  it('lost submit acknowledgement never retries even when cancellation acknowledgement is lost',async()=>{
    const f=await createRBridgeIpcFixture();const requests:Array<{action:string;operationId?:string;intentSha256?:string}>=[];await f.rogue((request,socket)=>{requests.push(request);if(request.action==='BINDING')socket.end(frame(result('BINDING',f.binding)));else socket.destroy();});const client=await connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files});clients.push(client);
    await expect(client.submit(f.submission,f.context,new AbortController().signal)).rejects.toThrow();expect(requests.filter(r=>r.action==='SUBMIT')).toHaveLength(1);expect(requests.filter(r=>r.action==='CANCEL_INTENT')).toEqual([{schema:'RBRIDGE_CORE_RPC_V1',action:'CANCEL_INTENT',operationId:'health-1',intentSha256:rbridgeOperationIntentDigest(f.submission)}]);
  });
  it('abort before send creates nothing; abort after send attempts exactly one independent cancel',async()=>{
    const f=await createRBridgeIpcFixture();let sent!:()=>void;const observed=new Promise<void>(done=>{sent=done;});const requests:Array<{action:string}>=[];await f.rogue((request,socket)=>{requests.push(request);if(request.action==='BINDING')socket.end(frame(result('BINDING',f.binding)));if(request.action==='SUBMIT')sent();if(request.action==='CANCEL_INTENT')socket.end(frame(result('CANCEL_INTENT',{status:'REJECTED',reason:'RBRIDGE_CORE_INTENT_COLLISION',...f.scope('health-1')})));});const client=await connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files});clients.push(client);const before=new AbortController();before.abort();await expect(client.submit(f.submission,f.context,before.signal)).rejects.toThrow();expect(requests.filter(r=>r.action==='SUBMIT')).toHaveLength(0);
    const after=new AbortController(),pending=client.submit(f.submission,f.context,after.signal);const rejected=expect(pending).rejects.toThrow();await observed;after.abort();await rejected;expect(requests.filter(r=>r.action==='SUBMIT')).toHaveLength(1);expect(requests.filter(r=>r.action==='CANCEL_INTENT')).toHaveLength(1);
  });
  it('expires an incomplete frame without delegation and aborts an unsettled RPC',async()=>{
    const f=await createRBridgeIpcFixture();f.core.submit=async(submission,context,signal)=>{f.calls.push({action:'SUBMIT',id:submission.operationId,context,signal});await new Promise<void>(done=>signal.addEventListener('abort',()=>done(),{once:true}));return {status:'REJECTED',reason:'RBRIDGE_CORE_CAPACITY_REACHED',...f.scope(submission.operationId)};};await f.start();const socket=new Socket({allowHalfOpen:true});socket.on('error',()=>undefined);const chunks:Buffer[]=[];socket.on('data',b=>chunks.push(Buffer.from(b)));const ended=new Promise<void>(done=>socket.once('end',done));socket.connect(join(f.root,'core.sock'),()=>socket.write('{'));await ended;socket.destroy();expect(JSON.parse(Buffer.concat(chunks).toString()).reason).toBe('RBRIDGE_CORE_RPC_LIMIT');expect(f.calls).toHaveLength(0);
    const client=await connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files});clients.push(client);await expect(client.submit(f.submission,f.context,new AbortController().signal)).rejects.toThrow();expect(f.calls.filter(c=>c.action==='SUBMIT')).toHaveLength(1);expect(f.calls[0]!.signal!.aborted).toBe(true);expect(f.calls.filter(c=>c.action==='CANCEL_INTENT')).toHaveLength(1);
  },30000);
  it('fresh binding reports owner loss and closed clients cannot delegate',async()=>{
    const f=await createRBridgeIpcFixture(),server=await f.start(),client=await connectRBridgeCoreIpcClient({root:f.root,expectedBinding:f.deployment,files:f.files});clients.push(client);await server.close();await expect(client.binding()).rejects.toThrow();await client.close();await expect(client.status('health-1',f.context)).rejects.toThrow();expect(f.calls).toHaveLength(0);
  });
});
