import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import type {RemoteBridgeResolvedProcessProfile} from '../../src/domain/remoteBridgeHostProfiles.js';
import {buildRemoteBridgeSupervisorLaunch,createRemoteBridgeProcessSessions} from '../../src/server/remoteBridgeProcessSessions.js';
import {runRemoteBridgeProcessSupervisor} from '../../src/server/remoteBridgeProcessSupervisor.js';

const roots:string[]=[];
const D1='a'.repeat(64),D2='b'.repeat(64),D3='c'.repeat(64),D4='d'.repeat(64),WRONG='e'.repeat(64);
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function root(){const value=await mkdtemp(join(tmpdir(),'bridge-process-'));roots.push(value);return value;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

function profiles(cwdRoot:string){
  return (id:string,argv:unknown):RemoteBridgeResolvedProcessProfile=>{
    if(!Array.isArray(argv))throw new Error('TEST_ARGS_INVALID');
    if(id==='echo')return {
      id,executable:process.execPath,
      args:['-e',"process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write(d));process.stdin.resume();"],
      cwdRoots:[cwdRoot],maxLifetimeMs:10_000,maxOutputBytes:65_536,stdinMode:'UTF8',maxInputBytes:4096,forceKillAfterMs:200
    };
    if(id==='no-stdin')return {
      id,executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwdRoots:[cwdRoot],maxLifetimeMs:10_000,
      maxOutputBytes:65_536,stdinMode:'DENY',maxInputBytes:0,forceKillAfterMs:200
    };
    if(id==='overflow')return {
      id,executable:process.execPath,args:['-e',"process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"],cwdRoots:[cwdRoot],maxLifetimeMs:10_000,
      maxOutputBytes:4096,stdinMode:'DENY',maxInputBytes:0,forceKillAfterMs:200
    };
    if(id==='tail')return {
      id,executable:process.execPath,args:['-e',"const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"setTimeout(()=>process.stdout.write('TAIL'),120)\"],{stdio:['ignore',1,2]});c.unref();"],cwdRoots:[cwdRoot],maxLifetimeMs:10_000,
      maxOutputBytes:65_536,stdinMode:'DENY',maxInputBytes:0,forceKillAfterMs:200
    };
    if(id==='ignore-term')return {
      id,executable:process.execPath,args:['-e',"process.on('SIGTERM',()=>{});process.stdout.write('READY');setInterval(()=>{},1000)"],cwdRoots:[cwdRoot],maxLifetimeMs:10_000,
      maxOutputBytes:65_536,stdinMode:'DENY',maxInputBytes:0,forceKillAfterMs:100
    };
    if(id==='quick')return {
      id,executable:'/usr/bin/printf',args:['QUICK'],cwdRoots:[cwdRoot],maxLifetimeMs:5_000,
      maxOutputBytes:65_536,stdinMode:'DENY',maxInputBytes:0,forceKillAfterMs:200
    };
    throw new Error('REMOTE_BRIDGE_PROCESS_PROFILE_NOT_ALLOWED');
  };
}
async function manager(base:string){
  const state=join(base,'state');
  const resolveProfile=profiles(base);
  return createRemoteBridgeProcessSessions({
    root:state,resolveProfile,
    launchSupervisor:(specPath)=>{void runRemoteBridgeProcessSupervisor(specPath);}
  });
}
async function terminal(mgr:Awaited<ReturnType<typeof manager>>,id:string,owner:string){
  for(let attempt=0;attempt<100;attempt++){
    const value=await mgr.status(id,owner) as {state:string};
    if(['SUCCEEDED','FAILED','TERMINATED','UNCERTAIN'].includes(value.state))return value;
    await delay(20);
  }
  throw new Error('TEST_TERMINAL_TIMEOUT');
}

describe('Stage-2 durable PROCESS sessions',()=>{
  it('starts once, survives manager restart, binds ownership, streams cursor output/input and terminates',async()=>{
    const base=await root(),first=await manager(base);
    const operation={kind:'PROCESS',action:'START',args:{profileId:'echo',cwd:base,argv:[],lifetimeMs:5_000}} as const;
    const started=await first.execute(operation,D1) as {sessionId:string;state:string;ownerDigest:string;replay:boolean};
    expect(started.state).toBe('RUNNING');expect(started.ownerDigest).toBe(D1);expect(started.replay).toBe(false);
    const replay=await first.execute(operation,D1) as {sessionId:string;replay:boolean};
    expect(replay.sessionId).toBe(started.sessionId);expect(replay.replay).toBe(true);

    const second=await manager(base);
    await expect(second.status(started.sessionId,D1)).resolves.toMatchObject({state:'RUNNING',sessionId:started.sessionId});
    await expect(second.status(started.sessionId,WRONG)).rejects.toThrow(/OWNER_MISMATCH/);
    const initial=await second.readOutput(started.sessionId,D1,0,65_536) as {nextCursor:number;eof:boolean;chunks:unknown[]};
    expect(initial.chunks).toHaveLength(0);expect(initial.nextCursor).toBe(0);expect(initial.eof).toBe(false);

    await expect(second.execute({kind:'PROCESS',action:'WRITE_INPUT',sessionId:started.sessionId,args:{ownerDigest:D1,data:'hello-session\n'}},D2)).resolves.toMatchObject({action:'WRITE_INPUT'});
    await delay(60);
    const output=await second.execute({kind:'PROCESS',action:'READ_OUTPUT',sessionId:started.sessionId,args:{ownerDigest:D1,cursor:0,maxBytes:65_536}},D3) as {nextCursor:number;chunks:Array<{stream:string;dataBase64:string}>};
    const text=output.chunks.map(chunk=>Buffer.from(chunk.dataBase64,'base64').toString('utf8')).join('');
    expect(text).toContain('hello-session');expect(output.nextCursor).toBeGreaterThan(0);
    const caughtUp=await second.execute({kind:'PROCESS',action:'READ_OUTPUT',sessionId:started.sessionId,args:{ownerDigest:D1,cursor:output.nextCursor,maxBytes:65_536}},D3) as {nextCursor:number;eof:boolean;chunks:unknown[]};
    expect(caughtUp.nextCursor).toBe(output.nextCursor);expect(caughtUp.chunks).toHaveLength(0);expect(caughtUp.eof).toBe(false);
    const again=await second.execute({kind:'PROCESS',action:'READ_OUTPUT',sessionId:started.sessionId,args:{ownerDigest:D1,cursor:0,maxBytes:65_536}},D3) as {nextCursor:number;chunks:unknown[]};
    expect(again.nextCursor).toBe(output.nextCursor);expect(again.chunks).toHaveLength(output.chunks.length);

    await expect(second.execute({kind:'PROCESS',action:'TERMINATE',sessionId:started.sessionId,args:{ownerDigest:D1}},D4)).resolves.toMatchObject({action:'TERMINATE'});
    await expect(terminal(second,started.sessionId,D1)).resolves.toMatchObject({state:'TERMINATED'});
    const finalOutput=await second.readOutput(started.sessionId,D1,output.nextCursor,65_536) as {nextCursor:number;eof:boolean};
    expect(finalOutput.eof).toBe(true);
  });

  it('fails before launch when the Unix control socket path cannot fit safely',async()=>{
    const base=await root(),state=join(base,'x'.repeat(90));
    const mgr=createRemoteBridgeProcessSessions({root:state,resolveProfile:profiles(base),launchSupervisor:()=>{throw new Error('SHOULD_NOT_LAUNCH');}});
    await expect(mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'echo',cwd:base,argv:[]}},D1)).rejects.toThrow(/SOCKET_PATH_TOO_LONG/);
  });

  it('rejects request-controlled execution fields, cwd escape and stdin on a deny profile',async()=>{
    const base=await root(),mgr=await manager(base);
    await expect(mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'echo',cwd:base,argv:[],executable:'/bin/sh'}},D1)).rejects.toThrow(/ARGS_FIELDS_INVALID/);
    await expect(mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'echo',cwd:'/tmp',argv:[]}},D2)).rejects.toThrow(/CWD_NOT_ALLOWED/);
    const started=await mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'no-stdin',cwd:base,argv:[],lifetimeMs:5_000}},D3) as {sessionId:string;ownerDigest:string};
    await expect(mgr.execute({kind:'PROCESS',action:'WRITE_INPUT',sessionId:started.sessionId,args:{ownerDigest:D3,data:'nope'}},D4)).rejects.toThrow(/STDIN_NOT_ALLOWED/);
    await mgr.terminate(started.sessionId,D3,D4);await terminal(mgr,started.sessionId,D3);
  });

  it('enforces the output cap and fails closed after the bounded supervisor kills overflow',async()=>{
    const base=await root(),mgr=await manager(base);
    const started=await mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'overflow',cwd:base,argv:[],lifetimeMs:5_000}},D1) as {sessionId:string};
    const end=await terminal(mgr,started.sessionId,D1);
    expect(end).toMatchObject({state:'FAILED',truncated:true,reason:'REMOTE_BRIDGE_PROCESS_OUTPUT_LIMIT'});
    const output=await mgr.readOutput(started.sessionId,D1,0,65_536) as {chunks:Array<{dataBase64:string}>};
    const bytes=output.chunks.reduce((sum,chunk)=>sum+Buffer.from(chunk.dataBase64,'base64').length,0);
    expect(bytes).toBeLessThanOrEqual(4096);
  });

  it('does not publish terminal EOF until inherited stdout/stderr are fully drained',async()=>{
    const base=await root(),mgr=await manager(base);
    const started=await mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'tail',cwd:base,argv:[],lifetimeMs:5_000}},D1) as {sessionId:string};
    await expect(terminal(mgr,started.sessionId,D1)).resolves.toMatchObject({state:'SUCCEEDED'});
    await delay(200);
    const output=await mgr.readOutput(started.sessionId,D1,0,65_536) as {eof:boolean;chunks:Array<{dataBase64:string}>};
    const text=output.chunks.map(chunk=>Buffer.from(chunk.dataBase64,'base64').toString('utf8')).join('');
    expect(text).toContain('TAIL');expect(output.eof).toBe(true);
  });

  it('rejects unknown sessions and per-write input overflow while keeping action replay idempotent',async()=>{
    const base=await root(),mgr=await manager(base),missing='f'.repeat(32);
    await expect(mgr.status(missing,D1)).rejects.toThrow(/SESSION_NOT_FOUND/);
    const started=await mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'echo',cwd:base,argv:[],lifetimeMs:5_000}},D1) as {sessionId:string};
    await expect(mgr.execute({kind:'PROCESS',action:'WRITE_INPUT',sessionId:started.sessionId,args:{ownerDigest:D1,data:'x'.repeat(4097)}},D2)).rejects.toThrow(/INPUT_INVALID/);
    const write={kind:'PROCESS',action:'WRITE_INPUT',sessionId:started.sessionId,args:{ownerDigest:D1,data:'once\n'}} as const;
    await expect(mgr.execute(write,D3)).resolves.toMatchObject({action:'WRITE_INPUT',replay:false});
    await expect(mgr.execute(write,D3)).resolves.toMatchObject({action:'WRITE_INPUT',replay:true});
    await delay(50);
    const output=await mgr.readOutput(started.sessionId,D1,0,65_536) as {chunks:Array<{dataBase64:string}>};
    const text=output.chunks.map(chunk=>Buffer.from(chunk.dataBase64,'base64').toString('utf8')).join('');
    expect(text).toBe('once\n');
    await mgr.terminate(started.sessionId,D1,D4);await terminal(mgr,started.sessionId,D1);
  });

  it('enforces lifetime timeout and bounded force-stop for SIGTERM-resistant sessions',async()=>{
    const base=await root(),mgr=await manager(base);
    const timed=await mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'no-stdin',cwd:base,argv:[],lifetimeMs:1_000}},D1) as {sessionId:string};
    await expect(terminal(mgr,timed.sessionId,D1)).resolves.toMatchObject({state:'FAILED',reason:'REMOTE_BRIDGE_PROCESS_TIMEOUT'});
    const stubborn=await mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'ignore-term',cwd:base,argv:[],lifetimeMs:5_000}},D2) as {sessionId:string};
    let ready=false;
    for(let attempt=0;attempt<100&&!ready;attempt++){
      const output=await mgr.readOutput(stubborn.sessionId,D2,0,65_536) as {chunks:Array<{dataBase64:string}>};
      ready=output.chunks.map(chunk=>Buffer.from(chunk.dataBase64,'base64').toString('utf8')).join('').includes('READY');
      if(!ready)await delay(10);
    }
    expect(ready).toBe(true);
    await expect(mgr.terminate(stubborn.sessionId,D2,D3)).resolves.toMatchObject({action:'TERMINATE'});
    await expect(terminal(mgr,stubborn.sessionId,D2)).resolves.toMatchObject({state:'TERMINATED',signal:'SIGKILL'});
  });

  it('captures and finalizes a short-lived allowlisted-style process without losing its output',async()=>{
    const base=await root(),mgr=await manager(base);
    const started=await mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'quick',cwd:base,argv:[],lifetimeMs:2_000}},D1) as {sessionId:string};
    await expect(terminal(mgr,started.sessionId,D1)).resolves.toMatchObject({state:'SUCCEEDED',exitCode:0});
    const output=await mgr.readOutput(started.sessionId,D1,0,65_536) as {eof:boolean;chunks:Array<{dataBase64:string}>};
    const text=output.chunks.map(chunk=>Buffer.from(chunk.dataBase64,'base64').toString('utf8')).join('');
    expect(text).toBe('QUICK');expect(output.eof).toBe(true);
  });

  it('marks mismatched process identity UNCERTAIN without signaling the unproven pid',async()=>{
    const base=await root(),mgr=await manager(base);
    const started=await mgr.execute({kind:'PROCESS',action:'START',args:{profileId:'no-stdin',cwd:base,argv:[],lifetimeMs:1_000}},D1) as {sessionId:string;pid:number};
    const sessionDir=join(base,'state',started.sessionId),recordPath=join(sessionDir,'record.json');
    await rm(join(sessionDir,'control.sock'),{force:true});
    const record=JSON.parse(await readFile(recordPath,'utf8')) as {identity:{startTimeTicks:string}};
    record.identity.startTimeTicks='0';await writeFile(recordPath,JSON.stringify(record)+'\n',{mode:0o600});
    await expect(mgr.status(started.sessionId,D1)).resolves.toMatchObject({state:'UNCERTAIN',reason:'REMOTE_BRIDGE_PROCESS_IDENTITY_MISMATCH'});
    expect(()=>process.kill(started.pid,0)).not.toThrow();
    await delay(1_200);
  });

  it('fails closed on a spec-only ambiguous START and never launches the same owner twice',async()=>{
    const base=await root(),state=join(base,'state');
    let launches=0;
    const mgr=createRemoteBridgeProcessSessions({
      root:state,
      resolveProfile:profiles(base),
      launchSupervisor:()=>{launches++;}
    });
    const operation={kind:'PROCESS',action:'START',args:{profileId:'echo',cwd:base,argv:[],lifetimeMs:5_000}} as const;
    const first=await mgr.execute(operation,D1).then(()=> 'PASS',error=>error instanceof Error?error.message:String(error));
    const replay=await mgr.execute(operation,D1).then(()=> 'PASS',error=>error instanceof Error?error.message:String(error));
    expect(first).toBe('REMOTE_BRIDGE_PROCESS_START_UNCERTAIN');
    expect(replay).toBe('REMOTE_BRIDGE_PROCESS_START_UNCERTAIN');
    expect(launches).toBe(1);
  });

  it('launches the default supervisor in an independent bai user-systemd unit without a shell',()=>{
    const launch=buildRemoteBridgeSupervisorLaunch('/srv/bridge/supervisor.js','/home/bai/state/abc/spec.json','0123456789abcdef0123456789abcdef',{
      HOME:'/home/bai',USER:'bai',LOGNAME:'bai',PATH:'/opt/ai-tool-fabric/runtime:/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:'/tmp',NO_COLOR:'1',XDG_RUNTIME_DIR:'/run/user/1001',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1001/bus'
    });
    expect(launch.command).toBe('/usr/bin/systemd-run');
    expect(launch.args).toContain('--user');
    expect(launch.args).toContain('--collect');
    expect(launch.args).toContain('--unit=cocwin-remote-bridge-process-0123456789abcdef0123456789abcdef.service');
    expect(launch.args).toContain('--property=KillMode=control-group');
    expect(launch.args).toContain('--property=UMask=0077');
    expect(launch.args).toContain('--setenv=XDG_RUNTIME_DIR=/run/user/1001');
    expect(launch.args).toContain('--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus');
    expect(launch.args.slice(-3)).toEqual(['/opt/ai-tool-fabric/runtime/node','/srv/bridge/supervisor.js','/home/bai/state/abc/spec.json']);
    expect(launch.options).toMatchObject({shell:false,detached:false,stdio:['ignore','ignore','pipe']});
    expect(launch.options.env).toMatchObject({XDG_RUNTIME_DIR:'/run/user/1001',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1001/bus'});
  });

});
