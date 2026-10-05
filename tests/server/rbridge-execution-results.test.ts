import {readFile,unlink,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {createRBridgeExecutionResults} from '../../src/server/rbridgeExecutionResults.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';
import {cleanupRBridgeTestStates,createRBridgeTestState} from '../fixtures/rbridge-core-state.js';

afterEach(cleanupRBridgeTestStates);
async function fixture(){const state=await createRBridgeTestState(),results=await createRBridgeExecutionResults({...state});return {...state,results};}
async function completed(f:Awaited<ReturnType<typeof fixture>>,value:{text:string}){
  const record=await f.running(),output=await f.serializer.run('read-1',()=>f.results.commit('read-1',value));
  const terminal=await f.transition(record,'TERMINAL',{outcome:'PASS',resultSha256:output.sha256,postconditions:[{name:'read-within-policy',status:'PASS',evidenceSha256:record.receipt.policy.policySha256},{name:'result-digest',status:'PASS',evidenceSha256:output.sha256}]});return {record:terminal,output};
}
describe('verified canonical execution results',()=>{
  it('verifies the whole result before serving any page',async()=>{
    const f=await fixture(),{record,output}=await completed(f,{text:'verified body'}),page=await f.results.page(record,0,8);
    expect(page).toMatchObject({status:'RESULT',resultSha256:output.sha256,cursor:0,nextCursor:8,eof:false,dataBase64:Buffer.from('{"text":').toString('base64')});
    await writeFile(join(f.root,'results','read-1.json'),'{"text":"verified bodX"}');await expect(f.results.page(record,0,8)).rejects.toThrow('RBRIDGE_CORE_RESULT_DIGEST_MISMATCH');
  });
  it('uses byte cursors across multibyte characters and proves EOF',async()=>{
    const f=await fixture(),{record}=await completed(f,{text:'Ž🙂'}),expected=Buffer.from('{"text":"Ž🙂"}');
    const page=await f.results.page(record,10,3);expect(page).toMatchObject({status:'RESULT',cursor:10,nextCursor:13,dataBase64:expected.subarray(10,13).toString('base64'),eof:false});
    const eof=await f.results.page(record,expected.length,32768);expect(eof).toMatchObject({status:'RESULT',cursor:expected.length,nextCursor:expected.length,dataBase64:'',eof:true});
    for(const [cursor,maxBytes] of [[-1,1],[expected.length+1,1],[0,32769],[0,0],[0,1.5]])await expect(f.results.page(record,cursor!,maxBytes!)).rejects.toThrow();
  });
  it('bounds canonical output including escaping and allows a valid large result',async()=>{
    const f=await fixture();await f.running();
    await f.serializer.run('read-1',async()=>{
      expect((await f.results.commit('read-1','a'.repeat(8388606))).bytes).toBe(8388608);
      await expect(f.results.commit('read-1','a'.repeat(8388607))).rejects.toThrow();
      expect((await f.results.commit('read-1','\\'.repeat(4194303))).bytes).toBe(8388608);
      await expect(f.results.commit('read-1','\\'.repeat(4194304))).rejects.toThrow();
    });
    expect((await readFile(join(f.root,'results','read-1.json'))).length).toBe(8388608);
  });
  it('never replaces terminal output and never exposes a missing or unverified result',async()=>{
    const f=await fixture(),pending=await f.running();expect(await f.results.page(pending,0,16)).toMatchObject({status:'NOT_READY'});
    const output=await f.serializer.run('read-1',()=>f.results.commit('read-1',{text:'original'})),terminal=await f.transition(pending,'TERMINAL',{outcome:'PASS',resultSha256:output.sha256});
    await expect(f.serializer.run('read-1',()=>f.results.commit('read-1',{text:'changed'}))).rejects.toThrow();
    expect(await readFile(join(f.root,'results','read-1.json'),'utf8')).toBe('{"text":"original"}');
    await unlink(join(f.root,'results','read-1.json'));await expect(f.results.page(terminal,0,16)).rejects.toThrow('RBRIDGE_CORE_RESULT_UNAVAILABLE');
  });
  it('retains failed result staging bytes without acknowledging output or changing the receipt',async()=>{
    const f=await fixture(),record=await f.running(),files=createRBridgeStateFiles({checkFilesystem:async()=>undefined,io:{syncFile:async()=>{throw new Error('result-fsync-failed');}}});
    const broken=await createRBridgeExecutionResults({...f,files});await expect(f.serializer.run('read-1',()=>broken.commit('read-1',{text:'new'}))).rejects.toThrow('result-fsync-failed');
    expect((await f.journal.get('read-1'))?.receipt).toEqual(record.receipt);expect(f.journal.capacity().resultBytes).toBe(Buffer.byteLength('{"text":"new"}'));expect((await readdir(join(f.root,'results'))).some(p=>p.endsWith('.stage'))).toBe(true);
  });
  it('rejects unsafe output and requires a dispatched allowed record',async()=>{
    const f=await fixture();await f.claim();await expect(f.serializer.run('read-1',()=>f.results.commit('read-1',{text:'too early'}))).rejects.toThrow();
    const current=(await f.journal.get('read-1'))!;let record=current;for(const phase of ['AUTHORIZED','STARTING','RUNNING'] as const)record=await f.transition(record,phase);
    await f.serializer.run('read-1',async()=>{await expect(f.results.commit('read-1',JSON.parse('{"nested":{"__proto__":1}}'))).rejects.toThrow();});
    expect(await readdir(join(f.root,'results'))).toEqual([]);
  });
});
