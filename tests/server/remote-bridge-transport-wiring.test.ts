import {userInfo} from 'node:os';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createGitHubIssueRemoteBridge} from '../../src/adapters/githubIssueRemoteBridge.js';
import {runRemoteBridgeMain} from '../../src/server/remoteBridgeMain.js';

vi.mock('../../src/adapters/githubIssueRemoteBridge.js',async importOriginal=>({
  ...await importOriginal<typeof import('../../src/adapters/githubIssueRemoteBridge.js')>(),
  createGitHubIssueRemoteBridge:vi.fn(()=>{throw new Error('STOP_AFTER_TRANSPORT_CONFIGURATION');})
}));
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
function configure(){
  vi.stubEnv('RBRIDGE_RUNTIME_USER',userInfo().username);
  vi.stubEnv('RBRIDGE_GITHUB_REPOSITORY','example/control');
  vi.stubEnv('RBRIDGE_GITHUB_AUTHOR','owner');
  vi.stubEnv('RBRIDGE_GITHUB_MAX_OUTPUT_BYTES','16777216');
  vi.stubEnv('RBRIDGE_GITHUB_TIMEOUT_MS','90000');
  vi.spyOn(process,'getuid').mockReturnValue(1200);
}
describe('real main transport configuration',()=>{
  it('passes the validated limits to the actual transport construction boundary',async()=>{
    configure();await expect(runRemoteBridgeMain()).rejects.toThrow('STOP_AFTER_TRANSPORT_CONFIGURATION');
    expect(createGitHubIssueRemoteBridge).toHaveBeenCalledExactlyOnceWith({repository:'example/control',authorLogin:'owner',maxOutputBytes:16_777_216,timeoutMs:90_000});
  });
  it('rejects invalid configuration before constructing the transport or polling',async()=>{
    configure();vi.stubEnv('RBRIDGE_GITHUB_MAX_OUTPUT_BYTES','unbounded');
    await expect(runRemoteBridgeMain()).rejects.toThrow('REMOTE_BRIDGE_GITHUB_MAX_OUTPUT_CONFIG_INVALID');
    expect(createGitHubIssueRemoteBridge).not.toHaveBeenCalled();
  });
});
