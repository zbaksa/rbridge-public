import {describe,expect,it} from 'vitest';
import {resolveRemoteBridgeProcessCommandProfile} from '../../src/domain/remoteBridgeHostProfiles.js';

describe('Stage-2 source-controlled PROCESS command profiles',()=>{
  it('uses fixed executables and a fixed stdin canary program with no request-controlled script',()=>{
    const echo=resolveRemoteBridgeProcessCommandProfile('stdin-echo',[]);
    expect(echo.executable).toBe('/opt/ai-tool-fabric/runtime/node');
    expect(echo.args[0]).toBe('-e');expect(echo.args).toHaveLength(2);
    expect(echo.cwdRoots).toEqual(['/mnt/data']);expect(echo.stdinMode).toBe('UTF8');
    expect(echo.maxInputBytes).toBeGreaterThan(0);expect(echo.forceKillAfterMs).toBeGreaterThan(0);
  });

  it('does not turn git or node profiles into an arbitrary command surface',()=>{
    expect(resolveRemoteBridgeProcessCommandProfile('git-read',['--version']).args).toEqual(['--version']);
    expect(resolveRemoteBridgeProcessCommandProfile('node-safe',['--version']).args).toEqual(['--version']);
    expect(()=>resolveRemoteBridgeProcessCommandProfile('git-read',['status','--short','--branch'])).toThrow(/ARGS_NOT_ALLOWED/);
    expect(()=>resolveRemoteBridgeProcessCommandProfile('node-safe',['-e','process.exit()'])).toThrow(/ARGS_NOT_ALLOWED/);
    expect(()=>resolveRemoteBridgeProcessCommandProfile('stdin-echo',['request-controlled.js'])).toThrow(/ARGS_NOT_ALLOWED/);
    expect(()=>resolveRemoteBridgeProcessCommandProfile('shell',[])).toThrow(/PROFILE_NOT_ALLOWED/);
  });
});
