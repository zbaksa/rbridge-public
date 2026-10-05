import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {createGitHubIssueRemoteBridge,type GhCommandRunner} from '../../src/adapters/githubIssueRemoteBridge.js';

const REPO='example/rbridge-control',AUTHOR='bridge-owner';
const requestBody=JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',requestId:'bridge.req.1',createdAt:'2026-09-16T18:00:00.000Z',expiresAt:'2026-09-16T18:20:00.000Z',appId:'cocwin',jobId:'bridge-probe-1',operation:'RUN',payload:{tool:'probe',cwd:'/home/cocwin/backend',args:[],timeout_ms:30000,max_bytes:262144}});
const rows=[
  {number:48,title:'[COCWIN BRIDGE CONTROL] Remote Bridge v1 coordination',body:'{}',author:{login:AUTHOR},url:'https://github.com/example/rbridge-control/issues/48'},
  {number:49,title:'[COCWIN BRIDGE REQUEST] bridge.req.1',body:requestBody,author:{login:AUTHOR},url:'https://github.com/example/rbridge-control/issues/49'},
  {number:50,title:'[COCWIN BRIDGE REQUEST] other',body:'{}',author:{login:'someone'},url:'https://github.com/example/rbridge-control/issues/50'},
];
const result={schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1',requestId:'bridge.req.1',issueNumber:49,status:'PASS',requestSha256:'a'.repeat(64),resultSha256:'b'.repeat(64),controllerResult:{state:'SUCCEEDED'},completedAt:'2026-09-16T18:12:00.000Z'};
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
describe('bounded core GitHub API primitives',()=>{
  it('reads exact issue and bounded comment pages from the configured repository',async()=>{
    const calls:Parameters<GhCommandRunner>[0][]=[],comment={id:99,body:'hello',user:{login:AUTHOR},html_url:'https://github.com/'+REPO+'/issues/49#issuecomment-99'};
    const runner:GhCommandRunner=async input=>{calls.push(input);return {exitCode:0,stderr:'',stdout:JSON.stringify(input.args.some(a=>a.includes('/comments?'))?[comment]:{number:49,title:rows[1]!.title,body:requestBody,user:{login:AUTHOR},html_url:rows[1]!.url,state:'open'})};};
    const gh=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner});
    expect(await gh.readIssue(49)).toEqual({number:49,title:rows[1]!.title,body:requestBody,authorLogin:AUTHOR,url:rows[1]!.url,state:'open'});
    expect(await gh.readCommentPage(49,2)).toEqual([{id:99,body:'hello',authorLogin:AUTHOR,url:comment.html_url}]);
    expect(calls[1]!.args).toEqual(['api','--hostname','github.com','repos/'+REPO+'/issues/49/comments?per_page=20&page=2']);
    expect(calls.every(c=>c.command==='/usr/bin/gh'&&c.timeoutMs===30000&&c.maxOutputBytes===2000000)).toBe(true);
    const before=calls.length;for(const page of [0,53,1.5])await expect(gh.readCommentPage(49,page)).rejects.toThrow();expect(calls).toHaveLength(before);
  });
  it('posts bounded JSON over stdin and independently closes the fixed issue',async()=>{
    const calls:Parameters<GhCommandRunner>[0][]=[],body='```json\n{}\n```\n';
    const runner:GhCommandRunner=async input=>{calls.push(input);return {exitCode:0,stderr:'',stdout:JSON.stringify({id:100,body,user:{login:AUTHOR},html_url:'https://github.com/'+REPO+'/issues/49#issuecomment-100'})};};
    const gh=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner});expect((await gh.postComment(49,body)).id).toBe(100);await gh.closeIssue(49);
    expect(calls[0]!.args).toEqual(['api','--hostname','github.com','--method','POST','repos/'+REPO+'/issues/49/comments','--input','-']);expect(calls[0]!.stdin).toBe(JSON.stringify({body}));expect(calls[1]!.args).toEqual(['issue','close','49','--repo',REPO,'--reason','completed']);
    await expect(gh.postComment(49,'x'.repeat(60000))).rejects.toThrow();expect(calls).toHaveLength(2);
  });
  it('refuses oversized responses, pull requests and foreign issue or comment identities',async()=>{
    for(const stdout of ['x'.repeat(2000001),JSON.stringify({number:49,pull_request:{},title:rows[1]!.title,body:requestBody,user:{login:AUTHOR},html_url:rows[1]!.url,state:'open'}),JSON.stringify({number:49,title:rows[1]!.title,body:requestBody,user:{login:AUTHOR},html_url:'https://github.com/evil/repo/issues/49',state:'open'})]){
      const gh=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:async()=>({exitCode:0,stdout,stderr:''})});await expect(gh.readIssue(49)).rejects.toThrow();
    }
    const gh=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:async()=>({exitCode:0,stderr:'',stdout:JSON.stringify({id:1,body:'hello',user:{login:'attacker'},html_url:'https://github.com/'+REPO+'/issues/49#issuecomment-1'})})});await expect(gh.postComment(49,'hello')).rejects.toThrow();
  });
});
function fenced(value:unknown){return '```json\n'+JSON.stringify(value,null,2)+'\n```\n';}
function jsonFromFence(body:string){return JSON.parse(body.replace(/^```json\n/,'').replace(/\n```\n$/,'')) as Record<string,unknown>;}

describe('GitHub issue remote bridge transport',()=>{
  it('lists only exact request-prefix issues authored by the configured owner from the configured repository',async()=>{
    const runner=vi.fn<GhCommandRunner>(async()=>({exitCode:0,stdout:JSON.stringify(rows),stderr:''}));
    const gh=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner});
    await expect(gh.listOpenRequests()).resolves.toEqual([{number:49,title:rows[1]!.title,body:requestBody,authorLogin:AUTHOR,url:rows[1]!.url}]);
    expect(runner).toHaveBeenCalledWith({command:'/usr/bin/gh',args:['issue','list','--repo',REPO,'--state','open','--limit','1000','--json','number,title,body,author,url'],timeoutMs:30000,maxOutputBytes:2_000_000});
  });

  it('publishes one fenced JSON result over stdin and closes only after comment succeeds',async()=>{
    const runner=vi.fn<GhCommandRunner>().mockResolvedValue({exitCode:0,stdout:'ok',stderr:''});const gh=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner});
    await gh.publishResult(49,result);
    expect(runner).toHaveBeenCalledTimes(2);
    const comment=runner.mock.calls[0]![0];expect(comment.command).toBe('/usr/bin/gh');expect(comment.args).toEqual(['issue','comment','49','--repo',REPO,'--body-file','-']);
    expect(comment.stdin).toBe(fenced(result));
    expect(runner.mock.calls[1]![0].args).toEqual(['issue','close','49','--repo',REPO,'--reason','completed']);
  });

  it('fails closed on list/auth ambiguity and does not invent requests',async()=>{
    const gh=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:async()=>({exitCode:1,stdout:'',stderr:'auth failed'})});
    await expect(gh.listOpenRequests()).rejects.toThrow('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED');
  });

  it('does not close when result publication fails and rejects oversized comments only when resumable publication cannot be formed',async()=>{
    const runner=vi.fn<GhCommandRunner>().mockResolvedValueOnce({exitCode:1,stdout:'',stderr:'no'});const gh=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner});
    await expect(gh.publishResult(49,result)).rejects.toThrow('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED');expect(runner).toHaveBeenCalledTimes(1);
  });

  it('publishes oversized results as digest-bound numbered chunks under 60000 bytes plus a final manifest',async()=>{
    const calls:Parameters<GhCommandRunner>[0][]=[];
    const runner=vi.fn<GhCommandRunner>(async input=>{calls.push(input);if(input.args[1]==='view')return {exitCode:0,stdout:JSON.stringify({comments:[]}),stderr:''};return {exitCode:0,stdout:'ok',stderr:''};});
    const gh=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner});
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
    expect(calls.at(-1)!.args).toEqual(['issue','close','49','--repo',REPO,'--reason','completed']);
  });

  it('resumes oversized publication by skipping an already published identical chunk',async()=>{
    const huge={...result,controllerResult:{state:'SUCCEEDED',stdout:'z'.repeat(90_000)}};
    const bytes=Buffer.from(JSON.stringify(huge)),objectSha256=hash(bytes),transferId=`result-${objectSha256}`;
    const first=bytes.subarray(0,40_000);
    const existing=fenced({schema:'COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1',transferId,index:0,count:Math.ceil(bytes.length/40_000),dataBase64:first.toString('base64'),chunkSha256:hash(first),objectSha256});
    const calls:Parameters<GhCommandRunner>[0][]=[];
    const runner=vi.fn<GhCommandRunner>(async input=>{calls.push(input);if(input.args[1]==='view')return {exitCode:0,stdout:JSON.stringify({comments:[{body:existing}]}),stderr:''};return {exitCode:0,stdout:'ok',stderr:''};});
    await createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner}).publishResult(49,huge);
    const posted=calls.filter(call=>call.args[1]==='comment').map(call=>jsonFromFence(call.stdin!));
    expect(posted.some(row=>row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1'&&row.index===0)).toBe(false);
    expect(posted.some(row=>row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1'&&row.objectSha256===objectSha256)).toBe(true);
  });
});
