import {createRemoteBridgeFileOps} from '../../src/server/remoteBridgeFileOps.js';
import {join} from 'node:path';
const root=process.argv[2]!,action=process.argv[3];
const fileOps=createRemoteBridgeFileOps({allowedRoots:[root],maxReadBytes:256,maxSearchResults:2});
try{
  if(action==='STAT')await fileOps.execute({kind:'FILE',action:'STAT',target:join(root,'fifo'),args:{}});
  else if(action==='READ_MANY')await fileOps.execute({kind:'FILE',action:'READ_MANY',target:root,args:{paths:['fifo']}});
  else throw new Error('FIXTURE_ACTION_INVALID');
  process.stdout.write(JSON.stringify({status:'RESOLVED'})+'\n');
}catch{process.stdout.write(JSON.stringify({status:'REJECTED'})+'\n');}
