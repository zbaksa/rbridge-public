'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function need(cond,msg){if(!cond)throw Error(msg);}
try{
  const root=path.join(process.env.LOCALAPPDATA||'','COCWIN','RBridge','NativeHost');
  const file=path.join(root,'rbridge-native-host.config.json');
  const exe=path.join(root,'rbridge-native-host.exe');
  need(fs.existsSync(exe)&&fs.existsSync(file),'OWNER_NATIVE_HOST_NOT_INSTALLED');
  const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
  need(cfg.schema==='RBRIDGE_NATIVE_HOST_CONFIG_V1'&&cfg.expectedExtensionId==='ebibbijpegoankenmggdnehpoadcophk'&&cfg.ssh?.user==='rbridge','NATIVE_CONFIG_NOT_QUALIFIED');
  need(!Object.prototype.hasOwnProperty.call(cfg,'v3'),'V3_EXISTING_CONFIG_DO_NOT_REPLACE');
  const rootEvents=cfg.eventStoreRoot;
  need(typeof rootEvents==='string'&&path.isAbsolute(rootEvents)&&path.resolve(rootEvents)===rootEvents,'NATIVE_HISTORY_ROOT_INVALID');
  for(const name of ['events.ndjson','v3-peer','rbridgeEffectResultsV3','rbridge-v3-results']){
    need(!fs.existsSync(path.join(rootEvents,name)),'HISTORY_EXISTS_DO_NOT_RESET:'+name);
  }
  const v3=JSON.parse(fs.readFileSync(path.join(__dirname,'native-v3.json'),'utf8'));
  need(v3.scope?.appId==='cocwin'&&v3.peerPins?.releaseSha==='931e02d6b771a351e8c4e4977cf25ebf82d12a13','P01_AUTHORITY_INVALID');
  need(v3.initialHistory?.sequence===0&&v3.initialHistory?.eventSha256===null,'P01_HISTORY_ANCHOR_INVALID');
  const contents=Buffer.from(JSON.stringify({...cfg,v3},null,2)+'\n');
  const temp=path.join(root,'.p01-candidate-'+crypto.randomBytes(8).toString('hex')+'.json');
  const backup=path.join(root,'rbridge-native-host.config.pre-p01.json');
  need(!fs.existsSync(backup),'BACKUP_ALREADY_EXISTS');
  const fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,contents);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const result=cp.spawnSync(exe,['--check-config',temp],{timeout:15000,encoding:'utf8',maxBuffer:65536});
  if(result.error||result.status!==0){fs.unlinkSync(temp);throw Error('NATIVE_CONFIG_CHECK_FAILED');}
  fs.renameSync(file,backup);
  try{fs.renameSync(temp,file);}catch(error){fs.renameSync(backup,file);throw error;}
  console.log(JSON.stringify({schema:'COCWIN_P01_OWNER_NATIVE_V3',status:'PASS',configSha256:sha(contents),backupPreserved:true,browserSends:0}));
}catch(error){console.error('COCWIN_P01_NATIVE_SETUP_BLOCKED:'+String(error.message||error));process.exitCode=1;}
