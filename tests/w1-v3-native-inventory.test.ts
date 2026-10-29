import {afterEach,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,realpath,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {RbridgeEffectResultStoreV3} from '../src/nativeHost/rbridgeEffectResultStore.js';
import {canonicalDigest,canonicalJson,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,type V3Scope} from '../src/domain/rbridgeEffectProtocol.js';

interface Inventory {schema:'RBRIDGE_NATIVE_SCOPE_RESULT_INVENTORY_V1';scope:V3Scope;entryCount:number;unresolvedCount:number;entriesSha256:string;sha256:string}
interface InventoryStore {readScopeInventory(scope:V3Scope):Promise<Inventory>}
const fixture=JSON.parse(readFileSync(new URL('./fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]};
const bind=fixture.vectors[0]!;
const scope:V3Scope={appId:bind.command.request.appId,baseSha:bind.command.request.baseSha,sessionId:bind.command.request.sessionId,generation:bind.command.request.generation};
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function root(){const path=await realpath(await mkdtemp(join(tmpdir(),'rbridge-native-inventory-')));roots.push(path);return path;}
function store(path:string,current=scope){return new RbridgeEffectResultStoreV3({eventStoreRoot:path,scope:current,maxMessageBytes:65536});}
async function inventory(s:RbridgeEffectResultStoreV3,current:V3Scope=scope):Promise<Inventory>{
  expect(typeof (s as unknown as Partial<InventoryStore>).readScopeInventory,'missing scoped retained-result inventory').toBe('function');
  return (s as unknown as InventoryStore).readScopeInventory(current);
}
async function command(id:string,action:'EXECUTE'|'RECONCILE'='EXECUTE',request=bind.command.request):Promise<RbridgeChatEffectCommandV1>{
  const body={schema:'RBRIDGE_CHAT_EFFECT_COMMAND_V1' as const,commandId:id,action,issuedAt:'2026-10-29T21:20:00.000Z',request:structuredClone(request)};
  return {...body,commandSha256:await canonicalDigest(body)};
}
async function result(c:RbridgeChatEffectCommandV1,state:RbridgeChatEffectResultV1['state']):Promise<RbridgeChatEffectResultV1>{
  const r=c.request,body={schema:'RBRIDGE_CHAT_EFFECT_RESULT_V1' as const,commandId:c.commandId,commandSha256:c.commandSha256,sessionId:r.sessionId,generation:r.generation,attemptId:r.attemptId,effectId:r.effectId,requestDigest:r.requestDigest,completedAt:'2026-10-29T21:20:01.000Z',state,receipt:state==='VERIFIED'?bind.result.receipt:null,reason:state==='VERIFIED'?null:'TEST_RETAINED_OUTCOME'};
  return {...body,resultSha256:await canonicalDigest(body)};
}
async function retain(s:RbridgeEffectResultStoreV3,c:RbridgeChatEffectCommandV1,state:RbridgeChatEffectResultV1['state']|null){
  await s.reserve(c);if(state!==null)await s.record(await result(c,state));
}
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
async function originals(path:string){return Promise.all(['authority.json','journal.json'].map(name=>readFile(join(path,'v3-results',name))));}

describe('native scoped retained-result inventory',()=>{
  it('observes an empty store without manufacturing journal or authority',async()=>{
    const path=await root(),s=store(path),view=await inventory(s);
    expect(view).toMatchObject({schema:'RBRIDGE_NATIVE_SCOPE_RESULT_INVENTORY_V1',scope,entryCount:0,unresolvedCount:0,entriesSha256:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'});
    const {sha256,...body}=view;expect(sha256).toBe(hash(body));
    for(const name of ['authority.json','journal.json'])await expect(stat(join(path,'v3-results',name))).rejects.toMatchObject({code:'ENOENT'});
    expect(Object.keys(view).sort()).toEqual(['schema','scope','entryCount','unresolvedCount','entriesSha256','sha256'].sort());
  });
  it('includes a null reservation across reopen while preserving original bytes',async()=>{
    const path=await root(),c=await command('inventory-null'),s=store(path);await s.reserve(c);const before=await originals(path);
    const view=await inventory(store(path));expect(view.entryCount).toBe(1);expect(view.unresolvedCount).toBe(1);
    expect(view.entriesSha256).toBe(hash([{command:c,result:null,resolvedByCommandId:null}]));
    expect(await originals(path)).toEqual(before);expect((await store(path).read(c.commandId))?.result).toBeNull();
  });
  it.each(['VERIFIED','FAILED_SAFE'] as const)('recognizes direct %s evidence without claiming capture or quiescence',async state=>{
    const path=await root(),s=store(path),c=await command('inventory-terminal');await retain(s,c,state);
    const before=await originals(path),view=await inventory(store(path));
    expect(view.entryCount).toBe(1);expect(view.unresolvedCount).toBe(0);expect(await originals(path)).toEqual(before);
  });
  it.each(['BLOCKED','UNCERTAIN','APPLIED_UNVERIFIED'] as const)('retains %s as unresolved',async state=>{
    const path=await root(),s=store(path);await retain(s,await command('inventory-unresolved'),state);
    expect((await inventory(s)).unresolvedCount).toBe(1);
  });
  it.each(['VERIFIED','FAILED_SAFE'] as const)('uses genuine matching terminal RECONCILE %s evidence without replacing history',async state=>{
    const path=await root(),s=store(path),c=await command('inventory-original'),reconcile=await command('inventory-reconcile','RECONCILE');
    await retain(s,c,'UNCERTAIN');await retain(s,reconcile,state);const before=await originals(path);
    const view=await inventory(store(path));expect(view.entryCount).toBe(2);expect(view.unresolvedCount).toBe(0);
    expect(view.entriesSha256).toBe(hash([{command:c,result:await result(c,'UNCERTAIN'),resolvedByCommandId:reconcile.commandId},{command:reconcile,result:await result(reconcile,state),resolvedByCommandId:reconcile.commandId}]));
    expect(await originals(path)).toEqual(before);expect((await store(path).read(c.commandId))?.result?.state).toBe('UNCERTAIN');
  });
  it('does not let another terminal EXECUTE resolve a null reservation',async()=>{
    const path=await root(),s=store(path);await retain(s,await command('inventory-null'),null);await retain(s,await command('inventory-terminal'),'FAILED_SAFE');
    expect((await inventory(s)).unresolvedCount).toBe(1);
  });
  it('requires full request equality for reconciliation',async()=>{
    const path=await root(),s=store(path);await retain(s,await command('inventory-original'),null);
    const other=structuredClone(bind.command.request);other.payload.target.conversationGeneration++;const {requestDigest,...body}=other;void requestDigest;other.requestDigest=await canonicalDigest(body);
    expect(other.effectId).toBe(bind.command.request.effectId);
    await retain(s,await command('inventory-other-reconcile','RECONCILE',other),'FAILED_SAFE');
    expect((await inventory(s)).unresolvedCount).toBe(1);
  });
  it.each(['BLOCKED','UNCERTAIN','APPLIED_UNVERIFIED'] as const)('does not let a nonterminal %s RECONCILE resolve history',async state=>{
    const path=await root(),s=store(path);await retain(s,await command('inventory-original'),null);await retain(s,await command('inventory-reconcile','RECONCILE'),state);
    expect((await inventory(s)).unresolvedCount).toBe(2);
  });
  it('digests full retained evidence deterministically independent of reservation order',async()=>{
    const a=store(await root()),b=store(await root()),first=await command('inventory-a'),last=await command('inventory-z');
    await retain(a,last,'UNCERTAIN');await retain(a,first,null);await retain(b,first,null);await retain(b,last,'UNCERTAIN');
    const left=await inventory(a),right=await inventory(b);expect(left).toEqual(right);
    await b.record(await result(first,'FAILED_SAFE'));expect((await inventory(b)).entriesSha256).not.toBe(left.entriesSha256);
  });
  it('filters retained old generations while rejecting a caller-selected foreign scope',async()=>{
    const path=await root(),old=store(path);await retain(old,await command('inventory-old'),null);
    const current={...scope,generation:'223e4567-e89b-42d3-a456-426614174000'},newer=store(path,current);
    const view=await inventory(newer,current);expect(view.entryCount).toBe(0);expect(view.unresolvedCount).toBe(0);
    await expect(inventory(newer,scope)).rejects.toThrow('RBRIDGE_NATIVE_RESULT_SCOPE_MISMATCH');
    expect((await inventory(store(path))).unresolvedCount).toBe(1);
  });
  it('rejects every foreign scope field and extra fields without changing history',async()=>{
    const path=await root(),s=store(path);await s.reserve(bind.command);const before=await originals(path);
    expect((await inventory(s)).entryCount).toBe(1);
    for(const other of [{...scope,appId:'foreign'},{...scope,baseSha:'f'.repeat(40)},{...scope,sessionId:'exta-'+'f'.repeat(32)},{...scope,generation:'223e4567-e89b-42d3-a456-426614174000'},{...scope,root:'/foreign'}]){
      await expect(inventory(s,other as V3Scope)).rejects.toThrow();
    }
    expect(await originals(path)).toEqual(before);
  });
  it('returns detached scope data and preserves corrupt-history rejection',async()=>{
    const path=await root(),s=store(path);await s.reserve(bind.command);
    const view=await inventory(s);view.scope.appId='mutated';expect((await inventory(s)).scope).toEqual(scope);
    const {writeFile}=await import('node:fs/promises');await writeFile(join(path,'v3-results','journal.json'),'{}\n',{mode:0o600});
    await expect(inventory(store(path))).rejects.toThrow('RBRIDGE_NATIVE_RESULT_JOURNAL_INVALID');
  });
});
