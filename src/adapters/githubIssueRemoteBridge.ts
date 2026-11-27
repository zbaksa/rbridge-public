import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

export interface GhCommandInput {command:string;args:string[];stdin?:string;timeoutMs:number;maxOutputBytes:number;}
export interface GhCommandOutput {exitCode:number;stdout:string;stderr:string;}
export type GhCommandRunner=(input:GhCommandInput)=>Promise<GhCommandOutput>;
export interface GitHubBridgeIssue {number:number;title:string;body:string;authorLogin:string;url:string;}
export interface GitHubTransportLimits {maxOutputBytes:number;timeoutMs:number;}
export interface GitHubIssueRemoteBridgeOptions {runner?:GhCommandRunner;repository:string;authorLogin:string;maxOutputBytes?:number;timeoutMs?:number;}
const COMMAND='/usr/bin/gh',PREFIX='[COCWIN BRIDGE REQUEST] ',MAX_COMMENT=60_000,MAX_RAW_CHUNK=40_000;
const ISSUE_PAGE_SIZE=100,COMMENT_PAGE_SIZE=10;
const ISSUE_METADATA_QUERY=`query($owner: String!, $name: String!, $author: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(states: OPEN, filterBy: {createdBy: $author}, orderBy: {field: CREATED_AT, direction: ASC}, first: $first, after: $after) {
      nodes {number title author {login} url state}
      pageInfo {hasNextPage endCursor}
    }
  }
}`;
const ISSUE_BODY_QUERY=`query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) {number title body author {login} url state}
  }
}`;
const COMMENTS_QUERY=`query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) {
      number
      comments(first: $first, after: $after) {nodes {body} pageInfo {hasNextPage endCursor}}
    }
  }
}`;
function fail(code:string,detail?:string):never{throw new Error(detail?`${code}:${detail}`:code);}
export function resolveGitHubTransportLimits(input:Partial<GitHubTransportLimits>={}):GitHubTransportLimits{
  const maxOutputBytes=input.maxOutputBytes??16_777_216,timeoutMs=input.timeoutMs??30_000;
  if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1_048_576||maxOutputBytes>33_554_432)fail('REMOTE_BRIDGE_GITHUB_MAX_OUTPUT_CONFIG_INVALID');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120_000)fail('REMOTE_BRIDGE_GITHUB_TIMEOUT_CONFIG_INVALID');
  return {maxOutputBytes,timeoutMs};
}
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const defaultRunner:GhCommandRunner=async input=>await new Promise((resolve,reject)=>{
  const child=spawn(input.command,input.args,{shell:false,stdio:['pipe','pipe','pipe']});
  const stdout:Buffer[]=[],stderr:Buffer[]=[];let outBytes=0,errBytes=0,settled=false;
  const done=(error?:Error,exitCode?:number)=>{
    if(settled)return;settled=true;clearTimeout(timer);
    if(error){child.kill('SIGKILL');reject(error);}
    else resolve({exitCode:exitCode??-1,stdout:Buffer.concat(stdout,outBytes).toString('utf8'),stderr:Buffer.concat(stderr,errBytes).toString('utf8')});
  };
  const add=(stream:'stdout'|'stderr',chunk:Buffer)=>{
    if(settled)return;
    const size=(stream==='stdout'?outBytes:errBytes)+chunk.byteLength;
    if(size>input.maxOutputBytes){done(new Error(`REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE:${stream}:${size}>${input.maxOutputBytes}`));return;}
    if(stream==='stdout'){outBytes=size;stdout.push(chunk);}else{errBytes=size;stderr.push(chunk);}
  };
  child.stdout.on('data',(c:Buffer)=>add('stdout',c));child.stderr.on('data',(c:Buffer)=>add('stderr',c));
  child.on('error',e=>done(e));child.on('close',code=>done(undefined,code??-1));child.stdin.on('error',e=>done(e));
  const timer=setTimeout(()=>done(new Error('REMOTE_BRIDGE_GITHUB_TIMEOUT')),input.timeoutMs);child.stdin.end(input.stdin??'');
});
function issueNumber(value:number){if(!Number.isSafeInteger(value)||value<1)fail('REMOTE_BRIDGE_GITHUB_ISSUE_INVALID');return String(value);}
function fence(value:unknown){return `\`\`\`json\n${JSON.stringify(value,null,2)}\n\`\`\`\n`;}
function parseFence(value:unknown):Record<string,unknown>|undefined{if(typeof value!=='string'||!value.startsWith('```json\n')||!value.endsWith('\n```\n'))return undefined;try{const parsed=JSON.parse(value.slice(8,-5));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:undefined;}catch{return undefined;}}

export function createGitHubIssueRemoteBridge(options:GitHubIssueRemoteBridgeOptions){
  const runner=options.runner??defaultRunner,repository=options.repository,authorLogin=options.authorLogin;
  if(typeof repository!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))fail('REMOTE_BRIDGE_GITHUB_REPOSITORY_CONFIG_INVALID');
  if(typeof authorLogin!=='string'||!/^[A-Za-z0-9-]{1,39}$/.test(authorLogin))fail('REMOTE_BRIDGE_GITHUB_AUTHOR_CONFIG_INVALID');
  const limits=resolveGitHubTransportLimits(options),[owner,name]=repository.split('/');
  async function run(args:string[],stage:string,stdin?:string){
    let out:GhCommandOutput;
    try{out=await runner({command:COMMAND,args,...(stdin===undefined?{}:{stdin}),...limits});}
    catch(error){fail('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED',`${stage}:${error instanceof Error?error.message:'UNKNOWN'}`);}
    if(out.exitCode!==0)fail('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED',`${stage}:${out.stderr.replace(/\s+/g,' ').trim().slice(0,256)||`rc=${out.exitCode}`}`);
    return out.stdout;
  }
  function object(value:unknown,code:string):Record<string,unknown>{
    if(!value||typeof value!=='object'||Array.isArray(value))fail(code);return value as Record<string,unknown>;
  }
  async function graphql(query:string,variables:Record<string,unknown>,stage:string){
    const raw=await run(['api','graphql','--input','-'],stage,JSON.stringify({query,variables:{owner,name,...variables}}));
    let parsed:unknown;try{parsed=JSON.parse(raw);}catch{fail('REMOTE_BRIDGE_GITHUB_RESPONSE_INVALID',stage);}
    const response=object(parsed,'REMOTE_BRIDGE_GITHUB_RESPONSE_INVALID');
    if(Object.hasOwn(response,'errors')&&(!Array.isArray(response.errors)||response.errors.length))fail('REMOTE_BRIDGE_GITHUB_API_ERRORS',stage);
    const data=object(response.data,'REMOTE_BRIDGE_GITHUB_RESPONSE_INVALID'),repo=object(data.repository,'REMOTE_BRIDGE_GITHUB_RESPONSE_INVALID');
    if(typeof repo.nameWithOwner!=='string'||repo.nameWithOwner.toLowerCase()!==repository.toLowerCase())fail('REMOTE_BRIDGE_GITHUB_REPOSITORY_MISMATCH',stage);
    return repo;
  }
  function page(value:unknown,seen:Set<string>){
    const connection=object(value,'REMOTE_BRIDGE_GITHUB_PAGINATION_INVALID'),info=object(connection.pageInfo,'REMOTE_BRIDGE_GITHUB_PAGINATION_INVALID');
    if(!Array.isArray(connection.nodes)||typeof info.hasNextPage!=='boolean'||(info.endCursor!==null&&typeof info.endCursor!=='string'))fail('REMOTE_BRIDGE_GITHUB_PAGINATION_INVALID');
    if(info.endCursor!==null&&(!info.endCursor||seen.has(info.endCursor)))fail('REMOTE_BRIDGE_GITHUB_PAGINATION_INVALID');
    if(!info.hasNextPage)return {nodes:connection.nodes,after:null};
    if(typeof info.endCursor!=='string')fail('REMOTE_BRIDGE_GITHUB_PAGINATION_INVALID');
    seen.add(info.endCursor);return {nodes:connection.nodes,after:info.endCursor};
  }
  function issueRow(value:unknown){
    const row=object(value,'REMOTE_BRIDGE_GITHUB_ISSUE_INVALID'),author=object(row.author,'REMOTE_BRIDGE_GITHUB_ISSUE_INVALID');
    if(!Number.isSafeInteger(row.number)||Number(row.number)<1||typeof row.title!=='string'||typeof row.url!=='string'||typeof author.login!=='string'||!['OPEN','CLOSED'].includes(String(row.state)))fail('REMOTE_BRIDGE_GITHUB_ISSUE_INVALID');
    return {number:Number(row.number),title:row.title,url:row.url,authorLogin:author.login,state:row.state,body:row.body};
  }
  function matches(row:ReturnType<typeof issueRow>){return row.state==='OPEN'&&row.title.startsWith(PREFIX)&&row.authorLogin===authorLogin;}
  async function comment(issue:string,body:string){if(Buffer.byteLength(body)>=MAX_COMMENT)fail('REMOTE_BRIDGE_GITHUB_RESULT_TOO_LARGE');await run(['issue','comment',issue,'--repo',repository,'--body-file','-'],'publish-comment',body);}
  async function existingPublication(issue:string,transferId:string){
    const chunks=new Map<number,Record<string,unknown>>();let manifest:Record<string,unknown>|undefined;
    let after:string|null=null,first=COMMENT_PAGE_SIZE;const cursors=new Set<string>();
    while(true){
      let repo:Record<string,unknown>;
      try{repo=await graphql(COMMENTS_QUERY,{number:Number(issue),first,after},'resume-comments');}
      catch(error){
        if(first>1&&error instanceof Error&&error.message.includes('REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE')){first=Math.max(1,Math.floor(first/2));continue;}
        throw error;
      }
      const issueData=object(repo.issue,'REMOTE_BRIDGE_GITHUB_COMMENTS_INVALID');
      if(issueData.number!==Number(issue))fail('REMOTE_BRIDGE_GITHUB_ISSUE_INVALID');
      const next=page(issueData.comments,cursors);
      for(const item of next.nodes){
        const commentData=object(item,'REMOTE_BRIDGE_GITHUB_COMMENTS_INVALID');
        if(typeof commentData.body!=='string')fail('REMOTE_BRIDGE_GITHUB_COMMENTS_INVALID');
        const row=parseFence(commentData.body);if(!row||row.transferId!==transferId)continue;
        if(row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1'&&Number.isSafeInteger(row.index)){const index=Number(row.index);const previous=chunks.get(index);if(previous&&JSON.stringify(previous)!==JSON.stringify(row))fail('REMOTE_BRIDGE_GITHUB_RESUME_COLLISION');chunks.set(index,row);}
        else if(row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1'){if(manifest&&JSON.stringify(manifest)!==JSON.stringify(row))fail('REMOTE_BRIDGE_GITHUB_RESUME_COLLISION');manifest=row;}
      }
      after=next.after;
      if(after===null)break;
    }
    return {chunks,manifest};
  }
  async function publishLarge(issue:string,result:unknown){
    const data=Buffer.from(JSON.stringify(result),'utf8'),objectSha256=sha(data),transferId=`result-${objectSha256}`,count=Math.ceil(data.length/MAX_RAW_CHUNK);
    if(count<1||count>1024)fail('REMOTE_BRIDGE_GITHUB_RESULT_TOO_LARGE');const existing=await existingPublication(issue,transferId);
    for(let index=0;index<count;index++){const chunk=data.subarray(index*MAX_RAW_CHUNK,Math.min(data.length,(index+1)*MAX_RAW_CHUNK));const envelope={schema:'COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1',transferId,index,count,dataBase64:chunk.toString('base64'),chunkSha256:sha(chunk),objectSha256};const prior=existing.chunks.get(index);if(prior){if(JSON.stringify(prior)!==JSON.stringify(envelope))fail('REMOTE_BRIDGE_GITHUB_RESUME_COLLISION');continue;}await comment(issue,fence(envelope));}
    const manifest={schema:'COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1',transferId,count,totalBytes:data.length,objectSha256};if(existing.manifest){if(JSON.stringify(existing.manifest)!==JSON.stringify(manifest))fail('REMOTE_BRIDGE_GITHUB_RESUME_COLLISION');}else await comment(issue,fence(manifest));
  }
  return {
    async listOpenRequests():Promise<GitHubBridgeIssue[]>{
      const result:GitHubBridgeIssue[]=[],seenIssues=new Set<number>(),cursors=new Set<string>();let after:string|null=null;
      do{
        const repo=await graphql(ISSUE_METADATA_QUERY,{author:authorLogin,first:ISSUE_PAGE_SIZE,after},'list-metadata');
        const next=page(repo.issues,cursors);
        for(const item of next.nodes){
          const candidate=issueRow(item);if(!matches(candidate)||seenIssues.has(candidate.number))continue;seenIssues.add(candidate.number);
          const full=await graphql(ISSUE_BODY_QUERY,{number:candidate.number},'issue-body');
          // A candidate may have been deleted or transferred since its metadata page.
          if(full.issue===null)continue;
          const current=issueRow(full.issue);if(current.number!==candidate.number)fail('REMOTE_BRIDGE_GITHUB_ISSUE_INVALID');
          if(!matches(current)||current.title!==candidate.title)continue;if(typeof current.body!=='string')fail('REMOTE_BRIDGE_GITHUB_ISSUE_INVALID');
          result.push({number:current.number,title:current.title,body:current.body,authorLogin:current.authorLogin,url:current.url});
        }
        after=next.after;
      }while(after!==null);
      return result.sort((a,b)=>a.number-b.number);
    },
    async publishResult(issue:number,result:unknown):Promise<void>{const body=fence(result),n=issueNumber(issue);if(Buffer.byteLength(body)<MAX_COMMENT)await comment(n,body);else await publishLarge(n,result);await run(['issue','close',n,'--repo',repository,'--reason','completed'],'close-issue');},
  };
}
