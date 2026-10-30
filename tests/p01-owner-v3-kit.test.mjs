import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {deriveP01Startup,verifyP01BuildProof} from '../scripts/p01-owner-v3-kit.mjs';
const config=await readFile('ops/p01-owner-generated/4786c8bd94d2/v3-peer-config.json','utf8');
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const tree='b'.repeat(40),appCommit='c'.repeat(40);
const commitRaw=Buffer.from('tree '+tree+'\nauthor Synthetic <synthetic@example.invalid> 0 +0000\ncommitter Synthetic <synthetic@example.invalid> 0 +0000\n\nSYNTHETIC SOURCE PROOF FIXTURE\n');
const canonicalCommit=createHash('sha1').update(Buffer.concat([Buffer.from('commit '+commitRaw.length+'\0'),commitRaw])).digest('hex');
const native=Buffer.alloc(1048576);native[0]=0x4d;native[1]=0x5a;
const metadata=JSON.stringify({schema:'RBRIDGE_NATIVE_HOST_WINDOWS_SEA_V1',status:'PASS',nodeVersion:'v22.23.2',postjectVersion:'1.0.0-alpha.6',sha256:sha(native),bytes:native.length});
function inputs(){return {sourceProof:{schema:'COCWIN_P01_CANONICAL_SOURCE_PROOF_V1',appCommit,canonicalCommit,tree,canonicalCommitBase64:commitRaw.toString('base64')},local:{appCommit,tree,clean:true},nativeProof:{schema:'COCWIN_P01_NATIVE_ARTIFACT_PROOF_V1',sourceCommit:canonicalCommit,sourceTree:tree,bytes:native.length,sha256:sha(native),metadataSha256:sha(metadata)},nativeBytes:native,metadataRaw:metadata};}
test('independently supplied canonical commit object binds matching local tree without equating commits',()=>{
 const result=verifyP01BuildProof(inputs());assert.deepEqual(result.source,{appCommit,canonicalCommit,tree});assert.notEqual(result.source.appCommit,result.source.canonicalCommit);
});
test('proof rejects dirty/local tree mismatch and forged canonical commit object',()=>{
 for(const mutate of [v=>{v.local.clean=false;},v=>{v.local.tree='d'.repeat(40);},v=>{v.local.appCommit='e'.repeat(40);},v=>{v.sourceProof.canonicalCommit='f'.repeat(40);},v=>{v.sourceProof.canonicalCommitBase64=Buffer.from('tree '+ 'e'.repeat(40)+'\n').toString('base64');},v=>{v.sourceProof.claimedVerified=true;}]){
 const value=inputs();mutate(value);assert.throws(()=>verifyP01BuildProof(value));
 }
});
test('Native artifact must independently bind same final canonical source and exact executable/metadata',()=>{
 for(const mutate of [v=>{v.nativeProof.sourceCommit=appCommit;},v=>{v.nativeProof.sourceTree='a'.repeat(40);},v=>{v.nativeBytes=Buffer.from(v.nativeBytes);v.nativeBytes[50]=1;},v=>{v.metadataRaw+='\n';},v=>{v.nativeProof.bytes--;},v=>{const m=JSON.parse(v.metadataRaw);m.sha256='a'.repeat(64);v.metadataRaw=JSON.stringify(m);v.nativeProof.metadataSha256=sha(v.metadataRaw);}]){
 const value=inputs();mutate(value);assert.throws(()=>verifyP01BuildProof(value));
 }
});
test('original exact Linux bytes provide identity only; target release and qualified capability are injected',()=>{
 const output=deriveP01Startup(config,canonicalCommit),startup=JSON.parse(output.raw);
 assert.equal(startup.releaseSha,canonicalCommit);assert.equal(startup.peer.releaseSha,canonicalCommit);assert.equal(sha(output.raw),output.sha256);
 assert.deepEqual(startup.scope,JSON.parse(config).scope);assert.equal(startup.peer.peerId,'peer-p01-3df7237d6ad64894cbeb');assert.equal(startup.peer.capabilities.at(-1),'CHAT_SCOPE_QUIESCENCE_V1');assert.deepEqual(startup.initialHistory,[]);
});
test('old Linux whitespace/preimage, old target release, or malformed target source cannot be adopted',()=>{
 for(const raw of [config+'\n',config.replace('peer-p01-','other-p01-')])assert.throws(()=>deriveP01Startup(raw,canonicalCommit));
 for(const release of ['931e02d6b771a351e8c4e4977cf25ebf82d12a13','bad','A'.repeat(40)])assert.throws(()=>deriveP01Startup(config,release));
});

test('portable extension build invocation uses standard Windows npm JavaScript CLI without a shell',async()=>{
 const kit=await import('../scripts/p01-owner-v3-kit.mjs');
 assert.deepEqual(kit.p01ExtensionBuildInvocation?.('win32','C:\\Program Files\\nodejs\\node.exe'),{file:'C:\\Program Files\\nodejs\\node.exe',args:['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js','run','build:extension'],shell:false});
});
test('portable extension build invocation preserves Linux npm lifecycle command',async()=>{
 const kit=await import('../scripts/p01-owner-v3-kit.mjs');
 assert.deepEqual(kit.p01ExtensionBuildInvocation?.('linux','/opt/node/bin/node'),{file:'npm',args:['run','build:extension'],shell:false});
});
