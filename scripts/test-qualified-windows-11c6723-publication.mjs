import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.platform!=='linux'||process.getuid()===0)throw new Error('NORMAL_LINUX_APP_OR_CI_IDENTITY_REQUIRED');
const zip=path.resolve(process.argv[2]??'');
if(!fs.statSync(zip).isFile()||fs.statSync(zip).size!==34357300||crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')!=='0e614e0f143bb49db4e2e2807a9ebde4e6796e5adcf7425ff08762bd240b4af0')throw new Error('QUALIFIED_PUBLICATION_FIXTURE_ZIP_INVALID');
const script=fileURLToPath(new URL('./publish-qualified-windows-11c6723.sh',import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'rbridge-publication-qa-'));
const fake=`#!${process.execPath}
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2),mode=process.env.COCWIN_PUBLICATION_FIXTURE_CASE;
const source='11c67238e4d1998e0fab166da048c655b478a1d6',digest='sha256:0e614e0f143bb49db4e2e2807a9ebde4e6796e5adcf7425ff08762bd240b4af0';
function output(value){process.stdout.write(JSON.stringify(value));}
function missing(){console.error('gh: Not Found (HTTP 404)');process.exit(1);}
if(args[0]==='api'){
 const resource=args[1];
 if(resource==='repos/zbaksa/rbridge-public/git/ref/tags/cocwin-windows-11c6723'){output({ref:'refs/tags/cocwin-windows-11c6723',object:{type:'commit',sha:mode==='conflicting-tag'?('f'.repeat(40)):source}});}
 else if(resource==='repos/zbaksa/rbridge-public/releases/tags/cocwin-windows-11c6723'){
  if(mode==='conflicting-tag')missing();
  output({id:425234940,tag_name:'cocwin-windows-11c6723',draft:false,prerelease:true,target_commitish:source,assets:[{id:681059635,name:'rbridge-windows-11c6723.zip',size:34357300,digest}]});
 }
 else if(resource==='repos/zbaksa/rbridge-public/actions/runs/40517709746')output({id:40517709746,head_sha:source,status:'completed',conclusion:'success'});
 else if(resource==='repos/zbaksa/rbridge-public/actions/artifacts/12741520050'){
  if(mode==='expired-original')missing();
  output({id:12741520050,expired:false,size_in_bytes:34357300,workflow_run:{head_sha:source},digest});
 }
 else if(resource==='repos/zbaksa/rbridge-public/actions/artifacts/12741520050/zip'){
  if(mode==='expired-original')missing();
  process.stdout.write(fs.readFileSync(process.env.COCWIN_PUBLICATION_FIXTURE_ZIP));
 }
 else {console.error('UNEXPECTED_GITHUB_READ');process.exit(7);}
}else if(args[0]==='release'&&args[1]==='create'){
 fs.writeFileSync(path.join(process.cwd(),'release-created.json'),JSON.stringify({tag:'cocwin-windows-11c6723',attachedTarget:mode==='conflicting-tag'?('f'.repeat(40)):source}));
 console.log('FIXTURE_RELEASE_CREATED');
}else {console.error('UNEXPECTED_GITHUB_OPERATION');process.exit(8);}
`;
try{
 const bin=path.join(root,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'gh'),fake,{mode:0o700});
 const results=[];
 for(const name of ['existing-valid','expired-original','conflicting-tag']){
  const cwd=path.join(root,name);fs.mkdirSync(cwd);
  const env={...process.env,PATH:bin+':'+process.env.PATH,GH_TOKEN:'fixture-only',COCWIN_PUBLICATION_FIXTURE_CASE:name,COCWIN_PUBLICATION_FIXTURE_ZIP:zip};
  const r=cp.spawnSync('/usr/bin/bash',[script],{cwd,env,encoding:'utf8',timeout:20000,maxBuffer:65536});
  const wroteRelease=fs.existsSync(path.join(cwd,'release-created.json'));
  const expectedSuccess=name!=='conflicting-tag';
  const passed=!r.error&&!wroteRelease&&(expectedSuccess?r.status===0:r.status!==0);
  results.push({name,state:passed?'PASS':'FAIL',returncode:r.status,wroteRelease,expectedSuccess,error:r.error?.message??null,stderr:r.stderr.slice(-1200)});
 }
 const passed=results.filter(x=>x.state==='PASS').length;
 console.log(JSON.stringify({schema:'RBRIDGE_QUALIFIED_PUBLICATION_QA_V1',state:passed===3?'PASS':'FAIL',passed,failed:3-passed,results,githubBoundary:'FIXTURE_ONLY',livePublicationWrites:0,uid:process.getuid(),gid:process.getgid()}));
 if(passed!==3)process.exitCode=1;
}finally{fs.rmSync(root,{recursive:true,force:true});}
