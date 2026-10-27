import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {buildSshStdioLaunch,type SshStdioLaunchConfig} from '../src/transport/sshStdio.js';

const windows=process.platform==='win32';
const config:SshStdioLaunchConfig=windows?{sshPath:'C:\\Program Files\\OpenSSH\\ssh.exe',host:'127.0.0.1',port:22,user:'rbridge',identityFile:"C:\\Users\\CI Owner O'Connor\\Čvor\\owner_ed25519",knownHostsFile:"C:\\Users\\CI Owner O'Connor\\Čvor\\known_hosts.cocwin"}:{sshPath:'/usr/bin/ssh',host:'127.0.0.1',port:22,user:'rbridge',identityFile:'/home/ci owner/keys/owner_ed25519',knownHostsFile:'/home/ci owner/keys/known_hosts.cocwin'};
let passed=0,failed=0;
function test(name:string,fn:()=>void){try{fn();passed++;console.log('PASS SSH_PLATFORM_PATHS '+name);}catch(error){failed++;console.error('FAIL SSH_PLATFORM_PATHS '+name+': '+String(error));}}

test('paths_and_fixed_arguments_stay_literal',()=>{
 const launch=buildSshStdioLaunch(config);
 assert.equal(launch.command,config.sshPath);
 assert.deepEqual(launch.options,{shell:false,stdio:['pipe','pipe','pipe']});
 const known=windows?'-oUserKnownHostsFile="C:\\\\Users\\\\CI Owner O\'Connor\\\\Čvor\\\\known_hosts.cocwin"':'-oUserKnownHostsFile=/home/ci owner/keys/known_hosts.cocwin';
 assert.deepEqual(launch.args,['-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oIdentitiesOnly=yes','-oPasswordAuthentication=no','-oKbdInteractiveAuthentication=no',known,'-i',config.identityFile,'-p','22','rbridge@127.0.0.1','rbridge-chat-stdio-v1']);
});
const bad=windows?['ssh.exe','C:relative.exe','\\rooted\\ssh.exe','\\\\server\\share\\ssh.exe','\\\\?\\C:\\Windows\\ssh.exe','\\\\.\\pipe\\ssh','/usr/bin/ssh','C:\\dir\\..\\ssh.exe','C:\\keys\\owner:stream','C:\\keys\\owner\0','C:\\keys\\owner\n','C:\\keys\\NUL','C:\\keys\\nUl.txt','C:\\keys\\CON','C:\\keys\\PRN.dat','C:\\keys\\AUX','C:\\keys\\COM1.txt','C:\\keys\\LPT9','C:\\keys\\COM¹.txt','C:\\keys\\LPT²','C:\\keys\\CONIN$','C:\\keys\\CONOUT$','C:\\keys\\known_hosts.','C:\\keys\\known_hosts ','C:\\keys.\\owner','C:\\keys \\owner','C:\\keys\\bad<name','C:\\keys\\bad"name','C:\\keys\\bad|name','C:\\keys\\bad?name','C:\\keys\\bad*name','C:\\keys\\bad\x01name']:['ssh','relative/key','//server/key','C:\\keys\\owner','/key\0','/key\n'];
for(const field of ['sshPath','identityFile','knownHostsFile'] as const){
 const code=field==='sshPath'?'RBRIDGE_SSH_PATH_INVALID':field==='identityFile'?'RBRIDGE_SSH_IDENTITY_INVALID':'RBRIDGE_SSH_KNOWN_HOSTS_INVALID';
 for(const path of bad)test(field+' rejects '+JSON.stringify(path),()=>assert.throws(()=>buildSshStdioLaunch({...config,[field]:path}),new RegExp(code)));
}
if(windows){
 for(const field of ['identityFile','knownHostsFile'] as const){
  const code=field==='identityFile'?'RBRIDGE_SSH_IDENTITY_INVALID':'RBRIDGE_SSH_KNOWN_HOSTS_INVALID';
  for(const path of ['C:\\keys\\%h\\owner','C:\\keys\\%r\\owner','C:\\keys\\literal%name','C:\\keys\\${CI_OWNER}\\owner'])test(field+' rejects client expansion '+path,()=>assert.throws(()=>buildSshStdioLaunch({...config,[field]:path}),new RegExp(code)));
 }
 test('real_windows_openssh_parses_one_literal_known_hosts_path',()=>{
  assert.ok(process.env.WINDIR,'Windows CI must supply its real system directory');
  const root=mkdtempSync(join(tmpdir(),'rbridge-ssh-paths-'));
  try{
   const dir=join(root,"CI Owner O'Connor Čvor");mkdirSync(dir);
   const identityFile=join(dir,'owner_ed25519'),knownHostsFile=join(dir,'known_hosts.cocwin');
   writeFileSync(identityFile,'public test fixture, not a private key\n');writeFileSync(knownHostsFile,'');
   const launch=buildSshStdioLaunch({...config,sshPath:process.env.WINDIR+'\\System32\\OpenSSH\\ssh.exe',identityFile,knownHostsFile});
   const version=spawnSync(launch.command,['-V'],{shell:false,encoding:'utf8',timeout:10000,maxBuffer:4096});
   assert.equal(version.error,undefined);assert.equal(version.status,0);assert.match(version.stderr+version.stdout,/OpenSSH_/);
   const probe=spawnSync(launch.command,['-G','-F','NUL',...launch.args],{shell:false,encoding:'utf8',timeout:10000,maxBuffer:65536});
   assert.equal(probe.error,undefined);assert.equal(probe.status,0,probe.stderr);
   const lines=probe.stdout.split(/\r?\n/),one=(key:string)=>{const matches=lines.filter(line=>line.startsWith(key+' '));assert.equal(matches.length,1,key);return matches[0]!.slice(key.length+1);};
   assert.equal(win32.normalize(one('userknownhostsfile')),win32.normalize(knownHostsFile));
   assert.equal(win32.normalize(one('identityfile')),win32.normalize(identityFile));
   assert.equal(one('hostname'),'127.0.0.1');assert.equal(one('user'),'rbridge');assert.equal(one('port'),'22');
   for(const key of ['batchmode','identitiesonly','stricthostkeychecking'])assert.ok(['yes','true'].includes(one(key)),key);
   assert.equal(one('passwordauthentication'),'no');assert.equal(one('kbdinteractiveauthentication'),'no');
  }finally{rmSync(root,{recursive:true,force:true});}
 });
}
console.log(JSON.stringify({suite:'SSH_PLATFORM_PATHS',platform:process.platform,passed,failed,ownerAuthentication:'NOT_RUN',sshConnections:0,browserSends:0}));
if(failed)process.exitCode=1;
