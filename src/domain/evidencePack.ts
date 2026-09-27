import {createHash,timingSafeEqual} from 'node:crypto';

export type EvidenceState='PASS'|'FAIL'|'BLOCKED'|'UNKNOWN'|'STALE'|'UNCERTAIN';
export interface EvidenceInput {id:string;state:EvidenceState;detail?:string;sha256?:string;}
export interface EvidencePackInput {requestId:string;appId:string;subject:string;startedAt:string;completedAt:string;appSourceSha:string;evidence:EvidenceInput[];}
export interface EvidenceEntry {id:string;state:EvidenceState;detail?:string;sha256?:string;}
export interface EvidencePackV1 {
  schema:'RBRIDGE_EVIDENCE_PACK_V1';requestId:string;appId:string;subject:string;startedAt:string;completedAt:string;
  appSourceSha:string;outcome:EvidenceState;evidence:EvidenceEntry[];receiptSha256:string;
}

const REQUEST=/^[A-Za-z0-9_.:-]{8,128}$/,APP=/^[a-z][a-z0-9_-]{0,31}$/,ID=/^[A-Za-z0-9_.:-]{1,64}$/,SHA=/^[0-9a-f]{40}$/,SHA256=/^[0-9a-f]{64}$/;
const STATES=new Set<EvidenceState>(['PASS','FAIL','BLOCKED','UNKNOWN','STALE','UNCERTAIN']);
const RANK:Record<EvidenceState,number>={PASS:0,STALE:1,UNKNOWN:2,UNCERTAIN:3,BLOCKED:4,FAIL:5};

function bad(code:string):never{throw new Error(code);}
function iso(value:string,code:string){const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)bad(code);return ms;}
function cleanText(value:string,max:number,code:string){if(typeof value!=='string'||value.includes('\0')||Buffer.byteLength(value)>max)bad(code);return value;}
function normalize(entry:EvidenceInput):EvidenceEntry{
  if(!entry||typeof entry!=='object'||Array.isArray(entry))bad('EVIDENCE_ENTRY_INVALID');
  if(typeof entry.id!=='string'||!ID.test(entry.id))bad('EVIDENCE_ID_INVALID');
  if(typeof entry.state!=='string'||!STATES.has(entry.state))bad('EVIDENCE_STATE_INVALID');
  const out:EvidenceEntry={id:entry.id,state:entry.state};
  if(entry.detail!==undefined)out.detail=cleanText(entry.detail,1024,'EVIDENCE_DETAIL_INVALID');
  if(entry.sha256!==undefined){if(typeof entry.sha256!=='string'||!SHA256.test(entry.sha256))bad('EVIDENCE_SHA256_INVALID');out.sha256=entry.sha256;}
  return out;
}
function canonical(pack:Omit<EvidencePackV1,'receiptSha256'>):string{return JSON.stringify(pack);}
function digest(value:string){return createHash('sha256').update(value).digest('hex');}
function outcome(rows:EvidenceEntry[]):EvidenceState{
  let state:EvidenceState='PASS';for(const row of rows)if(RANK[row.state]>RANK[state])state=row.state;return state;
}

export function createEvidencePack(input:EvidencePackInput):EvidencePackV1{
  if(!input||typeof input!=='object'||Array.isArray(input))bad('EVIDENCE_PACK_INPUT_INVALID');
  if(typeof input.requestId!=='string'||!REQUEST.test(input.requestId))bad('EVIDENCE_REQUEST_ID_INVALID');
  if(typeof input.appId!=='string'||!APP.test(input.appId))bad('EVIDENCE_APP_ID_INVALID');
  const subject=cleanText(input.subject,256,'EVIDENCE_SUBJECT_INVALID');
  const started=iso(input.startedAt,'EVIDENCE_STARTED_AT_INVALID'),completed=iso(input.completedAt,'EVIDENCE_COMPLETED_AT_INVALID');
  if(completed<started)bad('EVIDENCE_TIME_ORDER_INVALID');
  if(typeof input.appSourceSha!=='string'||!SHA.test(input.appSourceSha))bad('EVIDENCE_APP_SOURCE_SHA_INVALID');
  if(!Array.isArray(input.evidence)||input.evidence.length<1||input.evidence.length>64)bad('EVIDENCE_COUNT_INVALID');
  const evidence=input.evidence.map(normalize);if(new Set(evidence.map(row=>row.id)).size!==evidence.length)bad('EVIDENCE_ID_DUPLICATE');
  const core:Omit<EvidencePackV1,'receiptSha256'>={schema:'RBRIDGE_EVIDENCE_PACK_V1',requestId:input.requestId,appId:input.appId,subject,startedAt:input.startedAt,completedAt:input.completedAt,appSourceSha:input.appSourceSha,outcome:outcome(evidence),evidence};
  return {...core,receiptSha256:digest(canonical(core))};
}

export function verifyEvidencePack(value:unknown):value is EvidencePackV1{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const row=value as Record<string,unknown>;if(row.schema!=='RBRIDGE_EVIDENCE_PACK_V1'||typeof row.receiptSha256!=='string'||!SHA256.test(row.receiptSha256))return false;
  try{
    const recreated=createEvidencePack({requestId:String(row.requestId??''),appId:String(row.appId??''),subject:String(row.subject??''),startedAt:String(row.startedAt??''),completedAt:String(row.completedAt??''),appSourceSha:String(row.appSourceSha??''),evidence:row.evidence as EvidenceInput[]});
    if(recreated.outcome!==row.outcome)return false;
    const a=Buffer.from(recreated.receiptSha256),b=Buffer.from(row.receiptSha256);return a.length===b.length&&timingSafeEqual(a,b);
  }catch{return false;}
}
