import {createHash} from 'node:crypto';
import type {RBridgeJsonValue, RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeExecutionCore} from '../../src/server/rbridgeExecutionCore.js';
import {createRBridgeExecutionResults} from '../../src/server/rbridgeExecutionResults.js';
import {createRBridgeDeliveryJournal} from '../../src/server/rbridgeDeliveryJournal.js';
import {createRBridgeGitHubCore} from '../../src/adapters/rbridgeGitHubCore.js';
import type {GitHubBridgeIssue,RBridgeGitHubComment,RBridgeGitHubPort} from '../../src/adapters/githubIssueRemoteBridge.js';
import {createRBridgeTestState} from './rbridge-core-state.js';
export const githubRepository='example/rbridge-control',githubAuthor='bridge-owner';
export const githubHash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
export function githubFence(value:unknown){return '```json\n'+JSON.stringify(value,null,2)+'\n```\n';}
export function githubUnfence(value:string):Record<string,unknown>{return JSON.parse(value.slice(8,-5)) as Record<string,unknown>;}
export function githubIssue(number=17,id='shared-read',operation:RBridgeOperationSubmissionV1['operation']={kind:'HEALTH',action:'STATUS'}):GitHubBridgeIssue{
  return {number,title:'[COCWIN BRIDGE REQUEST] '+id,authorLogin:githubAuthor,url:`https://github.com/${githubRepository}/issues/${number}`,body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:id,createdAt:'2026-10-05T10:00:00.000Z',expiresAt:'2026-10-05T10:20:00.000Z',operation})};
}
export async function createRBridgeGitHubFixture(output:RBridgeJsonValue={observed:'read'}){
  const state=await createRBridgeTestState(),results=await createRBridgeExecutionResults(state),deliveries=await createRBridgeDeliveryJournal(state);
  let calls=0,now=new Date('2026-10-05T10:01:00.000Z');
  let releaseHandler!:()=>void;
  const handlerGate=new Promise<void>(resolve=>{releaseHandler=resolve;});
  const core=createRBridgeExecutionCore({...state,results,subjects:{GITHUB:githubRepository+':'+githubAuthor,MCP:`uid:${state.uid}`},legacyReservations:{async isReserved(){return false;}},handler:{async execute(){calls++;await handlerGate;return output;}}});
  const issues=new Map<number,GitHubBridgeIssue&{state:'open'|'closed'}>(),comments=new Map<number,RBridgeGitHubComment[]>(),events:string[]=[],pages:number[]=[];
  let nextId=1,failAt:string|undefined;
  function issue(value=githubIssue()){issues.set(value.number,{...value,state:'open'});comments.set(value.number,[]);return value;}
  function addComment(number:number,body:string,authorLogin=githubAuthor){const comment={id:nextId++,body,authorLogin,url:`https://github.com/${githubRepository}/issues/${number}#issuecomment-${nextId-1}`};comments.get(number)!.push(comment);return comment;}
  function fault(name:string){if(failAt===name){failAt=undefined;throw new Error('REMOTE_ACK_LOST_PRIVATE_TEXT');}}
  const github:RBridgeGitHubPort={
    async readIssue(number){return structuredClone(issues.get(number)!);},
    async readCommentPage(number,page){pages.push(page);return structuredClone(comments.get(number)!.slice((page-1)*20,page*20));},
    async postComment(number,body){const comment=addComment(number,body),row=githubUnfence(body);events.push(String(row.schema));fault(row.schema==='COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1'?'MANIFEST':'COMMENT');return structuredClone(comment);},
    async closeIssue(number){issues.get(number)!.state='closed';events.push('CLOSE');fault('CLOSE');},
  };
  const options={repository:githubRepository,authorLogin:githubAuthor,binding:state.binding,core,deliveries,github,now:()=>now};
  const adapter=createRBridgeGitHubCore(options);
  async function terminal(id='shared-read'){
    releaseHandler();
    const until=Date.now()+5000;while(Date.now()<until){const found=await core.status(id,state.context);if(found.status==='RECEIPT'&&found.receipt.phase==='TERMINAL')return found.receipt;await new Promise<void>(done=>setTimeout(done,5));}throw new Error('TEST_TERMINAL_DEADLINE');
  }
  async function close(){releaseHandler();await core.close();}
  return {...state,results,deliveries,core,github,adapter,options,issues,comments,events,pages,issue,addComment,terminal,close,output,get calls(){return calls;},setNow(value:Date){now=value;},failAfter(name:string){failAt=name;}};
}
