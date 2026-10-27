import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {buildSshStdioLaunch,type SshStdioLaunchConfig} from '../src/transport/sshStdio.js';

const windows=process.platform==='win32';
const config:SshStdioLaunchConfig=windows?{sshPath:'C:\\Program Files\\OpenSSH\\ssh.exe',host:'127.0.0.1',port:22,user:'rbridge',identityFile:'C:\\Users\\CI Owner\\NativeHost\\keys\\owner_ed25519',knownHostsFile:'C:\\Users\\CI Owner\\NativeHost\\keys\\known_hosts.cocwin'}:{sshPath:'/usr/bin/ssh',host:'127.0.0.1',port:22,user:'rbridge',identityFile:'/home/ci owner/keys/owner_ed25519',knownHostsFile:'/home/ci owner/keys/known_hosts.cocwin'};
let passed=0;
const launch=buildSshStdioLaunch(config);
assert.equal(launch.command,config.sshPath);
assert.deepEqual(launch.options,{shell:false,stdio:['pipe','pipe','pipe']});
assert.deepEqual(launch.args,['-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oIdentitiesOnly=yes','-oPasswordAuthentication=no','-oKbdInteractiveAuthentication=no','-oUserKnownHostsFile='+config.knownHostsFile,'-i',config.identityFile,'-p','22','rbridge@127.0.0.1','rbridge-chat-stdio-v1']);
passed++;
const bad=windows?['ssh.exe','C:relative.exe','\\rooted\\ssh.exe','\\\\server\\share\\ssh.exe','\\\\?\\C:\\Windows\\ssh.exe','\\\\.\\pipe\\ssh','/usr/bin/ssh','C:\\dir\\..\\ssh.exe','C:\\keys\\owner:stream','C:\\keys\\owner\0','C:\\keys\\owner\n']:['ssh','relative/key','//server/key','C:\\keys\\owner','/key\0','/key\n'];
for(const field of ['sshPath','identityFile','knownHostsFile'] as const){
 const code=field==='sshPath'?'RBRIDGE_SSH_PATH_INVALID':field==='identityFile'?'RBRIDGE_SSH_IDENTITY_INVALID':'RBRIDGE_SSH_KNOWN_HOSTS_INVALID';
 for(const path of bad){assert.throws(()=>buildSshStdioLaunch({...config,[field]:path}),new RegExp(code),field+' must reject '+JSON.stringify(path));passed++;}
}
if(windows){
 assert.ok(process.env.WINDIR,'Windows CI must supply its real system directory');
 const real=buildSshStdioLaunch({...config,sshPath:process.env.WINDIR+'\\System32\\OpenSSH\\ssh.exe'});
 const probe=spawnSync(real.command,['-V'],{shell:false,encoding:'utf8',timeout:10000,maxBuffer:4096});
 assert.equal(probe.error,undefined);assert.equal(probe.status,0);assert.match(probe.stderr+probe.stdout,/OpenSSH_/);passed++;
}
console.log('SSH_PLATFORM_PATHS_QA=PASS platform='+process.platform+' cases='+passed+' ownerAuthentication=NOT_RUN browserSends=0');
