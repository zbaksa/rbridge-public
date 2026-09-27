import {describe,expect,it} from 'vitest';
import {resolveHostProfile} from '../../src/domain/remoteBridgeHostProfiles.js';

const operations=[
  {kind:'APP_RUN',appId:'cocwin',jobId:'probe-1',payload:{tool:'probe',cwd:'/home/cocwin/backend',args:[],timeout_ms:30_000,max_bytes:65_536}},
  {kind:'FILE',action:'READ',target:'/mnt/data/a.txt',args:{maxBytes:4096}},
  {kind:'PROCESS',action:'STATUS',sessionId:'session-abc123',args:{}},
  {kind:'CHUNK',action:'GET',transferId:'transfer-abc123',args:{index:0}},
  {kind:'HEALTH',action:'STATUS'}
] as const;

describe('Stage-2 source-controlled host profiles',()=>{
  it('resolves a frozen profile for every supported operation kind',()=>{
    for(const operation of operations){
      const profile=resolveHostProfile(operation as never);
      expect(profile.kind).toBe(operation.kind);
      expect(profile.sourceControlled).toBe(true);
      expect(Object.isFrozen(profile)).toBe(true);
    }
  });

  it('uses narrow source-controlled FILE roots, never request roots',()=>{
    const profile=resolveHostProfile({kind:'FILE',action:'READ',target:'/mnt/data/a.txt',args:{allowedRoots:['/']}} as never);
    expect(profile.kind).toBe('FILE');
    if(profile.kind!=='FILE') throw new Error('unexpected profile');
    expect(profile.allowedRoots.length).toBeGreaterThan(0);
    expect(profile.allowedRoots).not.toContain('/');
    for(const root of profile.allowedRoots){
      expect(root.startsWith('/')).toBe(true);
      expect(['/root','/proc','/sys','/dev']).not.toContain(root);
    }
  });

  it('does not accept an unknown operation kind',()=>{
    expect(()=>resolveHostProfile({kind:'SHELL'} as never)).toThrow(/REMOTE_BRIDGE_HOST_PROFILE_INVALID/);
  });
});