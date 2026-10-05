import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

export interface GhCommandInput {command:string;args:string[];stdin?:string;timeoutMs:number;maxOutputBytes:number;}
export interface GhCommandOutput {exitCode:number;stdout:string;stderr:string;}
export type GhCommandRunner=(input:GhCommandInput)=>Promise<GhCommandOutput>;
export interface GitHubBridgeIssue {number:number;title:string;body:string;authorLogin:string;url:string;}
export interface RBridgeGitHubComment {id:number;authorLogin:string;body:string;url:string;}
export interface RBridgeGitHubPort {
  readIssue(number:number):Promise<GitHubBridgeIssue&{state:'open'|'closed'}>;
  readCommentPage(number:number,page:number):Promise<readonly RBridgeGitHubComment[]>;
  postComment(number:number,body:string):Promise<RBridgeGitHubComment>;
  closeIssue(number:number):Promise<void>;
}
export interface GitHubIssueRemoteBridgeOptions {runner?:GhCommandRunner;repository:string;authorLogin:string;}
const COMMAND='/usr/bin/gh',PREFIX='[COCWIN BRIDGE REQUEST] ',MAX_OUTPUT=2_000_000,MAX_COMMENT=60_000,MAX_RAW_CHUNK=40_000;
function fail(code:string,detail?:string):never{throw new Error(detail?`${code}:${detail}`:code);}
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
export function createRBridgeGhOutput(){
  const chunks:{stdout:Buffer[];stderr:Buffer[]}={stdout:[],stderr:[]};let bytes=0,invalid=false;
  return {
    append(stream:'stdout'|'stderr',chunk:Buffer):void{
      if(invalid)fail('REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE');
      if(bytes+chunk.length>MAX_OUTPUT){invalid=true;fail('REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE');}
      if(chunk.length){bytes+=chunk.length;chunks[stream].push(Buffer.from(chunk));}
    },
    finish():Pick<GhCommandOutput,'stdout'|'stderr'>{
      if(invalid)fail('REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE');
      try{return {stdout:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks.stdout)),stderr:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks.stderr))};}catch{invalid=true;fail('RBRIDGE_GITHUB_RESPONSE_INVALID');}
    },
  };
}
const defaultRunner:GhCommandRunner=async input=>await new Promise((resolve,reject)=>{
  const child=spawn(input.command,input.args,{shell:false,stdio:['pipe','pipe','pipe']}),output=createRBridgeGhOutput();let settled=false;
  const done=(error?:Error,exitCode?:number)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(error);}else{try{resolve({exitCode:exitCode??-1,...output.finish()});}catch(error){reject(error);}}};
  const add=(stream:'stdout'|'stderr',chunk:Buffer)=>{if(settled)return;try{output.append(stream,chunk);}catch(error){done(error instanceof Error?error:new Error('REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE'));}};
  child.stdout.on('data',(c:Buffer)=>add('stdout',c));child.stderr.on('data',(c:Buffer)=>add('stderr',c));child.stdin.on('error',()=>done(new Error('REMOTE_BRIDGE_GITHUB_STDIN_FAILED')));child.on('error',e=>done(e));child.on('close',code=>done(undefined,code??-1));
  const timer=setTimeout(()=>done(new Error('REMOTE_BRIDGE_GITHUB_TIMEOUT')),input.timeoutMs);child.stdin.end(input.stdin??'');
});
function issueNumber(value:number){if(!Number.isSafeInteger(value)||value<1)fail('REMOTE_BRIDGE_GITHUB_ISSUE_INVALID');return String(value);}
function fence(value:unknown){return `\`\`\`json\n${JSON.stringify(value,null,2)}\n\`\`\`\n`;}
function parseFence(value:unknown):Record<string,unknown>|undefined{if(typeof value!=='string'||!value.startsWith('```json\n')||!value.endsWith('\n```\n'))return undefined;try{const parsed=JSON.parse(value.slice(8,-5));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:undefined;}catch{return undefined;}}

export function createGitHubIssueRemoteBridge(options:GitHubIssueRemoteBridgeOptions){
  const runner=options.runner??defaultRunner,repository=options.repository,authorLogin=options.authorLogin;
  if(typeof repository!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))fail('REMOTE_BRIDGE_GITHUB_REPOSITORY_CONFIG_INVALID');
  if(typeof authorLogin!=='string'||!/^[A-Za-z0-9-]{1,39}$/.test(authorLogin))fail('REMOTE_BRIDGE_GITHUB_AUTHOR_CONFIG_INVALID');
  async function run(args:string[],stdin?:string){let out:GhCommandOutput;try{out=await runner({command:COMMAND,args,...(stdin===undefined?{}:{stdin}),timeoutMs:30_000,maxOutputBytes:MAX_OUTPUT});}catch(error){throw new Error(`REMOTE_BRIDGE_GITHUB_COMMAND_FAILED:${error instanceof Error?error.message:'UNKNOWN'}`);}if(typeof out.stdout!=='string'||typeof out.stderr!=='string'||Buffer.byteLength(out.stdout)+Buffer.byteLength(out.stderr)>MAX_OUTPUT)fail('REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE');if(out.exitCode!==0)fail('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED',out.stderr.replace(/\s+/g,' ').trim().slice(0,256)||`rc=${out.exitCode}`);return out.stdout;}
  function parsed(raw:string):Record<string,unknown>{let value:unknown;try{value=JSON.parse(raw);}catch{fail('RBRIDGE_GITHUB_RESPONSE_INVALID');}if(!value||typeof value!=='object'||Array.isArray(value))fail('RBRIDGE_GITHUB_RESPONSE_INVALID');return value as Record<string,unknown>;}
  function parsedComment(value:unknown,number:number):RBridgeGitHubComment{
    if(!value||typeof value!=='object'||Array.isArray(value))fail('RBRIDGE_GITHUB_RESPONSE_INVALID');const row=value as Record<string,unknown>,user=row.user as Record<string,unknown>|undefined;
    if(!Number.isSafeInteger(row.id)||Number(row.id)<1||typeof row.body!=='string'||Buffer.byteLength(row.body)>MAX_OUTPUT||!user||typeof user.login!=='string'||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)||row.html_url!==`https://github.com/${repository}/issues/${number}#issuecomment-${row.id}`)fail('RBRIDGE_GITHUB_RESPONSE_INVALID');
    return {id:Number(row.id),body:row.body,authorLogin:user.login,url:String(row.html_url)};
  }
  async function comment(issue:string,body:string){if(Buffer.byteLength(body)>=MAX_COMMENT)fail('REMOTE_BRIDGE_GITHUB_RESULT_TOO_LARGE');await run(['issue','comment',issue,'--repo',repository,'--body-file','-'],body);}
  async function existingPublication(issue:string,transferId:string){
    const raw=await run(['issue','view',issue,'--repo',repository,'--json','comments']);let value:unknown;try{value=JSON.parse(raw);}catch{fail('REMOTE_BRIDGE_GITHUB_COMMENTS_INVALID');}
    if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray((value as Record<string,unknown>).comments))fail('REMOTE_BRIDGE_GITHUB_COMMENTS_INVALID');
    const chunks=new Map<number,Record<string,unknown>>();let manifest:Record<string,unknown>|undefined;
    for(const item of (value as {comments:unknown[]}).comments){if(!item||typeof item!=='object'||Array.isArray(item))continue;const row=parseFence((item as Record<string,unknown>).body);if(!row||row.transferId!==transferId)continue;if(row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1'&&Number.isSafeInteger(row.index)){const index=Number(row.index);const previous=chunks.get(index);if(previous&&JSON.stringify(previous)!==JSON.stringify(row))fail('REMOTE_BRIDGE_GITHUB_RESUME_COLLISION');chunks.set(index,row);}else if(row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1'){if(manifest&&JSON.stringify(manifest)!==JSON.stringify(row))fail('REMOTE_BRIDGE_GITHUB_RESUME_COLLISION');manifest=row;}}
    return {chunks,manifest};
  }
  async function publishLarge(issue:string,result:unknown){
    const data=Buffer.from(JSON.stringify(result),'utf8'),objectSha256=sha(data),transferId=`result-${objectSha256}`,count=Math.ceil(data.length/MAX_RAW_CHUNK);
    if(count<1||count>1024)fail('REMOTE_BRIDGE_GITHUB_RESULT_TOO_LARGE');const existing=await existingPublication(issue,transferId);
    for(let index=0;index<count;index++){const chunk=data.subarray(index*MAX_RAW_CHUNK,Math.min(data.length,(index+1)*MAX_RAW_CHUNK));const envelope={schema:'COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1',transferId,index,count,dataBase64:chunk.toString('base64'),chunkSha256:sha(chunk),objectSha256};const prior=existing.chunks.get(index);if(prior){if(JSON.stringify(prior)!==JSON.stringify(envelope))fail('REMOTE_BRIDGE_GITHUB_RESUME_COLLISION');continue;}await comment(issue,fence(envelope));}
    const manifest={schema:'COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1',transferId,count,totalBytes:data.length,objectSha256};if(existing.manifest){if(JSON.stringify(existing.manifest)!==JSON.stringify(manifest))fail('REMOTE_BRIDGE_GITHUB_RESUME_COLLISION');}else await comment(issue,fence(manifest));
  }
  return {
    async readIssue(number:number):Promise<GitHubBridgeIssue&{state:'open'|'closed'}>{
      const n=issueNumber(number),row=parsed(await run(['api','--hostname','github.com',`repos/${repository}/issues/${n}`])),user=row.user as Record<string,unknown>|undefined;
      if(row.number!==number||Object.hasOwn(row,'pull_request')||typeof row.title!=='string'||typeof row.body!=='string'||!user||typeof user.login!=='string'||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)||row.html_url!==`https://github.com/${repository}/issues/${n}`||!['open','closed'].includes(String(row.state)))fail('RBRIDGE_GITHUB_RESPONSE_INVALID');
      return {number,title:row.title,body:row.body,authorLogin:user.login,url:String(row.html_url),state:row.state as 'open'|'closed'};
    },
    async readCommentPage(number:number,page:number):Promise<readonly RBridgeGitHubComment[]>{
      const n=issueNumber(number);if(!Number.isSafeInteger(page)||page<1||page>52)fail('RBRIDGE_GITHUB_PAGE_INVALID');
      const raw=await run(['api','--hostname','github.com',`repos/${repository}/issues/${n}/comments?per_page=20&page=${page}`]);let rows:unknown;try{rows=JSON.parse(raw);}catch{fail('RBRIDGE_GITHUB_RESPONSE_INVALID');}if(!Array.isArray(rows)||rows.length>20)fail('RBRIDGE_GITHUB_RESPONSE_INVALID');return rows.map(row=>parsedComment(row,number));
    },
    async postComment(number:number,body:string):Promise<RBridgeGitHubComment>{
      const n=issueNumber(number);if(typeof body!=='string'||body.includes('\0')||Buffer.byteLength(body)>=MAX_COMMENT)fail('REMOTE_BRIDGE_GITHUB_RESULT_TOO_LARGE');
      const row=parsedComment(parsed(await run(['api','--hostname','github.com','--method','POST',`repos/${repository}/issues/${n}/comments`,'--input','-'],JSON.stringify({body}))),number);if(row.authorLogin!==authorLogin||row.body!==body)fail('RBRIDGE_GITHUB_RESPONSE_INVALID');return row;
    },
    async closeIssue(number:number):Promise<void>{await run(['issue','close',issueNumber(number),'--repo',repository,'--reason','completed']);},
    async listOpenRequests():Promise<GitHubBridgeIssue[]>{
      const raw=await run(['issue','list','--repo',repository,'--state','open','--limit','1000','--json','number,title,body,author,url']);let value:unknown;try{value=JSON.parse(raw);}catch{fail('REMOTE_BRIDGE_GITHUB_LIST_INVALID');}if(!Array.isArray(value))fail('REMOTE_BRIDGE_GITHUB_LIST_INVALID');const result:GitHubBridgeIssue[]=[];
      for(const item of value){if(!item||typeof item!=='object'||Array.isArray(item))fail('REMOTE_BRIDGE_GITHUB_LIST_INVALID');const row=item as Record<string,unknown>,author=row.author;if(!Number.isSafeInteger(row.number)||typeof row.title!=='string'||typeof row.body!=='string'||typeof row.url!=='string'||!author||typeof author!=='object'||Array.isArray(author)||typeof (author as Record<string,unknown>).login!=='string')fail('REMOTE_BRIDGE_GITHUB_LIST_INVALID');if(!row.title.startsWith(PREFIX)||(author as Record<string,unknown>).login!==authorLogin)continue;result.push({number:Number(row.number),title:row.title,body:row.body,authorLogin,url:row.url});}
      return result.sort((a,b)=>a.number-b.number);
    },
    async publishResult(issue:number,result:unknown):Promise<void>{const body=fence(result),n=issueNumber(issue);if(Buffer.byteLength(body)<MAX_COMMENT)await comment(n,body);else await publishLarge(n,result);await run(['issue','close',n,'--repo',repository,'--reason','completed']);},
  };
}
