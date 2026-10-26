import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,stat,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {V3_CAPABILITIES} from '../src/domain/rbridgeEffectProtocol.js';

const cli=fileURLToPath(new URL('../src/nativeHost/nativeHostCli.js',import.meta.url));
const extensionId='ebibbijpegoankenmggdnehpoadcophk';
const root=await mkdtemp(join(tmpdir(),'rbridge-native-install-'));
const configPath=join(root,'candidate.json'),eventRoot=join(root,'events'),sentinel=join(root,'ssh-was-started'),sshPath=join(root,process.platform==='win32'?'probe.cmd':'probe.sh');
await writeFile(sshPath,process.platform==='win32'?'@echo invoked>'+sentinel+'\r\n':'#!/bin/sh\nprintf invoked > '+JSON.stringify(sentinel)+'\n',{mode:0o700});
const base={schema:'RBRIDGE_NATIVE_HOST_CONFIG_V1',expectedExtensionId:extensionId,eventStoreRoot:eventRoot,ssh:{sshPath,host:'fixture.invalid',port:22,user:'rbridge',identityFile:join(root,'identity'),knownHostsFile:join(root,'known-hosts')}};
const v3={scope:{appId:'cocwin',baseSha:'a'.repeat(40),sessionId:'exta-'+'1'.repeat(32),generation:'22222222-2222-4222-8222-222222222222'},peerPins:{peerId:'fixture-peer',releaseSha:'9'.repeat(40),browserInstanceId:'fixture-browser',browserProfileId:'fixture-profile',protocolMinor:1,maxMessageBytes:65536,capabilities:[...V3_CAPABILITIES]},initialHistory:{sequence:0,eventSha256:null}};
const exists=async(path:string)=>stat(path).then(()=>true,()=>false);
const run=(args:string[])=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:5000,env:{...process.env,RBRIDGE_NATIVE_HOST_CONFIG:configPath}});
async function candidate(value:unknown){const text=JSON.stringify(value,null,2)+'\n';await writeFile(configPath,text,{mode:0o600});return text;}
function accepted(result:ReturnType<typeof run>){assert.equal(result.status,0,result.stderr);assert.equal(result.error,undefined);const receipt=JSON.parse(result.stdout);assert.equal(receipt.schema,'RBRIDGE_NATIVE_CONFIG_CHECK_V1');assert.equal(receipt.status,'PASS');assert.equal(receipt.activated,false);assert.equal(receipt.expectedExtensionId,extensionId);assert.equal(receipt.eventStoreRoot,eventRoot);return receipt;}
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_NATIVE_INSTALL '+name);}catch(e){failed++;console.error('FAIL V3_NATIVE_INSTALL '+name+': '+String(e));}}
try{
 await test('check_v1_hashes_the_same_bytes_without_starting_ssh_or_events',async()=>{const text=await candidate(base),receipt=accepted(run(['--check-config',configPath]));assert.equal(receipt.sourceSha256,createHash('sha256').update(text).digest('hex'));assert.equal(receipt.v3Configured,false);assert.equal(await exists(eventRoot),false);assert.equal(await exists(sentinel),false);});
 await test('check_v3_preserves_supplied_history_and_does_not_initialize_a_store',async()=>{const value={...base,v3:{...v3,initialHistory:{sequence:4,eventSha256:'b'.repeat(64)}}},text=await candidate(value),receipt=accepted(run(['--check-config',configPath]));assert.equal(receipt.v3Configured,true);assert.equal(receipt.sourceSha256,createHash('sha256').update(text).digest('hex'));assert.equal(await exists(eventRoot),false);assert.equal(await exists(sentinel),false);});
 await test('invalid_scope_pins_history_and_unknown_fields_are_rejected',async()=>{for(const invalid of [{...v3,scope:{...v3.scope,generation:'bad'}},{...v3,peerPins:{...v3.peerPins,capabilities:[]}},{...v3,initialHistory:{sequence:0,eventSha256:'b'.repeat(64)}},{...v3,extra:true}]){await candidate({...base,v3:invalid});const result=run(['--check-config',configPath]);assert.equal(result.status,78);assert.match(result.stderr,/RBRIDGE_NATIVE_CONFIG_CHECK=/);assert.equal(result.stdout,'');assert.equal(await exists(eventRoot),false);assert.equal(await exists(sentinel),false);}});
 await test('check_mode_rejects_missing_path_extra_arguments_and_relative_path',async()=>{await candidate(base);for(const args of [['--check-config'],['--check-config',configPath,'extra'],['--check-config','relative.json']]){const result=run(args);assert.equal(result.status,78);assert.equal(result.stdout,'');assert.equal(await exists(sentinel),false);}});
 await test('malformed_config_does_not_produce_a_success_receipt',async()=>{await writeFile(configPath,'{"schema":',{mode:0o600});const result=run(['--check-config',configPath]);assert.equal(result.status,78);assert.equal(result.stdout,'');assert.equal(await exists(sentinel),false);});
 if(process.platform!=='win32')await test('public_mode_or_symlink_config_remains_rejected',async()=>{await candidate(base);await chmod(configPath,0o644);assert.equal(run(['--check-config',configPath]).status,78);await chmod(configPath,0o600);const link=join(root,'link.json');await symlink(configPath,link);assert.equal(run(['--check-config',link]).status,78);assert.equal(await exists(sentinel),false);});
 await test('normal_unapproved_origin_still_cannot_start_native_transport',async()=>{await candidate(base);const result=run(['chrome-extension://'+'a'.repeat(32)+'/']);assert.equal(result.status,70);assert.equal(result.stdout,'');assert.equal(await exists(sentinel),false);});
}finally{await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({suite:'W1_V3_NATIVE_INSTALL',passed,failed,platform:process.platform,actualNativeChannels:0,ownerWindows:'NOT_RUN'}));if(failed)process.exitCode=1;
