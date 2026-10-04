import {describe,expect,it,vi} from 'vitest';
import {resolveRemoteBridgeGitHubConfig,resolveRemoteBridgeInstanceId,resolveRemoteBridgeRuntimeConfig,runRemoteBridgeLoop} from '../../src/server/remoteBridgeMain.js';

describe('remote bridge main loop',()=>{
 it('requires an explicit matching non-root runtime identity',()=>{const env={RBRIDGE_RUNTIME_USER:'bridge-runtime'};expect(resolveRemoteBridgeRuntimeConfig(env,{username:'bridge-runtime',homedir:'/srv/bridge-runtime',uid:1200})).toEqual({runtimeUser:'bridge-runtime',stateRoot:'/srv/bridge-runtime/.local/state/rbridge'});expect(()=>resolveRemoteBridgeRuntimeConfig({}, {username:'bridge-runtime',homedir:'/srv/bridge-runtime',uid:1200})).toThrow('REMOTE_BRIDGE_RUNTIME_USER_CONFIG_INVALID');expect(()=>resolveRemoteBridgeRuntimeConfig(env,{username:'other',homedir:'/srv/other',uid:1201})).toThrow('REMOTE_BRIDGE_RUNTIME_USER_REQUIRED');expect(()=>resolveRemoteBridgeRuntimeConfig(env,{username:'bridge-runtime',homedir:'/srv/bridge-runtime',uid:0})).toThrow('REMOTE_BRIDGE_RUNTIME_USER_REQUIRED');expect(()=>resolveRemoteBridgeRuntimeConfig(env,{username:'bridge-runtime',homedir:'relative',uid:1200})).toThrow('REMOTE_BRIDGE_HOME_INVALID');});
 it('requires explicit valid GitHub repository and author configuration',()=>{expect(resolveRemoteBridgeGitHubConfig({RBRIDGE_GITHUB_REPOSITORY:'example/rbridge-control',RBRIDGE_GITHUB_AUTHOR:'bridge-owner'})).toEqual({repository:'example/rbridge-control',authorLogin:'bridge-owner'});expect(()=>resolveRemoteBridgeGitHubConfig({})).toThrow('REMOTE_BRIDGE_GITHUB_REPOSITORY_CONFIG_INVALID');expect(()=>resolveRemoteBridgeGitHubConfig({RBRIDGE_GITHUB_REPOSITORY:'bad repo',RBRIDGE_GITHUB_AUTHOR:'bridge-owner'})).toThrow('REMOTE_BRIDGE_GITHUB_REPOSITORY_CONFIG_INVALID');expect(()=>resolveRemoteBridgeGitHubConfig({RBRIDGE_GITHUB_REPOSITORY:'example/rbridge-control',RBRIDGE_GITHUB_AUTHOR:'bad author!'})).toThrow('REMOTE_BRIDGE_GITHUB_AUTHOR_CONFIG_INVALID');});
 it('binds durable scope to an explicit or machine-derived instance identity',()=>{
   expect(resolveRemoteBridgeInstanceId({RBRIDGE_INSTANCE_ID:'host-alpha'},'f'.repeat(32))).toBe('host-alpha');
   expect(resolveRemoteBridgeInstanceId({},'ABCDEF0123456789ABCDEF0123456789\n')).toBe('machine-abcdef0123456789abcdef0123456789');
   expect(()=>resolveRemoteBridgeInstanceId({RBRIDGE_INSTANCE_ID:'bad instance'},'f'.repeat(32))).toThrow('REMOTE_BRIDGE_INSTANCE_ID_INVALID');
   expect(()=>resolveRemoteBridgeInstanceId({},'not-a-machine-id')).toThrow('REMOTE_BRIDGE_INSTANCE_ID_INVALID');
 });
 it('holds one lock, runs bounded ticks, sleeps between them and releases lock',async()=>{let n=0;const release=vi.fn(async()=>{}),sleep=vi.fn(async()=>{}),log=vi.fn();await runRemoteBridgeLoop({acquireLock:async()=>({release}),runOnce:async()=>{n++;return {seen:n,pending:0,published:0,blocked:0,errors:0};},shouldContinue:()=>n<2,sleep,log,pollMs:1234});expect(n).toBe(2);expect(sleep).toHaveBeenCalledTimes(1);expect(sleep).toHaveBeenCalledWith(1234);expect(release).toHaveBeenCalledTimes(1);expect(log).toHaveBeenCalledTimes(2);});
 it('fails closed for a tick error, logs it, then continues without executing hidden fallback',async()=>{let calls=0;const log=vi.fn(),release=vi.fn(async()=>{});await runRemoteBridgeLoop({acquireLock:async()=>({release}),runOnce:async()=>{calls++;if(calls===1)throw new Error('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED');return {seen:0,pending:0,published:0,blocked:0,errors:0};},shouldContinue:()=>calls<2,sleep:async()=>{},log,pollMs:1});expect(calls).toBe(2);expect(log.mock.calls[0]![0]).toMatchObject({schema:'COCWIN_REMOTE_BRIDGE_TICK_V1',status:'ERROR',reason:'REMOTE_BRIDGE_GITHUB_COMMAND_FAILED'});expect(release).toHaveBeenCalledOnce();});
 it('releases the global lock when sleep itself fails',async()=>{let n=0;const release=vi.fn(async()=>{});await expect(runRemoteBridgeLoop({acquireLock:async()=>({release}),runOnce:async()=>{n++;return {seen:0,pending:0,published:0,blocked:0,errors:0};},shouldContinue:()=>true,sleep:async()=>{throw new Error('STOP');},log:()=>{},pollMs:1})).rejects.toThrow('STOP');expect(n).toBe(1);expect(release).toHaveBeenCalledOnce();});
 it('applies bounded exponential backoff after repeated transport errors and resets after success',async()=>{let calls=0;const sleeps:number[]=[];await runRemoteBridgeLoop({acquireLock:async()=>({release:async()=>{}}),runOnce:async()=>{calls++;if(calls<3)throw new Error('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED');return {seen:0,pending:0,published:0,blocked:0,errors:0};},shouldContinue:()=>calls<4,sleep:async ms=>{sleeps.push(ms);},log:()=>{},pollMs:100,maxBackoffMs:1000});expect(sleeps).toEqual([200,400,100]);});
 it('uses the maximum bounded backoff for an explicit GitHub rate-limit error',async()=>{let calls=0;const sleeps:number[]=[];await runRemoteBridgeLoop({acquireLock:async()=>({release:async()=>{}}),runOnce:async()=>{calls++;if(calls===1)throw new Error('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED:HTTP 429 secondary rate limit');return {seen:0,pending:0,published:0,blocked:0,errors:0};},shouldContinue:()=>calls<2,sleep:async ms=>{sleeps.push(ms);},log:()=>{},pollMs:100,maxBackoffMs:5000});expect(sleeps).toEqual([5000]);});

 it('runs onLocked after acquiring the global lock and before the first tick',async()=>{
   const events:string[]=[];
   await runRemoteBridgeLoop({
     acquireLock:async()=>{
       events.push('lock');
       return {release:async()=>{events.push('release');}};
     },
     onLocked:async()=>{events.push('onLocked');},
     runOnce:async()=>{
       events.push('tick');
       return {seen:0,pending:0,published:0,blocked:0,errors:0};
     },
     shouldContinue:()=>!events.includes('tick'),
     sleep:async()=>{},
     log:()=>{},
     pollMs:1
   });
   expect(events).toEqual(['lock','onLocked','tick','release']);
 });


});
