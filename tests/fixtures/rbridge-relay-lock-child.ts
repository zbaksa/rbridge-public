import {acquireRemoteBridgeProcessLock} from '../../src/server/remoteBridgeStore.js';
const root=process.argv[2];
if(!root)throw new Error('TEST_LOCK_ROOT_REQUIRED');
process.stdout.write('BEFORE_ACQUIRE\n');
try{
  const lock=await acquireRemoteBridgeProcessLock(root);
  await lock.release();process.stdout.write('ACQUIRED\n');
}catch(error){process.stdout.write('REJECTED:'+String((error as Error).message)+'\n');}
