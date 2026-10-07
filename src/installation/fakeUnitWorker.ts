/** Fixed non-root worker for an isolated installation stop fixture. */
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {pathToFileURL} from 'node:url';
import {encodeInstallReport} from './types.js';

export function parseFakeUnitWorkerArgs(args:readonly string[]){
  const [mode,unit,home,nonce,dev,ino]=args;
  if(args.length!==6||mode!=='--unit-fixture'||!unit||!/^rbridge-install-fixture-[0-9a-f]{32}\.service$/.test(unit)
    ||!home||!/^\/home\/rbridge\/\.rbridge-artifact-[0-9a-f]{32}$/.test(home)||!nonce||!/^[0-9a-f]{64}$/.test(nonce)
    ||!dev||!ino||!/^[1-9][0-9]{0,19}$/.test(dev)||!/^[1-9][0-9]{0,19}$/.test(ino)
    ||dev!==BigInt(dev).toString())throw new Error('FAKE_UNIT_WORKER_INVALID');
  return {unit,home,nonce,dev,ino};
}

async function main(){
  const started=process.hrtime.bigint();
  const user=userInfo(),uid=process.getuid?.(),euid=process.geteuid?.(),gid=process.getgid?.();
  if(process.platform!=='linux'||uid!==1027||euid!==uid||gid!==1027||user.username!=='rbridge'||user.homedir!=='/home/rbridge'
    ||process.versions.node!=='22.23.2'||process.execArgv.length||process.cwd()!=='/'
    ||['GH_TOKEN','GITHUB_TOKEN','GH_HOST','GH_CONFIG_DIR','NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONHOME'].some(k=>process.env[k]!==undefined)
    ||process.getgroups?.().includes(0))throw new Error('FAKE_UNIT_WORKER_UNQUALIFIED');
  const args=parseFakeUnitWorkerArgs(process.argv.slice(2));
  const folder=await open(args.home,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
    const before=await folder.stat({bigint:true});
    if(!before.isDirectory()||before.uid!==1027n||before.gid!==1027n||(before.mode&0o7777n)!==0o700n
      ||before.dev.toString()!==args.dev||before.ino.toString()!==args.ino)throw new Error('FAKE_UNIT_WORKER_UNQUALIFIED');
    const identity={pid:process.pid,uid,euid,gid,unit:args.unit,nonce:args.nonce};
    async function record(name:string,value:unknown){
      const file=await open('/proc/self/fd/'+folder.fd+'/'+name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await file.writeFile(Buffer.from(encodeInstallReport(value)));await file.writeFile('\n');await file.sync();}
      finally{await file.close();}
      await folder.sync();
    }
    await record('ready.json',{schema:'RBRIDGE_FAKE_UNIT_READY_V1',...identity});
    const hold=setInterval(()=>{},1000);
    await new Promise<void>(resolve=>process.once('SIGTERM',()=>{clearInterval(hold);resolve();}));
    await record('stopped.json',{schema:'RBRIDGE_FAKE_UNIT_STOPPED_V1',...identity,signal:'SIGTERM',
      elapsed_ms:Number((process.hrtime.bigint()-started)/1000000n)});
  }finally{await folder.close();}
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)void main().catch(()=>{
  process.stderr.write('FAKE_UNIT_WORKER_UNQUALIFIED\n');process.exitCode=2;
});
