import {describe,expect,it} from 'vitest';
import {resolveRemoteBridgeGitHubTransportConfig} from '../../src/server/remoteBridgeMain.js';

describe('GitHub transport runtime configuration',()=>{
  it('provides the agreed 16 MiB output reserve with the existing 30-second timeout',()=>{
    expect(resolveRemoteBridgeGitHubTransportConfig({})).toEqual({maxOutputBytes:16_777_216,timeoutMs:30_000});
  });
  it('accepts a strict decimal override and both ends of the supported ranges',()=>{
    expect(resolveRemoteBridgeGitHubTransportConfig({RBRIDGE_GITHUB_MAX_OUTPUT_BYTES:'2000000',RBRIDGE_GITHUB_TIMEOUT_MS:'90000'})).toEqual({maxOutputBytes:2_000_000,timeoutMs:90_000});
    expect(resolveRemoteBridgeGitHubTransportConfig({RBRIDGE_GITHUB_MAX_OUTPUT_BYTES:'1048576',RBRIDGE_GITHUB_TIMEOUT_MS:'1000'})).toEqual({maxOutputBytes:1_048_576,timeoutMs:1000});
    expect(resolveRemoteBridgeGitHubTransportConfig({RBRIDGE_GITHUB_MAX_OUTPUT_BYTES:'33554432',RBRIDGE_GITHUB_TIMEOUT_MS:'120000'})).toEqual({maxOutputBytes:33_554_432,timeoutMs:120_000});
  });
  it.each(['',' 16777216','16777216 ','0','-1','0x1000000','1e7','16777216.0','16777216bytes','NaN','Infinity','1048575','33554433','999999999999999999999'])('rejects an invalid byte value %j before intake',value=>{
    expect(()=>resolveRemoteBridgeGitHubTransportConfig({RBRIDGE_GITHUB_MAX_OUTPUT_BYTES:value})).toThrow('REMOTE_BRIDGE_GITHUB_MAX_OUTPUT_CONFIG_INVALID');
  });
  it.each(['','0','999','120001','30s','3e4','30000.0',' 30000'])('rejects an invalid timeout %j before intake',value=>{
    expect(()=>resolveRemoteBridgeGitHubTransportConfig({RBRIDGE_GITHUB_TIMEOUT_MS:value})).toThrow('REMOTE_BRIDGE_GITHUB_TIMEOUT_CONFIG_INVALID');
  });
});
