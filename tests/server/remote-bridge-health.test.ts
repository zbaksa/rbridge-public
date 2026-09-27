import {describe,expect,it} from 'vitest';
import {createRemoteBridgeHealth} from '../../src/server/remoteBridgeHealth.js';

const SHA='a'.repeat(40);

describe('remote bridge stage2 safe health',()=>{
  it('returns only the approved health fields and tracks the latest successful GitHub poll',()=>{
    let now=new Date('2026-09-16T21:00:05.000Z');
    const health=createRemoteBridgeHealth({releaseSha:SHA,startedAt:new Date('2026-09-16T21:00:00.000Z'),now:()=>now,counts:()=>({queueCount:3,sessionCount:2,transferCount:1})});
    expect(health.snapshot()).toEqual({schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:SHA,uptimeMs:5000,queueCount:3,sessionCount:2,transferCount:1,lastGitHubPollAt:null});
    health.recordGitHubPoll();
    now=new Date('2026-09-16T21:00:07.000Z');
    expect(health.snapshot()).toEqual({schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:SHA,uptimeMs:7000,queueCount:3,sessionCount:2,transferCount:1,lastGitHubPollAt:'2026-09-16T21:00:05.000Z'});
  });

  it('fails closed for invalid release/timestamps/counts instead of emitting ambiguous health',()=>{
    expect(()=>createRemoteBridgeHealth({releaseSha:'main',startedAt:new Date('2026-09-16T21:00:00.000Z'),counts:()=>({queueCount:0,sessionCount:0,transferCount:0})})).toThrow('REMOTE_BRIDGE_HEALTH_RELEASE_INVALID');
    const health=createRemoteBridgeHealth({releaseSha:SHA,startedAt:new Date('2026-09-16T21:00:00.000Z'),now:()=>new Date('2026-09-16T20:59:59.000Z'),counts:()=>({queueCount:0,sessionCount:0,transferCount:0})});
    expect(()=>health.snapshot()).toThrow('REMOTE_BRIDGE_HEALTH_TIME_INVALID');
    const counts=createRemoteBridgeHealth({releaseSha:SHA,startedAt:new Date('2026-09-16T21:00:00.000Z'),now:()=>new Date('2026-09-16T21:00:01.000Z'),counts:()=>({queueCount:-1,sessionCount:0,transferCount:0})});
    expect(()=>counts.snapshot()).toThrow('REMOTE_BRIDGE_HEALTH_COUNT_INVALID');
  });

  it('cannot surface secret/path-bearing values because snapshot shape is fixed',()=>{
    const health=createRemoteBridgeHealth({releaseSha:SHA,startedAt:new Date('2026-09-16T21:00:00.000Z'),now:()=>new Date('2026-09-16T21:00:01.000Z'),counts:()=>({queueCount:0,sessionCount:0,transferCount:0})});
    const text=JSON.stringify(health.snapshot());
    for(const forbidden of ['token','secret','password','authorization','/home/','/etc/'])expect(text.toLowerCase()).not.toContain(forbidden);
    expect(Object.keys(health.snapshot()).sort()).toEqual(['lastGitHubPollAt','queueCount','releaseSha','schema','sessionCount','status','transferCount','uptimeMs'].sort());
  });
});