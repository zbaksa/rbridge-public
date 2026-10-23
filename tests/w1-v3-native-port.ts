import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ExtensionNativePortLinkV1} from '../src/extension/nativePortServiceWorker.js';
import {REQUIRED_RBRIDGE_CAPABILITIES,type RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';
import {canonicalDigest,V3_CAPABILITIES,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1} from '../src/domain/rbridgeEffectProtocol.js';

const fixture=JSON.parse(await readFile('tests/fixtures/rbridge-cocwin-contract-v3.json','utf8')) as {vectors:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]};
const vector=fixture.vectors[0]!;
type EffectLink=ExtensionNativePortLinkV1&{sendEffectResult(command:RbridgeChatEffectCommandV1,result:unknown):Promise<void>};
const drain=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
async function until(predicate:()=>boolean){for(let i=0;i<300;i++){if(predicate())return;await drain();}assert.ok(predicate(),'bounded observation did not arrive');}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
class Event<T>{listeners:((value:T)=>void)[]=[];addListener(fn:(value:T)=>void){this.listeners.push(fn);}emit(value:T){for(const fn of this.listeners)fn(value);}}
async function distinctCommand(id:string){const {commandSha256,...body}=structuredClone(vector.command);void commandSha256;body.commandId=id;return {...body,commandSha256:await canonicalDigest(body)};}
function setup(options:{minor?:number;capabilities?:string[];handler?:false|((command:RbridgeChatEffectCommandV1)=>void|Promise<void>)}={}){
  const received:RbridgeChatEffectCommandV1[]=[],reads:unknown[]=[],errors:Error[]=[],posted:unknown[]=[];
  const ports:{inbound:Event<unknown>;disconnected:Event<void>}[]=[];
  const hello:RbridgeChatHelloV1={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:options.minor??1,
    releaseSha:'a'.repeat(40),maxMessageBytes:65536,capabilities:options.capabilities??[...V3_CAPABILITIES],
    browserInstanceId:'chrome-main',browserProfileId:'profile-main',nativeHostVersion:'fixture-native'};
  const hooks={onProtocolError:(error:Error)=>{errors.push(error);},onServerCommand:(command:unknown)=>{reads.push(command);},
    ...(options.handler===false?{}:{onServerEffectCommand:(command:RbridgeChatEffectCommandV1)=>{
      received.push(command);return typeof options.handler==='function'?options.handler(command):undefined;
    }})};
  const link=new ExtensionNativePortLinkV1({connectNative:()=>{
    const inbound=new Event<unknown>(),disconnected=new Event<void>();ports.push({inbound,disconnected});
    return {postMessage:(value:unknown)=>{posted.push(structuredClone(value));},disconnect:()=>{},onMessage:inbound,onDisconnect:disconnected};
  }},hello,hooks) as EffectLink;
  link.connect();
  const emit=(value:unknown)=>ports.at(-1)!.inbound.emit(value);
  const negotiate=async()=>{emit(hello);await until(()=>link.protocolReady||errors.length>0);assert.equal(link.protocolReady,true);};
  return {link,hello,emit,negotiate,received,reads,errors,posted,ports};
}
function holdDigest(){
  const gate=deferred(),entered=deferred();let first=true,wasEntered=false;
  const original=globalThis.crypto.subtle.digest;
  globalThis.crypto.subtle.digest=async function(algorithm,data){if(first){first=false;wasEntered=true;entered.resolve();await gate.promise;}return await original.call(this,algorithm,data);};
  return {release:gate.resolve,entered:()=>wasEntered,restore:()=>{gate.resolve();globalThis.crypto.subtle.digest=original;}};
}
const cases:[string,()=>Promise<void>][]=[];
const test=(name:string,fn:()=>Promise<void>)=>cases.push([name,fn]);
test('negotiated V3 command and exact correlated result',async()=>{
  const h=setup();await h.negotiate();h.emit(vector.command);await until(()=>h.received.length>0||h.errors.length>0);
  assert.deepEqual(h.received,[vector.command]);await h.link.sendEffectResult(h.received[0]!,vector.result);
  assert.deepEqual(h.posted.at(-1),vector.result);assert.equal(h.errors.length,0);
});
test('minor0 cannot deliver V3',async()=>{
  const h=setup({minor:0,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES]});await h.negotiate();h.emit(vector.command);
  await until(()=>h.errors.length>0);assert.equal(h.received.length,0);assert.equal(h.link.protocolReady,false);
});
test('missing full V3 capability cannot deliver',async()=>{
  const h=setup({capabilities:V3_CAPABILITIES.filter(c=>c!=='CHAT_ASSISTANT_TURN_CAPTURE_V2')});await h.negotiate();h.emit(vector.command);
  await until(()=>h.errors.length>0);assert.equal(h.received.length,0);assert.equal(h.link.protocolReady,false);
});
test('absent effect handler fails closed',async()=>{
  const h=setup({handler:false});await h.negotiate();h.emit(vector.command);await until(()=>h.errors.length>0);
  assert.equal(h.received.length,0);assert.equal(h.link.protocolReady,false);
});
test('bad digest is never delivered',async()=>{
  const h=setup();await h.negotiate();h.emit({...vector.command,commandSha256:'f'.repeat(64)});await until(()=>h.errors.length>0);
  assert.equal(h.received.length,0);assert.equal(h.posted.length,1);
});
test('unmatched result is never posted',async()=>{
  const h=setup();await h.negotiate();h.emit(vector.command);await until(()=>h.received.length>0||h.errors.length>0);
  await assert.rejects(()=>h.link.sendEffectResult(h.received[0]!,{...vector.result,commandId:'wrong'}),/AGENT_RESPONSE_CORRELATION_MISMATCH/);
  assert.equal(h.posted.length,1);
});
test('unnegotiated result is refused',async()=>{
  const h=setup();await assert.rejects(()=>h.link.sendEffectResult(vector.command,vector.result),/RBRIDGE_PROTOCOL_NOT_NEGOTIATED/);assert.equal(h.posted.length,1);
});
test('disconnect during result validation fences output',async()=>{
  const h=setup();await h.negotiate();h.emit(vector.command);await until(()=>h.received.length>0||h.errors.length>0);
  const work=h.link.sendEffectResult(h.received[0]!,vector.result);h.link.disconnect();
  await assert.rejects(()=>work,/RBRIDGE_(?:NATIVE_PORT_DISCONNECTED|PEER_CONNECTION_CHANGED)/);assert.equal(h.posted.length,1);
});
test('new HELLO fences old validation without poisoning new negotiation',async()=>{
  const fresh=await distinctCommand('fresh-after-hello'),h=setup();await h.negotiate();const gate=holdDigest();
  try{h.emit(vector.command);await until(()=>gate.entered()||h.errors.length>0);assert.equal(gate.entered(),true);
    h.emit(h.hello);await drain();assert.equal(h.link.protocolReady,true);h.emit(fresh);gate.release();
    await until(()=>h.received.some(c=>c.commandId===fresh.commandId)||h.errors.length>0);
    assert.deepEqual(h.received,[fresh]);assert.equal(h.link.protocolReady,true);assert.equal(h.errors.length,0);
  }finally{gate.restore();}
});
test('reconnect fences old validation and old failures',async()=>{
  const fresh=await distinctCommand('fresh-after-reconnect'),h=setup();await h.negotiate();const gate=holdDigest();
  try{h.emit(vector.command);await until(()=>gate.entered()||h.errors.length>0);assert.equal(gate.entered(),true);
    h.ports[0]!.disconnected.emit();h.link.connect();await h.negotiate();h.emit(fresh);gate.release();
    await until(()=>h.received.some(c=>c.commandId===fresh.commandId)||h.errors.length>0);
    assert.deepEqual(h.received,[fresh]);assert.equal(h.link.protocolReady,true);
  }finally{gate.restore();}
});
test('ordered validation does not wait for browser work or block V1 reads',async()=>{
  const second=await distinctCommand('second-ordered'),browser=deferred();const h=setup({handler:c=>c.commandId===vector.command.commandId?browser.promise:undefined});
  await h.negotiate();const gate=holdDigest();
  try{h.emit(vector.command);await until(()=>gate.entered()||h.errors.length>0);assert.equal(gate.entered(),true);h.emit(second);
    h.emit({schema:'RBRIDGE_CHAT_COMMAND_V1',commandId:'read-pending',action:'READ_STATE',sessionId:vector.command.request.sessionId,
      generation:vector.command.request.generation,attemptId:null,effectId:null,requestDigest:'a'.repeat(64),issuedAt:vector.command.issuedAt,payload:{}});
    await until(()=>h.reads.length>0||h.errors.length>0);assert.equal(h.reads.length,1);assert.equal(h.received.length,0);
    gate.release();await until(()=>h.received.length===2||h.errors.length>0);
    assert.deepEqual(h.received.map(c=>c.commandId),[vector.command.commandId,second.commandId]);
  }finally{browser.resolve();gate.restore();}
});
test('input snapshot survives caller mutation',async()=>{
  const h=setup();await h.negotiate();const input=structuredClone(vector.command);h.emit(input);input.commandId='mutated-after-arrival';
  await until(()=>h.received.length>0||h.errors.length>0);assert.deepEqual(h.received,[vector.command]);
});
test('oversize and retained-queue overflow fail closed',async()=>{
  const h=setup();await h.negotiate();h.emit({...vector.command,padding:'x'.repeat(70000)});await until(()=>h.errors.length>0);
  assert.match(h.errors[0]!.message,/OUTPUT_BUDGET_EXCEEDED/);assert.equal(h.received.length,0);
  const q=setup();await q.negotiate();for(let i=0;i<129;i++)q.emit(vector.command);await until(()=>q.errors.length>0);await drain();
  assert.ok(q.errors.some(e=>e.message==='RBRIDGE_V3_BACKPRESSURE_EXCEEDED'));assert.equal(q.received.length,0);assert.equal(q.link.protocolReady,false);
});
test('late handler failure cannot clear newer negotiation',async()=>{
  let reject!:()=>void;const late=new Promise<void>((_resolve,fail)=>{reject=()=>fail(Error('late-fixture-failure'));});
  const h=setup({handler:()=>late});await h.negotiate();h.emit(vector.command);await until(()=>h.received.length>0||h.errors.length>0);
  assert.equal(h.received.length,1);h.emit(h.hello);await drain();reject();await drain();await drain();assert.equal(h.link.protocolReady,true);assert.equal(h.errors.length,0);
});
test('V3 still denies legacy mutation and sticky downgrade',async()=>{
  const h=setup();await h.negotiate();h.emit({schema:'RBRIDGE_CHAT_COMMAND_V1',commandId:'legacy-bind',action:'BIND_TARGET',
    sessionId:vector.command.request.sessionId,generation:vector.command.request.generation,attemptId:null,effectId:null,
    requestDigest:'a'.repeat(64),issuedAt:vector.command.issuedAt,payload:{windowId:10,tabId:20,origin:'https://chatgpt.com',projectId:'g-p-fixture',conversationId:'fixture',conversationGeneration:1}});
  await until(()=>h.errors.length>0);assert.equal(h.reads.length,0);h.emit({...h.hello,protocolMinor:0});await drain();
  assert.equal(h.link.protocolReady,false);assert.ok(h.errors.some(e=>e.message==='RBRIDGE_V3_DOWNGRADE_DENIED'));
});
test('result without an admitted original command is refused',async()=>{
  const h=setup();await h.negotiate();await assert.rejects(()=>h.link.sendEffectResult(vector.command,vector.result),/RBRIDGE_EFFECT_COMMAND_NOT_RECEIVED/);
  assert.equal(h.posted.length,1);
});
test('handler mutation cannot replace the admitted original correlation',async()=>{
  const h=setup();await h.negotiate();h.emit(vector.command);await until(()=>h.received.length>0||h.errors.length>0);
  const admitted=h.received[0]!;const {commandSha256,...changed}=admitted;void commandSha256;changed.commandId='handler-mutated';
  Object.assign(admitted,{...changed,commandSha256:await canonicalDigest(changed)});
  const {resultSha256,...result}=vector.result;void resultSha256;result.commandId=admitted.commandId;result.commandSha256=admitted.commandSha256;
  const modified={...result,resultSha256:await canonicalDigest(result)};
  await assert.rejects(()=>h.link.sendEffectResult(admitted,modified),/AGENT_RESPONSE_CORRELATION_MISMATCH/);assert.equal(h.posted.length,1);
});
for(const transition of ['HELLO','RECONNECT'] as const)test('late handler result is fenced after '+transition,async()=>{
  const browser=deferred();let done=false,reason='';let h!:ReturnType<typeof setup>;
  h=setup({handler:async command=>{await browser.promise;try{await h.link.sendEffectResult(command,vector.result);}catch(error){reason=String(error);}finally{done=true;}}});
  await h.negotiate();h.emit(vector.command);await until(()=>h.received.length>0||h.errors.length>0);assert.equal(h.received.length,1);
  if(transition==='RECONNECT'){h.ports[0]!.disconnected.emit();h.link.connect();}
  await h.negotiate();browser.resolve();await until(()=>done);
  assert.equal(h.posted.filter(v=>(v as {schema:string}).schema==='RBRIDGE_CHAT_EFFECT_RESULT_V1').length,0);
  assert.match(reason,/RBRIDGE_PEER_CONNECTION_CHANGED/);assert.equal(h.link.protocolReady,true);
  h.emit(vector.command);await until(()=>h.received.length===2||h.errors.length>0);
  await until(()=>h.posted.some(v=>(v as {schema:string}).schema==='RBRIDGE_CHAT_EFFECT_RESULT_V1'));
  assert.equal(h.posted.filter(v=>(v as {schema:string}).schema==='RBRIDGE_CHAT_EFFECT_RESULT_V1').length,1);
});
let failed=0;
for(const [name,run] of cases){try{await run();console.log('PASS V3_NATIVE_PORT '+name);}catch(error){failed++;console.error('FAIL V3_NATIVE_PORT '+name+': '+String(error));}}
console.log(JSON.stringify({schema:'RBRIDGE_V3_NATIVE_PORT_TESTS_R1',passed:cases.length-failed,failed,total:cases.length,actualBrowserExecution:'NOT_RUN'}));
if(failed)process.exitCode=1;
