import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import type {RbridgeChatEffectCommandV1,RbridgeChatEffectResultV1,V3Scope} from '../src/domain/rbridgeEffectProtocol.js';

// Instrument real filesystem handles in a separate process; never replace journal contents with a fake store.
const mode=process.argv[2]!,root=process.argv[3]!;
const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]};
const {command,result}=fixture.vectors[0]!;
const scope:V3Scope={appId:command.request.appId,baseSha:command.request.baseSha,sessionId:command.request.sessionId,generation:command.request.generation};
const originalOpen=fs.open,originalRename=fs.rename;
let armed=false,renamed=false,parentSynced=false;
const eio=()=>Object.assign(Error('INJECTED_EIO'),{code:'EIO'});
fs.open=async(path,flags,fileMode)=>{
  const handle=await originalOpen(path,flags,fileMode),name=String(path);
  const originalSync=handle.sync.bind(handle),originalWrite=handle.writeFile.bind(handle),originalRead=handle.readFile.bind(handle);
  handle.sync=async()=>{
    if(name===root){if(mode==='parent-sync-failure')throw eio();parentSynced=true;}
    if(armed&&mode==='file-sync-failure'&&name.includes('.journal-'))throw eio();
    await originalSync();
  };
  handle.writeFile=async(...args)=>{if(armed&&mode==='write-failure'&&name.includes('.journal-'))throw eio();return originalWrite(...args);};
  handle.readFile=((...args:Parameters<typeof handle.readFile>)=>{if(armed&&renamed&&mode==='readback-failure'&&name===join(root,'v3-results','journal.json'))return Promise.reject(eio());return originalRead(...args);}) as typeof handle.readFile;
  return handle;
};
fs.rename=async(from,to)=>{
  if(armed&&mode==='rename-failure')throw eio();
  await originalRename(from,to);renamed=true;
};
syncBuiltinESMExports();
const {RbridgeEffectResultStoreV3}=await import('../src/nativeHost/rbridgeEffectResultStore.js');
const make=()=>new RbridgeEffectResultStoreV3({eventStoreRoot:root,scope,maxMessageBytes:65536});
try{
  const store=make();
  if(mode==='parent-sync-failure'){
    await assert.rejects(()=>store.reserve(command),/EIO|WRITE_UNCERTAIN/);
    console.log('FAULT_PROBE_PASS '+mode);
  }else{
    await store.reserve(command);
    if(mode==='parent-sync'){
      // A modeled power loss drops the child entry unless its containing directory was synchronized.
      assert.equal(parentSynced,true,'successful admission has no durable containing-directory entry');
    }else if(mode==='fifo-authority'||mode==='fifo-journal'){
      const path=join(root,'v3-results',mode==='fifo-authority'?'authority.json':'journal.json');
      await fs.unlink(path);execFileSync('/usr/bin/mkfifo',['-m','600',path],{timeout:1000});
      await assert.rejects(()=>make().replay(),/FILE_INVALID|READ_FAILED/);
    }else{
      armed=true;renamed=false;
      await assert.rejects(()=>store.record(result),/WRITE_UNCERTAIN/);
      await assert.rejects(()=>store.read(command.commandId),/STORE_FAULTED/);
      armed=false;
      const recovered=await make().read(command.commandId);
      assert.deepEqual(recovered?.command,command);
      assert.deepEqual(recovered?.result,mode==='readback-failure'?result:null);
    }
    console.log('FAULT_PROBE_PASS '+mode);
  }
}finally{fs.open=originalOpen;fs.rename=originalRename;syncBuiltinESMExports();}
