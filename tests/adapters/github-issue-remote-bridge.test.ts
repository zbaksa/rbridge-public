import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {createGitHubIssueRemoteBridge,type GhCommandRunner} from '../../src/adapters/githubIssueRemoteBridge.js';

const requestBody=JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',requestId:'bridge.req.1',createdAt:'2026-09-16T18:00:00.000Z',expiresAt:'2026-09-16T18:20:00.000Z',appId:'cocwin',jobId:'bridge-probe-1',operation:'RUN',payload:{tool:'probe',cwd:'/home/cocwin/backend',args:[],timeout_ms:30000,max_bytes:262144}});
const rows=[
  {number:48,title:'[COCWIN BRIDGE CONTROL] Remote Bridge v1 coordination',body:'{}',author:{login:'zbaksa'},url:'https://github.com/zbaksa/cocwin-private/issues/48'},
  {number:49,title:'[COCWIN BRIDGE REQUEST] bridge.req.1',body:requestBody,author:{login:'zbaksa'},url:'https://github.com/zbaksa/cocwin-private/issues/49'},
  {number:50,title:'[COCWIN BRIDGE REQUEST] other',body:'{}',author:{login:'someone'},url:'https://github.com/zbaksa/cocwin-private/issues/50'},
];
const result={schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1',requestId:'bridge.req.1',issueNumber:49,status:'PASS',requestSha256:'a'.repeat(64),resultSha256:'b'.repeat(64),controllerResult:{state:'SUCCEEDED'},completedAt:'2026-09-16T18:12:00.000Z'};
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function fenced(value:unknown){return '```json\n'+JSON.stringify(value,null,2)+'\n```\n';}
function jsonFromFence(body:string){return JSON.parse(body.replace(/^```json\n/,'').replace(/\n```\n$/,'')) as Record<string,unknown>;}

describe('GitHub issue remote bridge transport',()=>{
  it('lists only exact request-prefix issues authored by zbaksa from the pinned private repo',async()=>{
    const runner=vi.fn<GhCommandRunner>(async()=>({exitCode:0,stdout:JSON.stringify(rows),stderr:''}));
    const gh=createGitHubIssueRemoteBridge({runner});
    await expect(gh.listOpenRequests()).resolves.toEqual([{number:49,title:rows[1]!.title,body:requestBody,authorLogin:'zbaksa',url:rows[1]!.url}]);
    expect(runner).toHaveBeenCalledWith({command:'/usr/bin/gh',args:['issue','list','--repo','zbaksa/cocwin-private','--state','open','--limit','1000','--json','number,title,body,author,url'],timeoutMs:30000,maxOutputBytes:2_000_000});
  });

  it('publishes one fenced JSON result over stdin and closes only after comment succeeds',async()=>{
    const runner=vi.fn<GhCommandRunner>().mockResolvedValue({exitCode:0,stdout:'ok',stderr:''});const gh=createGitHubIssueRemoteBridge({runner});
    await gh.publishResult(49,result);
    expect(runner).toHaveBeenCalledTimes(2);
    const comment=runner.mock.calls[0]![0];expect(comment.command).toBe('/usr/bin/gh');expect(comment.args).toEqual(['issue','comment','49','--repo','zbaksa/cocwin-private','--body-file','-']);
    expect(comment.stdin).toBe(fenced(result));
    expect(runner.mock.calls[1]![0].args).toEqual(['issue','close','49','--repo','zbaksa/cocwin-private','--reason','completed']);
  });

  it('fails closed on list/auth ambiguity and does not invent requests',async()=>{
    const gh=createGitHubIssueRemoteBridge({runner:async()=>({exitCode:1,stdout:'',stderr:'auth failed'})});
    await expect(gh.listOpenRequests()).rejects.toThrow('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED');
  });

  it('does not close when result publication fails and rejects oversized comments only when resumable publication cannot be formed',async()=>{
    const runner=vi.fn<GhCommandRunner>().mockResolvedValueOnce({exitCode:1,stdout:'',stderr:'no'});const gh=createGitHubIssueRemoteBridge({runner});
    await expect(gh.publishResult(49,result)).rejects.toThrow('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED');expect(runner).toHaveBeenCalledTimes(1);
  });

  it('publishes oversized results as digest-bound numbered chunks under 60000 bytes plus a final manifest',async()=>{
    const calls:Parameters<GhCommandRunner>[0][]=[];
    const runner=vi.fn<GhCommandRunner>(async input=>{calls.push(input);if(input.args[1]==='view')return {exitCode:0,stdout:JSON.stringify({comments:[]}),stderr:''};return {exitCode:0,stdout:'ok',stderr:''};});
    const gh=createGitHubIssueRemoteBridge({runner});
    const huge={...result,controllerResult:{state:'SUCCEEDED',stdout:'abc123-'.repeat(30_000)}};
    await gh.publishResult(49,huge);
    const comments=calls.filter(call=>call.args[1]==='comment');
    expect(comments.length).toBeGreaterThan(2);
    expect(comments.every(call=>Buffer.byteLength(call.stdin??'')<60_000)).toBe(true);
    const envelopes=comments.map(call=>jsonFromFence(call.stdin!));
    const chunks=envelopes.filter(row=>row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1');
    const manifest=envelopes.at(-1)!;
    expect(manifest.schema).toBe('COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1');
    expect(manifest.count).toBe(chunks.length);
    expect(chunks.map(row=>row.index)).toEqual(chunks.map((_,index)=>index));
    const data=Buffer.concat(chunks.map(row=>Buffer.from(String(row.dataBase64),'base64')));
    expect(hash(data)).toBe(manifest.objectSha256);
    expect(data.toString('utf8')).toBe(JSON.stringify(huge));
    expect(calls.at(-1)!.args).toEqual(['issue','close','49','--repo','zbaksa/cocwin-private','--reason','completed']);
  });

  it('resumes oversized publication by skipping an already published identical chunk',async()=>{
    const huge={...result,controllerResult:{state:'SUCCEEDED',stdout:'z'.repeat(90_000)}};
    const bytes=Buffer.from(JSON.stringify(huge)),objectSha256=hash(bytes),transferId=`result-${objectSha256}`;
    const first=bytes.subarray(0,40_000);
    const existing=fenced({schema:'COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1',transferId,index:0,count:Math.ceil(bytes.length/40_000),dataBase64:first.toString('base64'),chunkSha256:hash(first),objectSha256});
    const calls:Parameters<GhCommandRunner>[0][]=[];
    const runner=vi.fn<GhCommandRunner>(async input=>{calls.push(input);if(input.args[1]==='view')return {exitCode:0,stdout:JSON.stringify({comments:[{body:existing}]}),stderr:''};return {exitCode:0,stdout:'ok',stderr:''};});
    await createGitHubIssueRemoteBridge({runner}).publishResult(49,huge);
    const posted=calls.filter(call=>call.args[1]==='comment').map(call=>jsonFromFence(call.stdin!));
    expect(posted.some(row=>row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1'&&row.index===0)).toBe(false);
    expect(posted.some(row=>row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1'&&row.objectSha256===objectSha256)).toBe(true);
  });
});