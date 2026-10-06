import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {gateReport,installHash,type GateContext} from './gateContext.js';
import {parseStrictJson} from './strictJson.js';
import type {SnapshotEntry} from './readonlySnapshot.js';
import type {GateReport} from './types.js';

const HASH=/^[0-9a-f]{64}$/,ID=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const PINNED={chunk:40000,total:8000000,count:256};
// Legal configured-store ceilings identify other history; they never grant PASS.
const LEGAL={chunk:1000000,total:64000000,count:4096};
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
function fail(reason:string):never{throw new Error(reason);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('TRANSFERS_MANIFEST_INVALID');return value as Record<string,unknown>;}
function fields(row:Record<string,unknown>,keys:readonly string[]){if(Object.keys(row).length!==keys.length||keys.some(k=>!Object.hasOwn(row,k)))fail('TRANSFERS_FIELDS_INVALID');}
function integer(value:unknown,min:number,max:number):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;}
function timestamp(value:unknown){if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('TRANSFERS_TIMESTAMP_INVALID');return Date.parse(value);}
interface Chunk{index:number;sha256:string;size:number;}
interface Manifest{transferId:string;count:number;objectSha256:string;phase:'OPEN'|'COMPLETE';chunks:Chunk[];total:number;configured:boolean;}
function manifest(value:unknown):Manifest{
  const row=object(value);fields(row,['schema','transferId','count','objectSha256','expiresAt','createdAt','updatedAt','phase','chunks',...(row.phase==='COMPLETE'?['totalBytes']:[])]);
  if(row.schema!=='COCWIN_REMOTE_BRIDGE_TRANSFER_V1'||typeof row.transferId!=='string'||!ID.test(row.transferId)||!integer(row.count,1,LEGAL.count)||typeof row.objectSha256!=='string'||!HASH.test(row.objectSha256)||!['OPEN','COMPLETE'].includes(String(row.phase))||!Array.isArray(row.chunks)||row.chunks.length>row.count)fail('TRANSFERS_MANIFEST_INVALID');
  const created=timestamp(row.createdAt),updated=timestamp(row.updatedAt),expires=timestamp(row.expiresAt);
  if(updated<created||expires<=created)fail('TRANSFERS_TIMESTAMP_ORDER');
  const chunks:Chunk[]=[];let total=0,previous=-1,configured=row.count>PINNED.count;
  for(const value of row.chunks){
    const chunk=object(value);fields(chunk,['index','sha256','size']);
    if(!integer(chunk.index,0,row.count-1)||chunk.index<=previous||typeof chunk.sha256!=='string'||!HASH.test(chunk.sha256)||!integer(chunk.size,0,LEGAL.chunk))fail('TRANSFERS_CHUNK_METADATA_INVALID');
    previous=chunk.index;total+=chunk.size;if(total>LEGAL.total)fail('TRANSFERS_TOTAL_INVALID');configured ||= chunk.size>PINNED.chunk;
    chunks.push({index:chunk.index,sha256:chunk.sha256,size:chunk.size});
  }
  configured ||= total>PINNED.total;
  if(row.phase==='COMPLETE'&&(!integer(row.totalBytes,0,LEGAL.total)||row.totalBytes!==total||chunks.length!==row.count||chunks.some((chunk,index)=>chunk.index!==index)))fail('TRANSFERS_COMPLETE_METADATA_INVALID');
  return {transferId:row.transferId,count:row.count,objectSha256:row.objectSha256,phase:row.phase as 'OPEN'|'COMPLETE',chunks,total,configured};
}
function file(entry:Readonly<SnapshotEntry>|undefined,maxBytes:number){if(!entry||entry.kind!=='FILE'||entry.mode!==0o600||entry.nlink!==1||entry.size>maxBytes)fail('TRANSFERS_FILE_INVALID');return entry;}

export async function auditTransferGate(context:GateContext):Promise<GateReport>{
  const evidence:Array<{path:string;manifest_sha256:string;object_sha256:string;chunks:number;bytes:number;configured:boolean}>=[],started=performance.now();
  const timely=()=>{if(performance.now()-started>=context.profile.budget.scan_ms)fail('TRANSFERS_SCAN_DEADLINE');};
  try{
    await context.snapshot.verify();timely();
    if(context.snapshot.treeSHA256!==context.token.tree_sha256||context.snapshot.entries.length!==context.token.entries||context.snapshot.bytes!==context.token.bytes)fail('TRANSFERS_SNAPSHOT_MISMATCH');
    if(context.snapshot.reasonCodes.length)return gateReport(context,'TRANSFERS','BLOCKED',context.snapshot.reasonCodes);
    const root=context.snapshot.entries.find(e=>e.path==='transfers');
    if(root&&(root.kind!=='DIRECTORY'||root.mode!==0o700))fail('TRANSFERS_DIRECTORY_INVALID');
    const groups=new Map<string,Readonly<SnapshotEntry>[]>();
    for(const entry of context.snapshot.entries){
      if(!entry.path.startsWith('transfers/'))continue;timely();const id=entry.path.slice('transfers/'.length).split('/')[0]!;
      if(!HASH.test(id))fail('TRANSFERS_UNKNOWN_OR_INTERRUPTED_ENTRY');const group=groups.get(id)??[];group.push(entry);groups.set(id,group);
    }
    let configured=false;
    for(const [id,entries] of groups){
      timely();const prefix='transfers/'+id,dir=entries.find(e=>e.path===prefix);
      if(!dir||dir.kind!=='DIRECTORY'||dir.mode!==0o700)fail('TRANSFERS_DIRECTORY_INVALID');
      const manifestEntry=file(entries.find(e=>e.path===prefix+'/manifest.json'),context.profile.budget.record_bytes);
      const row=manifest(parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(await context.snapshot.read(manifestEntry.path))));
      if(sha(row.transferId)!==id)fail('TRANSFERS_DIRECTORY_IDENTITY_MISMATCH');
      const expected=new Set([prefix,prefix+'/manifest.json',...row.chunks.map(chunk=>prefix+'/'+chunk.index+'.chunk')]);
      if(entries.length!==expected.size||entries.some(e=>!expected.has(e.path)))fail('TRANSFERS_FILE_SET_MISMATCH');
      // OPEN remains blocking after expiry; no runtime factory or cleanup is called.
      if(row.phase==='OPEN')fail('TRANSFERS_OPEN_WORK');
      const whole=createHash('sha256');
      for(const chunk of row.chunks){
        timely();const entry=file(entries.find(e=>e.path===prefix+'/'+chunk.index+'.chunk'),LEGAL.chunk);
        if(entry.size!==chunk.size||entry.sha256!==chunk.sha256)fail('TRANSFERS_CHUNK_BYTES_MISMATCH');
        const bytes=await context.snapshot.read(entry.path,LEGAL.chunk);if(bytes.length!==chunk.size||sha(bytes)!==chunk.sha256)fail('TRANSFERS_CHUNK_BYTES_MISMATCH');whole.update(bytes);
      }
      if(whole.digest('hex')!==row.objectSha256)fail('TRANSFERS_OBJECT_DIGEST_MISMATCH');
      configured ||= row.configured;evidence.push({path:prefix,manifest_sha256:manifestEntry.sha256,object_sha256:row.objectSha256,chunks:row.count,bytes:row.total,configured:row.configured});
    }
    await context.snapshot.verify();timely();
    const reasons=configured?['TRANSFERS_CONFIGURED_HISTORY_UNQUALIFIED']:[];
    return gateReport(context,'TRANSFERS',configured?'UNKNOWN':'PASS',reasons,[{name:'complete-file-set-and-all-chunk-bytes',status:'PASS',evidence_sha256:installHash(evidence)}],evidence);
  }catch(error){
    const reason=error instanceof Error&&/^(?:TRANSFERS|STATE|INSTALL_JSON)_[A-Z_]+$/.test(error.message)?error.message:'TRANSFERS_PARSE_OR_SNAPSHOT_UNAVAILABLE';
    return gateReport(context,'TRANSFERS',reason.startsWith('STATE_')||reason==='TRANSFERS_SCAN_DEADLINE'?'UNKNOWN':'BLOCKED',[reason],[],evidence);
  }
}
