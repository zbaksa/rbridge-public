import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

export interface GhCommandInput {command:string;args:string[];stdin?:string;timeoutMs:number;maxOutputBytes:number;}
export interface GhCommandOutput {exitCode:number;stdout:string;stderr:string;}
export type GhCommandRunner=(input:GhCommandInput)=>Promise<GhCommandOutput>;
export interface GitHubBridgeIssue {number:number;title:string;body:string;authorLogin:string;url:string;}
export interface GitHubIssueRemoteBridgeOptions {runner?:GhCommandRunner;repository:string;authorLogin:string;}
const COMMAND='/usr/bin/gh',PREFIX='[COCWIN BRIDGE REQUEST] ',MAX_OUTPUT=2_000_000,MAX_COMMENT=60_000,MAX_RAW_CHUNK=40_000;
function fail(code:string,detail?:string):never{throw new Error(detail?`${code}:${detail}`:code);}
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const defaultRunner:GhCommandRunner=async input=>await new Promise((resolve,reject)=>{
  const child=spawn(input.command,input.args,{shell:false,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',settled=false;
  const done=(error?:Error,exitCode?:number)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(error);}else resolve({exitCode:exitCode??-1,stdout,stderr});};
  const add=(current:string,chunk:Buffer)=>{const next=current+chunk.toString('utf8');if(Buffer.byteLength(next)>input.maxOutputBytes)done(new Error('REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE'));return next;};
  child.stdout.on('data',(c:Buffer)=>{stdout=add(stdout,c);});child.stderr.on('data',(c:Buffer)=>{stderr=add(stderr,c);});child.on('error',e=>done(e));child.on('close',code=>done(undefined,code??-1));
  const timer=setTimeout(()=>done(new Error('REMOTE_BRIDGE_GITHUB_TIMEOUT')),input.timeoutMs);child.stdin.end(input.stdin??'');
});
function issueNumber(value:number){if(!Number.isSafeInteger(value)||value<1)fail('REMOTE_BRIDGE_GITHUB_ISSUE_INVALID');return String(value);}
function fence(value:unknown){return `\`\`\`json\n${JSON.stringify(value,null,2)}\n\`\`\`\n`;}
function parseFence(value:unknown):Record<string,unknown>|undefined{if(typeof value!=='string'||!value.startsWith('```json\n')||!value.endsWith('\n```\n'))return undefined;try{const parsed=JSON.parse(value.slice(8,-5));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:undefined;}catch{return undefined;}}

export function createGitHubIssueRemoteBridge(options:GitHubIssueRemoteBridgeOptions){
  const runner=options.runner??defaultRunner,repository=options.repository,authorLogin=options.authorLogin;
  if(typeof repository!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))fail('REMOTE_BRIDGE_GITHUB_REPOSITORY_CONFIG_INVALID');
  if(typeof authorLogin!=='string'||!/^[A-Za-z0-9-]{1,39}$/.test(authorLogin))fail('REMOTE_BRIDGE_GITHUB_AUTHOR_CONFIG_INVALID');
  async function run(args:string[],stdin?:string){let out:GhCommandOutput;try{out=await runner({command:COMMAND,args,...(stdin===undefined?{}:{stdin}),timeoutMs:30_000,maxOutputBytes:MAX_OUTPUT});}catch(error){throw new Error(`REMOTE_BRIDGE_GITHUB_COMMAND_FAILED:${error instanceof Error?error.message:'UNKNOWN'}`);}if(out.exitCode!==0)fail('REMOTE_BRIDGE_GITHUB_COMMAND_FAILED',out.stderr.replace(/\s+/g,' ').trim().slice(0,256)||`rc=${out.exitCode}`);return out.stdout;}
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
    async listOpenRequests():Promise<GitHubBridgeIssue[]>{
      const raw=await run(['issue','list','--repo',repository,'--state','open','--limit','1000','--json','number,title,body,author,url']);let value:unknown;try{value=JSON.parse(raw);}catch{fail('REMOTE_BRIDGE_GITHUB_LIST_INVALID');}if(!Array.isArray(value))fail('REMOTE_BRIDGE_GITHUB_LIST_INVALID');const result:GitHubBridgeIssue[]=[];
      for(const item of value){if(!item||typeof item!=='object'||Array.isArray(item))fail('REMOTE_BRIDGE_GITHUB_LIST_INVALID');const row=item as Record<string,unknown>,author=row.author;if(!Number.isSafeInteger(row.number)||typeof row.title!=='string'||typeof row.body!=='string'||typeof row.url!=='string'||!author||typeof author!=='object'||Array.isArray(author)||typeof (author as Record<string,unknown>).login!=='string')fail('REMOTE_BRIDGE_GITHUB_LIST_INVALID');if(!row.title.startsWith(PREFIX)||(author as Record<string,unknown>).login!==authorLogin)continue;result.push({number:Number(row.number),title:row.title,body:row.body,authorLogin,url:row.url});}
      return result.sort((a,b)=>a.number-b.number);
    },
    async publishResult(issue:number,result:unknown):Promise<void>{const body=fence(result),n=issueNumber(issue);if(Buffer.byteLength(body)<MAX_COMMENT)await comment(n,body);else await publishLarge(n,result);await run(['issue','close',n,'--repo',repository,'--reason','completed']);},
  };
}