import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {createGitHubIssueRemoteBridge,type GhCommandInput,type GhCommandRunner} from '../../src/adapters/githubIssueRemoteBridge.js';

const REPO='example/rbridge-control',AUTHOR='bridge-owner',PREFIX='[COCWIN BRIDGE REQUEST] ';
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const fenced=(value:unknown)=>'```json\n'+JSON.stringify(value,null,2)+'\n```\n';
const parseFence=(body:string)=>JSON.parse(body.slice(8,-5)) as Record<string,unknown>;
const result={schema:'COCWIN_REMOTE_BRIDGE_RESULT_V1',requestId:'bridge.req.1',issueNumber:49,status:'PASS',completedAt:'2026-11-27T00:00:00.000Z'};
type Row={number:number;title:string;body:string;author:{login:string};url:string;state:string};
function row(number:number,overrides:Partial<Row>={}):Row{return {number,title:PREFIX+number,body:'{"requestId":"request.'+number+'"}',author:{login:AUTHOR},url:`https://github.com/${REPO}/issues/${number}`,state:'OPEN',...overrides};}
type Request={query:string;variables:Record<string,unknown>};
function queryOf(input:GhCommandInput):Request{
  expect(input.command).toBe('/usr/bin/gh');expect(input.args).toEqual(['api','graphql','--input','-']);
  return JSON.parse(input.stdin!) as Request;
}
function api(issues:Row[]=[],comments:{body:string}[]=[],options:{detail?:(value:Row)=>Row;transform?:(value:Record<string,unknown>,request:Request)=>unknown;commandFailure?:string}={}){
  const calls:GhCommandInput[]=[],bodyReads:number[]=[];
  const runner:GhCommandRunner=async input=>{
    calls.push(input);if(options.commandFailure)return {exitCode:1,stdout:'',stderr:options.commandFailure};
    let response:unknown;
    // The legacy path reproduces the aggregate-output overflow before repair.
    if(input.args[0]==='issue'&&input.args[1]==='list')response=issues;
    else if(input.args[0]==='issue'&&input.args[1]==='view')response={comments};
    else if(input.args[0]==='issue')return {exitCode:0,stdout:'ok',stderr:''};
    else{
      const request=queryOf(input),{query,variables}=request;
      expect(variables.owner).toBe('example');expect(variables.name).toBe('rbridge-control');
      const first=Number(variables.first),start=variables.after===null?0:Number(variables.after);
      if(query.includes('issues(')){
        expect(query).toContain('createdBy: $author');expect(variables.author).toBe(AUTHOR);
        expect(query).not.toMatch(/\bbody\b/);expect(query).not.toContain('search(');
        const page=issues.slice(start,start+first).map(value=>({number:value.number,title:value.title,author:value.author,url:value.url,state:value.state}));
        response={data:{repository:{nameWithOwner:REPO,issues:{nodes:page,pageInfo:{hasNextPage:start+first<issues.length,endCursor:String(start+page.length)}}}}};
      }else if(query.includes('comments(')){
        expect(variables.number).toBe(49);const page=comments.slice(start,start+first);
        response={data:{repository:{nameWithOwner:REPO,issue:{number:49,comments:{nodes:page,pageInfo:{hasNextPage:start+first<comments.length,endCursor:String(start+page.length)}}}}}};
      }else{
        const n=Number(variables.number);bodyReads.push(n);const item=issues.find(value=>value.number===n);
        response={data:{repository:{nameWithOwner:REPO,issue:item?(options.detail?.(item)??item):null}}};
      }
      if(options.transform)response=options.transform(response as Record<string,unknown>,request);
    }
    const stdout=JSON.stringify(response);
    if(Buffer.byteLength(stdout)>input.maxOutputBytes)throw new Error('REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE');
    return {exitCode:0,stdout,stderr:''};
  };
  return {runner,calls,bodyReads,posted:()=>calls.filter(call=>call.args[1]==='comment').map(call=>parseFence(call.stdin!))};
}
function existingChunks(huge:unknown){
  const bytes=Buffer.from(JSON.stringify(huge)),objectSha256=hash(bytes),transferId=`result-${objectSha256}`,count=Math.ceil(bytes.length/40_000);
  return Array.from({length:count},(_,index)=>{const data=bytes.subarray(index*40_000,(index+1)*40_000);return {body:fenced({schema:'COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1',transferId,index,count,dataBase64:data.toString('base64'),chunkSha256:hash(data),objectSha256})};});
}

describe('bounded GitHub transport regressions',()=>{
  it('discovers trusted requests without downloading more than 2 MB of unrelated bodies',async()=>{
    const transport=api([...Array.from({length:80},(_,i)=>row(i+1,{title:'unrelated task',body:'x'.repeat(60_000)})),row(101),row(102,{author:{login:'someone'}})]);
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner,maxOutputBytes:2_000_000}).listOpenRequests()).resolves.toEqual([{number:101,title:PREFIX+'101',body:row(101).body,authorLogin:AUTHOR,url:row(101).url}]);
    expect(transport.bodyReads).toEqual([101]);
  });
  it('follows metadata cursors beyond 1000 items and returns requests in number order',async()=>{
    const transport=api([...Array.from({length:1001},(_,i)=>row(i+1,{title:'unrelated'})),row(2000),row(1500)]);
    const requests=await createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).listOpenRequests();
    expect(requests.map(value=>value.number)).toEqual([1500,2000]);expect(transport.bodyReads).toEqual([2000,1500]);
  });
  it.each([{state:'CLOSED'},{title:'renamed unrelated issue'},{title:PREFIX+'different-request'},{author:{login:'someone'}}])('rechecks candidates after metadata selection: %j',async change=>{
    const transport=api([row(49)],[],{detail:value=>({...value,...change})});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).listOpenRequests()).resolves.toEqual([]);
  });
  it('rejects an issue number mismatch before returning a candidate',async()=>{
    const transport=api([row(49)],[],{detail:value=>({...value,number:50})});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).listOpenRequests()).rejects.toThrow('REMOTE_BRIDGE_GITHUB_ISSUE_INVALID');
  });
  it('rejects a response bound to another repository',async()=>{
    const transport=api([row(49)],[],{transform:()=>({data:{repository:{nameWithOwner:'other/repository',issues:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}})});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).listOpenRequests()).rejects.toThrow('REMOTE_BRIDGE_GITHUB_REPOSITORY_MISMATCH');
  });
  it('rejects partial GraphQL errors',async()=>{
    const transport=api([row(49)],[],{transform:value=>({...value,errors:[{message:'unavailable'}]})});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).listOpenRequests()).rejects.toThrow('REMOTE_BRIDGE_GITHUB_API_ERRORS');
  });
  it.each([{hasNextPage:true,endCursor:null},{hasNextPage:'false',endCursor:null},{hasNextPage:true,endCursor:'stuck'}])('rejects invalid or repeated pagination state: %j',async pageInfo=>{
    const transport=api([],[],{transform:()=>({data:{repository:{nameWithOwner:REPO,issues:{nodes:[],pageInfo}}}})});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).listOpenRequests()).rejects.toThrow('REMOTE_BRIDGE_GITHUB_PAGINATION_INVALID');expect(transport.calls.length).toBeLessThanOrEqual(2);
  });
  it('does not return earlier candidates when a later page fails',async()=>{
    const transport=api(Array.from({length:101},(_,i)=>row(i+1)),[],{transform:(value,request)=>request.query.includes('issues(')&&request.variables.after!==null?{errors:[{message:'rate limited'}]}:value});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).listOpenRequests()).rejects.toThrow('REMOTE_BRIDGE_GITHUB_API_ERRORS');
  });
  it('rejects a repeated cursor even when the later page claims to be terminal',async()=>{
    const transport=api([row(49)],[],{transform:(value,request)=>request.query.includes('issues(')
      ? {data:{repository:{nameWithOwner:REPO,issues:{nodes:request.variables.after===null?[row(49)]:[],pageInfo:{hasNextPage:request.variables.after===null,endCursor:'A'}}}}}
      : value});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).listOpenRequests()).rejects.toThrow('REMOTE_BRIDGE_GITHUB_PAGINATION_INVALID');
  });
  it.each([null,{body:null},{},42])('rejects unreadable publication history %j without posting or closing',async node=>{
    const transport=api([],[],{transform:()=>({data:{repository:{nameWithOwner:REPO,issue:{number:49,comments:{nodes:[node],pageInfo:{hasNextPage:false,endCursor:null}}}}}})});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).publishResult(49,{...result,stdout:'z'.repeat(90_000)})).rejects.toThrow('REMOTE_BRIDGE_GITHUB_COMMENTS_INVALID');
    expect(transport.posted()).toEqual([]);expect(transport.calls.some(call=>call.args[1]==='close')).toBe(false);
  });
  it('identifies the failing command stage without request contents',async()=>{
    const transport=api([],[],{commandFailure:'auth failed'});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).listOpenRequests()).rejects.toThrow(/REMOTE_BRIDGE_GITHUB_COMMAND_FAILED.*list-metadata/);
  });
  it('resumes existing chunks whose aggregate comments exceed 2 MB',async()=>{
    const huge={...result,stdout:'z'.repeat(1_600_000)},comments=existingChunks(huge);expect(Buffer.byteLength(JSON.stringify({comments}))).toBeGreaterThan(2_000_000);
    const transport=api([],comments);await createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner,maxOutputBytes:2_000_000}).publishResult(49,huge);
    expect(transport.posted().map(value=>value.schema)).toEqual(['COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1']);
  });
  it('shrinks overflowing comment pages at the same cursor without losing chunks',async()=>{
    const huge={...result,stdout:'z'.repeat(90_000)},comments=[...Array.from({length:10},()=>({body:'\u0001'.repeat(60_000)})),...existingChunks(huge)],transport=api([],comments);
    await createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner,maxOutputBytes:1_048_576}).publishResult(49,huge);
    expect(transport.posted().map(value=>value.schema)).toEqual(['COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1']);
    const starts=transport.calls.filter(call=>call.args[0]==='api').map(call=>queryOf(call).variables);
    expect(starts.slice(0,3)).toEqual([expect.objectContaining({after:null,first:10}),expect.objectContaining({after:null,first:5}),expect.objectContaining({after:null,first:2})]);
  });
  it('detects conflicting chunks across pages before writing',async()=>{
    const huge={...result,stdout:'z'.repeat(90_000)},chunks=existingChunks(huge),changed=parseFence(chunks[0]!.body);changed.chunkSha256='f'.repeat(64);
    const transport=api([],[chunks[0]!,...Array.from({length:9},()=>({body:'unrelated'})),{body:fenced(changed)}]);
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner}).publishResult(49,huge)).rejects.toThrow('REMOTE_BRIDGE_GITHUB_RESUME_COLLISION');expect(transport.posted()).toEqual([]);expect(transport.calls.some(call=>call.args[1]==='close')).toBe(false);
  });
  it('uses configured command budgets for reads and writes',async()=>{
    const transport=api([row(49)]),bridge=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner,maxOutputBytes:16_777_216,timeoutMs:90_000});
    await bridge.listOpenRequests();await bridge.publishResult(49,result);expect(transport.calls.length).toBeGreaterThan(2);expect(transport.calls.every(call=>call.maxOutputBytes===16_777_216&&call.timeoutMs===90_000)).toBe(true);
  });
  it.each([0,1_048_575,33_554_433,Infinity,NaN,1_048_576.5])('rejects invalid output budget %s before commands',value=>{
    const transport=api();expect(()=>createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:transport.runner,maxOutputBytes:value})).toThrow('REMOTE_BRIDGE_GITHUB_MAX_OUTPUT_CONFIG_INVALID');expect(transport.calls).toEqual([]);
  });
  it.each([0,999,120_001,Infinity,1_000.5])('rejects invalid command timeout %s',value=>{
    expect(()=>createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,runner:api().runner,timeoutMs:value})).toThrow('REMOTE_BRIDGE_GITHUB_TIMEOUT_CONFIG_INVALID');
  });
});
