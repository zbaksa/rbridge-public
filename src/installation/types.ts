import {INSTALL_CONTRACT_SCHEMA} from './contractSchema.js';

export type InstallStatus='PASS'|'BLOCKED'|'UNKNOWN'|'FAIL';
export interface Binding{uid:number;gid:number;supplementary_gids:readonly number[];account:string;home:string;principal_id:string;target_instance_id:string;repository:string;author:string;mcp_subject:string;github_subject:string;policy_sha256:string;}
export interface RuntimePins{source_sha:string;tree_sha:string;old_sha:string;node_path:string;node_version:string;node_sha256:string;npm_cli_path:string;npm_sha256:string;lock_sha256:string;manifest_sha256:string;}
export interface ToolkitPins{source_sha:string;manifest_sha256:string;python_path:string;python_version:string;python_sha256:string;}
export interface ToolPin{role:'systemctl'|'gh'|'runuser';path:string;sha256:string;version:string;}
export interface InstallPaths{state_root:string;release_parent:string;current_link:string;ledger_parent:string;lock_path:string;binding_env:string;binding_dropin:string;canary_path:string;}
export interface PathDigest{path:string;sha256:string;}
export interface ServicePin{unit:string;alternate_units:readonly string[];identity_sha256:string;environment_files:readonly PathDigest[];dropins_sha256:string;canary_sha256:string;}
export type Budget=Readonly<Record<keyof typeof INSTALL_CONTRACT_SCHEMA.$defs.Budget.properties,number>>;
export interface ReaderRegistration{reader_id:string;source_sha256:string;entrypoint:string;version:string;transport:'GITHUB'|'MCP';trusted_context_sha256:string;qualification_sha256:string;adoption_sha256:string;}
export interface InstallProfile{schema:'RBRIDGE_P2A_INSTALL_PROFILE_V1';binding:Binding;runtime:RuntimePins;toolkit:ToolkitPins;tools:readonly ToolPin[];paths:InstallPaths;service:ServicePin;budget:Budget;readers:readonly ReaderRegistration[];}
export interface SnapshotToken{transaction_id:string;state_root_identity_sha256:string;tree_sha256:string;entries:number;bytes:number;pause_sha256:string;captured_at:string;}
export interface Check{name:string;status:InstallStatus;evidence_sha256?:string;}
export type Gate='LEGACY'|'FLOWPILOT'|'PROCESS'|'TRANSFERS'|'CORE';
export interface GateReport{gate:Gate;status:InstallStatus;snapshot_sha256:string;evidence_sha256:string;checks:readonly Check[];reason_codes:readonly string[];}
export interface GateBundle{schema:'RBRIDGE_INSTALL_GATE_V1';status:InstallStatus;reason_codes:readonly string[];token:SnapshotToken;reports:readonly GateReport[];}
export interface TransactionResult{status:string;exit_code:number;phase:string;ledger_sha256:string;reason_codes:readonly string[];}
export interface IssueEvidence{number:number;state:'OPEN'|'CLOSED';title:string;body:string;author:string;url:string;isPullRequest:boolean;updatedAt:string;capture_sha256:string;}
export interface ProcessObservation{pid:number;start_ticks:string;cgroup:string;settled:boolean;identity_sha256:string;}

interface Rule{type?:string;$ref?:string;const?:unknown;enum?:readonly unknown[];properties?:Record<string,Rule>;required?:readonly string[];items?:Rule;maxItems?:number;pattern?:string;minLength?:number;maxLength?:number;minimum?:number;maximum?:number;}
const definitions=INSTALL_CONTRACT_SCHEMA.$defs as unknown as Record<string,Rule>;
function invalid():never{throw new Error('INSTALL_CONTRACT_INVALID');}
function unicode(value:string):string{
  if(/[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g,'')))invalid();
  return value;
}
export function validateInstallContract(value:unknown,name:string):void{
  function check(v:unknown,rule:Rule|undefined,depth=0):void{
    if(!rule||depth>64)invalid();
    if(rule.$ref){check(v,definitions[rule.$ref.split('/').at(-1)??''],depth+1);return;}
    if('const'in rule&&v!==rule.const)invalid();
    if(rule.enum&&!rule.enum.includes(v))invalid();
    if(rule.type==='object'){
      if(!v||typeof v!=='object'||Array.isArray(v))invalid();
      const o=v as Record<string,unknown>,props=rule.properties??{};
      if(Object.keys(o).some(k=>!Object.hasOwn(props,k))||rule.required?.some(k=>!Object.hasOwn(o,k)))invalid();
      for(const [k,x]of Object.entries(o))check(x,props[k],depth+1);
    }else if(rule.type==='array'){
      if(!Array.isArray(v)||v.length>(rule.maxItems??0))invalid();
      for(const x of v)check(x,rule.items,depth+1);
    }else if(rule.type==='string'){
      if(typeof v!=='string'||v.length<(rule.minLength??0)||v.length>(rule.maxLength??4096)||(rule.pattern&&!new RegExp(rule.pattern).test(v)))invalid();
      if(/[\uD800-\uDFFF]/u.test(v.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g,'')))invalid();
    }else if(rule.type==='integer'){
      if(typeof v!=='number'||!Number.isSafeInteger(v)||v<(rule.minimum??0)||v>(rule.maximum??Number.MAX_SAFE_INTEGER))invalid();
    }
  }
  check(value,definitions[name]);
}
export function encodeInstallReport(value:unknown):Uint8Array{
  function normalize(v:unknown,depth=0):unknown{
    if(depth>64)invalid();
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='string')return unicode(v);
    if(typeof v==='number'){if(!Number.isSafeInteger(v))invalid();return v;}
    if(Array.isArray(v))return v.map(x=>normalize(x,depth+1));
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>Buffer.compare(Buffer.from(unicode(a)),Buffer.from(unicode(b)))).map(([k,x])=>[unicode(k),normalize(x,depth+1)]));
    invalid();
  }
  return Buffer.from(JSON.stringify(normalize(value)),'utf8');
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
export function parseRBridgeInstallProfile(value:unknown):InstallProfile{
  validateInstallContract(value,'Profile');
  const p=structuredClone(value) as InstallProfile,b=p.binding;
  if(b.mcp_subject!==`uid:${b.uid}`||b.github_subject!==`${b.repository}:${b.author}`||b.account!=='rbridge'||b.home!=='/home/rbridge'||b.supplementary_gids.includes(0)||b.supplementary_gids.some((n,i)=>i>0&&n<=(b.supplementary_gids[i-1]??-1)))invalid();
  if(!/^3\.(1[1-9]|[2-9][0-9])\.[0-9]+$/.test(p.toolkit.python_version)||p.toolkit.source_sha===p.runtime.source_sha)invalid();
  const paths:readonly string[]=[b.home,p.runtime.node_path,p.runtime.npm_cli_path,p.toolkit.python_path,...Object.values(p.paths),...p.tools.map(t=>t.path),...p.service.environment_files.map(e=>e.path),...p.readers.map(r=>r.entrypoint)];
  if(paths.some(path=>!path.startsWith('/')||path==='/'||/[\x00\r\n]/.test(path)||path.split('/').slice(1).some(part=>part===''||part==='.'||part==='..')))invalid();
  if(p.tools.length!==3||new Set(p.tools.map(t=>t.role)).size!==3)invalid();
  const env=p.service.environment_files.map(e=>e.path);
  if(new Set(env).size!==env.length||env.includes(p.paths.binding_env)||p.paths.state_root!==b.home+'/.local/state/rbridge'||!p.paths.canary_path.startsWith(b.home+'/')||new Set(p.readers.map(r=>r.reader_id)).size!==p.readers.length)invalid();
  return freeze(p);
}
