import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chmod,link,lstat,mkdtemp,readFile,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {canonicalDigest,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,type V3Scope} from '../src/domain/rbridgeEffectProtocol.js';

// Real filesystem behavior, with bounded child probes for durability barriers and I/O faults.
interface ResultStore {
  reserve(command:unknown):Promise<RbridgeChatEffectCommandV1>;
  record(result:unknown):Promise<RbridgeChatEffectResultV1>;
  read(commandId:string):Promise<{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1|null}|null>;
  replay():Promise<RbridgeChatEffectResultV1[]>;
}
interface Options {eventStoreRoot:string;scope:V3Scope;maxMessageBytes:number;maxRecords?:number;maxBytes?:number}
const modulePath='../src/nativeHost/rbridgeEffectResultStore.js';
const implementation=await import(modulePath).catch(()=>null) as {RbridgeEffectResultStoreV3:new(options:Options)=>ResultStore}|null;
const fixture=JSON.parse(readFileSync(new URL('../../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1;result:RbridgeChatEffectResultV1}[]};
const bind=fixture.vectors[0]!,send=fixture.vectors[1]!;
const scope:V3Scope={appId:bind.command.request.appId,baseSha:bind.command.request.baseSha,sessionId:bind.command.request.sessionId,generation:bind.command.request.generation};
function store(root:string,extra:Partial<Options>={}):ResultStore {
  assert.ok(implementation?.RbridgeEffectResultStoreV3,'RBRIDGE_NATIVE_V3_RESULT_STORE_NOT_IMPLEMENTED');
  return new implementation.RbridgeEffectResultStoreV3({eventStoreRoot:root,scope:structuredClone(scope),maxMessageBytes:65536,...extra});
}
async function withRoot(fn:(root:string)=>Promise<void>):Promise<void>{const root=await mkdtemp(join(tmpdir(),'rbridge-native-v3-result-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
async function changedCommand(source:RbridgeChatEffectCommandV1):Promise<RbridgeChatEffectCommandV1>{const {commandSha256,...body}=structuredClone(source);void commandSha256;body.issuedAt='2026-10-01T21:00:00.000Z';return {...body,commandSha256:await canonicalDigest(body)};}
async function changedResult(source:RbridgeChatEffectResultV1):Promise<RbridgeChatEffectResultV1>{const {resultSha256,...body}=structuredClone(source);void resultSha256;body.state='BLOCKED';body.receipt=null;body.reason='TEST_DIFFERENT_OUTCOME';return {...body,resultSha256:await canonicalDigest(body)};}
let passed=0,failed=0,skipped=0;
async function test(name:string,fn:()=>Promise<void>):Promise<void>{try{await fn();passed++;console.log('PASS V3_NATIVE_RESULT '+name);}catch(error){failed++;console.error('FAIL V3_NATIVE_RESULT '+name+': '+String(error));}}
const awaitableCommand=await changedCommand(bind.command);

await test('native_restart_preserves_reserved_command_and_complete_result',()=>withRoot(async root=>{
  const first=store(root);await first.reserve(bind.command);
  assert.deepEqual(await store(root).read(bind.command.commandId),{command:bind.command,result:null});
  await first.record(bind.result);
  const reopened=store(root);assert.deepEqual(await reopened.read(bind.command.commandId),{command:bind.command,result:bind.result});
  assert.deepEqual(await reopened.replay(),[bind.result]);
}));
await test('unreserved_result_cannot_become_durable_delivery',()=>withRoot(async root=>{
  await assert.rejects(()=>store(root).record(bind.result),/RBRIDGE_NATIVE_RESULT_COMMAND_MISSING/);
  assert.deepEqual(await store(root).replay(),[]);
}));
await test('exact_replay_is_idempotent_and_changed_command_id_collision_is_closed',()=>withRoot(async root=>{
  const s=store(root);await s.reserve(bind.command);await s.record(bind.result);
  assert.deepEqual(await s.reserve(bind.command),bind.command);assert.deepEqual(await s.record(bind.result),bind.result);
  await assert.rejects(()=>s.reserve(awaitableCommand),/REQUEST_ID_COLLISION/);
  assert.deepEqual(await store(root).replay(),[bind.result]);
}));
await test('changed_result_never_overwrites_original_observation',()=>withRoot(async root=>{
  const s=store(root);await s.reserve(bind.command);await s.record(bind.result);const other=await changedResult(bind.result);
  await assert.rejects(()=>s.record(other),/REQUEST_ID_COLLISION/);assert.deepEqual((await store(root).read(bind.command.commandId))?.result,bind.result);
}));
await test('forged_or_mismatched_result_digest_does_not_commit',()=>withRoot(async root=>{
  const s=store(root);await s.reserve(bind.command);
  await assert.rejects(()=>s.record({...bind.result,resultSha256:'0'.repeat(64)}),/DIGEST_MISMATCH/);
  await assert.rejects(()=>s.record({...bind.result,commandId:send.command.commandId}),/COMMAND_MISSING/);
  assert.equal((await store(root).read(bind.command.commandId))?.result,null);
}));
await test('shared_root_instances_do_not_lose_concurrent_reservations',()=>withRoot(async root=>{
  const a=store(root),b=store(root);await Promise.all([a.reserve(bind.command),b.reserve(send.command)]);
  await Promise.all([a.record(bind.result),b.record(send.result)]);
  const rows=await store(root).replay();assert.equal(rows.length,2);assert.ok(rows.some(r=>r.resultSha256===bind.result.resultSha256));assert.ok(rows.some(r=>r.resultSha256===send.result.resultSha256));
}));
await test('caller_mutation_and_returned_copies_do_not_change_durable_identity',()=>withRoot(async root=>{
  const s=store(root),command=structuredClone(bind.command),result=structuredClone(bind.result);const pending=s.reserve(command);command.issuedAt='2026-10-01T21:00:00.000Z';await pending;
  const recorded=s.record(result);result.completedAt='2026-10-01T22:00:00.000Z';await recorded;
  const first=(await s.read(bind.command.commandId))!;first.command.issuedAt='altered';first.result!.completedAt='altered';
  const replay=await s.replay();replay[0]!.reason='altered';assert.deepEqual(await store(root).read(bind.command.commandId),{command:bind.command,result:bind.result});
}));
await test('cross_app_owner_and_current_scope_reads_are_separated',()=>withRoot(async root=>{
  const s=store(root);await s.reserve(bind.command);await s.record(bind.result);
  await assert.rejects(()=>store(root,{scope:{...scope,appId:'other-app'}}).read(bind.command.commandId),/OWNER_MISMATCH/);
  const newer=store(root,{scope:{...scope,generation:'223e4567-e89b-42d3-a456-426614174000'}});
  assert.equal(await newer.read(bind.command.commandId),null);await assert.rejects(()=>newer.reserve(bind.command),/SCOPE_MISMATCH/);
  assert.deepEqual(await newer.replay(),[bind.result]);
}));
await test('missing_committed_journal_is_not_reinitialized_after_restart',()=>withRoot(async root=>{
  const s=store(root);await s.reserve(bind.command);await s.record(bind.result);await unlink(join(root,'v3-results','journal.json'));
  await assert.rejects(()=>store(root).read(bind.command.commandId),/JOURNAL_MISSING/);
  await assert.rejects(()=>store(root).reserve(send.command),/JOURNAL_MISSING/);
}));
await test('corrupt_or_noncanonical_journal_has_no_replay',()=>withRoot(async root=>{
  const s=store(root);await s.reserve(bind.command);await s.record(bind.result);const path=join(root,'v3-results','journal.json');const bytes=await readFile(path,'utf8');
  await writeFile(path,bytes.slice(0,-2),{mode:0o600});await assert.rejects(()=>store(root).replay(),/JOURNAL_INVALID/);
  await writeFile(path,bytes+' ',{mode:0o600});await assert.rejects(()=>store(root).replay(),/JOURNAL_INVALID/);
}));
await test('corrupt_authority_cannot_relabel_durable_results',()=>withRoot(async root=>{
  const s=store(root);await s.reserve(bind.command);await writeFile(join(root,'v3-results','authority.json'),'{}\n',{mode:0o600});
  await assert.rejects(()=>store(root).record(bind.result),/AUTHORITY_INVALID/);assert.equal(await readFile(join(root,'v3-results','authority.json'),'utf8'),'{}\n');
}));
await test('bounded_record_capacity_preserves_existing_command',()=>withRoot(async root=>{
  const s=store(root,{maxRecords:1});await s.reserve(bind.command);await s.record(bind.result);
  await assert.rejects(()=>s.reserve(send.command),/RECORD_LIMIT/);assert.deepEqual(await store(root,{maxRecords:1}).replay(),[bind.result]);
}));
await test('small_peer_budget_rejects_complete_oversize_command_without_partial_record',()=>withRoot(async root=>{
  const text=JSON.stringify(send.command);assert.ok(Buffer.byteLength(text)<4096);
  const {commandSha256,...body}=structuredClone(send.command);void commandSha256;
  if(body.request.effectKind!=='RBRIDGE_SEND')throw Error('FIXTURE_SEND_REQUIRED');
  body.request.payload.text='x'.repeat(6000);const {requestDigest,...request}=body.request;void requestDigest;body.request={...request,requestDigest:await canonicalDigest(request)};
  const command={...body,commandSha256:await canonicalDigest(body)};const s=store(root,{maxMessageBytes:4096});
  await assert.rejects(()=>s.reserve(command),/BUDGET|LARGE/);assert.equal(await s.read(command.commandId),null);
}));
await test('unsafe_read_id_and_invalid_configuration_never_select_a_path',()=>withRoot(async root=>{
  const s=store(root);await assert.rejects(()=>s.read('../journal.json'),/COMMAND_ID_INVALID/);
  for(const extra of [{maxMessageBytes:4095},{maxMessageBytes:65537},{maxRecords:0},{maxBytes:4095}])assert.throws(()=>store(root,extra),/CONFIG_INVALID/);
  assert.throws(()=>store(root,{eventStoreRoot:root+'/../escape'}),/ROOT_INVALID/);
}));
await test('protocol_valid_dotted_and_maximum_length_app_scopes_are_accepted',()=>withRoot(async root=>{
  for(const appId of ['cocwin.demo','a'.repeat(96)]){
    const command=structuredClone(bind.command);command.request.appId=appId;
    const {requestDigest,...request}=command.request;void requestDigest;command.request.requestDigest=await canonicalDigest(request);
    const {commandSha256,...body}=command;void commandSha256;command.commandSha256=await canonicalDigest(body);
    const child=join(root,appId);await import('node:fs/promises').then(fs=>fs.mkdir(child,{mode:0o700}));
    const s=store(child,{scope:{...scope,appId}});await s.reserve(command);assert.deepEqual((await s.read(command.commandId))?.command,command);
  }
}));
await test('protocol_invalid_leading_app_punctuation_is_rejected',()=>withRoot(async root=>{
  for(const appId of ['-cocwin','_cocwin','.cocwin','a'.repeat(97)])assert.throws(()=>store(root,{scope:{...scope,appId}}),/CONFIG_INVALID/);
}));
await test('missing_event_store_parent_is_not_recursively_created',()=>withRoot(async root=>{
  const parent=join(root,'missing','event');await assert.rejects(()=>store(parent).reserve(bind.command),/ENOENT|ROOT_INVALID/);
  await assert.rejects(()=>lstat(join(root,'missing')),/ENOENT/);
}));
await test('reservation_leaves_bounded_result_headroom_before_admission',()=>withRoot(async root=>{
  await assert.rejects(()=>store(root,{maxBytes:4096,maxMessageBytes:4096}).reserve(bind.command),/BYTE_LIMIT/);
  const s=store(root,{maxBytes:12000,maxMessageBytes:4096});
  await s.reserve(bind.command);await s.reserve(send.command);
  await assert.rejects(()=>s.reserve(fixture.vectors[2]!.command),/BYTE_LIMIT/);
  await s.record(bind.result);await s.record(send.result);
  assert.equal((await s.replay()).length,2);assert.equal(await s.read(fixture.vectors[2]!.command.commandId),null);
}));
function childProbe(root:string,mode:string):void {
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('./native-result-fault-case.js',import.meta.url)),mode,root],{encoding:'utf8',timeout:8000,maxBuffer:1024*1024});
  assert.equal(run.signal,null,'bounded child fault probe timed out: '+mode);
  assert.equal(run.status,0,(run.stdout??'')+(run.stderr??''));
  assert.match(run.stdout,/FAULT_PROBE_PASS/);
}
for(const mode of ['readback-failure','write-failure','rename-failure','file-sync-failure']){
  await test('failed_'+mode+'_never_returns_delivery_and_latches_instance',()=>withRoot(async root=>childProbe(root,mode)));
}
if(process.platform==='win32'){skipped+=8;console.log('SKIP V3_NATIVE_RESULT POSIX mode/symlink/hardlink/directory-sync/FIFO probes require Linux');}
else {
  await test('unsafe_parent_permissions_are_rejected_without_chmod',()=>withRoot(async root=>{await chmod(root,0o755);await assert.rejects(()=>store(root).reserve(bind.command),/ROOT_INVALID/);assert.equal((await lstat(root)).mode&0o777,0o755);}));
  await test('symlink_journal_is_closed',()=>withRoot(async root=>{
    await store(root).reserve(bind.command);const path=join(root,'v3-results','journal.json'),saved=await readFile(path);await unlink(path);const external=join(root,'external.json');await writeFile(external,saved,{mode:0o600});await symlink(external,path);
    await assert.rejects(()=>store(root).replay(),/FILE_INVALID|READ_FAILED/);assert.deepEqual(await readFile(external),saved);
  }));
  await test('hardlinked_journal_is_rejected_before_read_or_write',()=>withRoot(async root=>{
    await store(root).reserve(bind.command);await link(join(root,'v3-results','journal.json'),join(root,'second-link.json'));
    await assert.rejects(()=>store(root).record(bind.result),/FILE_INVALID/);
  }));
  await test('private_file_modes_are_preserved_and_open_lock_is_not_deleted',()=>withRoot(async root=>{
    await store(root).reserve(bind.command);const dir=join(root,'v3-results');assert.equal((await lstat(dir)).mode&0o777,0o700);
    for(const file of ['authority.json','journal.json'])assert.equal((await lstat(join(dir,file))).mode&0o777,0o600);
    const lock=join(dir,'writer.lock');await writeFile(lock,'retained-uncertain-lock\n',{mode:0o600});await assert.rejects(()=>store(root).record(bind.result),/WRITER_BUSY/);assert.equal(await readFile(lock,'utf8'),'retained-uncertain-lock\n');
  }));
  for(const mode of ['parent-sync','parent-sync-failure','fifo-authority','fifo-journal']){
    await test('bounded_'+mode+'_probe',()=>withRoot(async root=>childProbe(root,mode)));
  }
}
console.log(JSON.stringify({suite:'W1_V3_NATIVE_RESULT_DURABILITY',passed,failed,skipped,transportIntegration:'NOT_RUN',liveAcceptance:'NOT_RUN'}));
if(failed>0)process.exitCode=1;
