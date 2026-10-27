import assert from 'node:assert/strict';
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_PEER_INSTALL '+name);}catch(e){failed++;console.error('FAIL V3_PEER_INSTALL '+name+': '+String(e));}}
interface InstallConfig {schema:string;releaseSha:string;releaseCwd:string;storeRoot:string;launchCwd:string}
const cliModule=await import('../src/server/rbridgeChatPeerCli.js') as unknown as {
  parseRbridgeChatPeerInstallV3?:(value:unknown)=>InstallConfig;
  assertRbridgeChatPeerInvocationV3?:(config:InstallConfig,cwd:string,entry:string)=>void;
};
const installedRelease='/var/lib/rbridge/runtime/releases/'+'1'.repeat(40);
const legacyInstall={schema:'RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3',releaseSha:'1'.repeat(40),releaseCwd:installedRelease,storeRoot:'/var/lib/rbridge/chat-v3/cocwin'};
const registeredInstall={...legacyInstall,schema:'RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3_1',launchCwd:'/home/rbridge/backend'};
function parseInstall(value:unknown){assert.equal(typeof cliModule.parseRbridgeChatPeerInstallV3,'function','private install parser must exist');return cliModule.parseRbridgeChatPeerInstallV3!(value);}
function invokeInstall(config:InstallConfig,cwd:string,entry:string){assert.equal(typeof cliModule.assertRbridgeChatPeerInvocationV3,'function','private invocation validator must exist');return cliModule.assertRbridgeChatPeerInvocationV3!(config,cwd,entry);}
await test('registered_launch_cwd_is_separate_from_immutable_release',async()=>{
  const parsed=parseInstall(registeredInstall);assert.equal(parsed.launchCwd,'/home/rbridge/backend');assert.equal(parsed.releaseCwd,installedRelease);
  invokeInstall(parsed,'/home/rbridge/backend',installedRelease+'/dist/src/server/rbridgeChatPeerCli.js');
});
await test('legacy_private_config_retains_its_original_release_cwd_rule',async()=>{
  const parsed=parseInstall(legacyInstall);assert.equal(parsed.launchCwd,installedRelease);
  invokeInstall(parsed,installedRelease,installedRelease+'/dist/src/server/rbridgeChatPeerCli.js');
  assert.throws(()=>invokeInstall(parsed,'/home/rbridge/backend',installedRelease+'/dist/src/server/rbridgeChatPeerCli.js'),/RELEASE_MISMATCH/);
});
await test('new_private_config_rejects_missing_extra_or_unsupported_fields',async()=>{
  const {launchCwd,...missing}=registeredInstall;void launchCwd;
  assert.equal(typeof cliModule.parseRbridgeChatPeerInstallV3,'function');
  for(const bad of [missing,{...registeredInstall,command:'node'},{...registeredInstall,schema:'UNKNOWN'}, {...legacyInstall,launchCwd:'/home/rbridge/backend'}])assert.throws(()=>parseInstall(bad));
});
await test('new_private_config_rejects_noncanonical_launch_paths',async()=>{
  assert.equal(typeof cliModule.parseRbridgeChatPeerInstallV3,'function');
  for(const launchCwd of ['', '/', 'relative','/home/rbridge/../other','/home/rbridge/backend/','/home//rbridge/backend','/home/rbridge/backend\n'])assert.throws(()=>parseInstall({...registeredInstall,launchCwd}));
});
await test('installed_invocation_requires_both_registered_cwd_and_pinned_entry',async()=>{
  const parsed=parseInstall(registeredInstall),entry=installedRelease+'/dist/src/server/rbridgeChatPeerCli.js';
  for(const cwd of [installedRelease,'/home/other/backend','/home/rbridge/backend/alias'])assert.throws(()=>invokeInstall(parsed,cwd,entry),/RELEASE_MISMATCH/);
  for(const wrong of ['/home/rbridge/backend/peer.js',entry+'.other',installedRelease+'/dist/src/server/../server/rbridgeChatPeerCli.js'])assert.throws(()=>invokeInstall(parsed,parsed.launchCwd,wrong),/ENTRYPOINT_MISMATCH/);
});
await test('private_install_config_cannot_select_an_arbitrary_release_root',async()=>{
  assert.equal(typeof cliModule.parseRbridgeChatPeerInstallV3,'function');
  for(const releaseCwd of ['/home/rbridge/backend',installedRelease+'/',installedRelease+'/../other'])assert.throws(()=>parseInstall({...registeredInstall,releaseCwd}));
});

console.log(JSON.stringify({suite:'W1_V3_PEER_INSTALL',passed,failed,liveAcceptance:'NOT_RUN'}));
if(failed)process.exitCode=1;
