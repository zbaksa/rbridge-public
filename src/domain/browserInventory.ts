export interface BrowserSurfaceObservationV1{
  browserInstanceId:string;
  browserProfileId:string;
  windowId:number;
  tabId:number;
  origin:string;
  projectId:string;
  conversationId:string;
  conversationGeneration:number;
  active:boolean;
}
export interface BrowserTargetQueryV1{
  browserInstanceId:string;
  browserProfileId:string;
  origin:string;
  projectId:string;
  conversationId:string;
}
const enc=new TextEncoder();
function fail(code:string):never{throw new Error(code);}
function id(value:unknown,max:number,code:string):string{
  if(typeof value!=='string'||value.length===0||value.includes('\0')||enc.encode(value).byteLength>max||/[\u0000-\u001f\u007f]/u.test(value))fail(code);return value;
}
function integer(value:unknown,code:string):number{if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>2_147_483_647)fail(code);return value;}
function origin(value:unknown):string{
  const raw=id(value,512,'RBRIDGE_INVENTORY_ORIGIN_INVALID');let u:URL;try{u=new URL(raw);}catch{fail('RBRIDGE_INVENTORY_ORIGIN_INVALID');}
  if((u.protocol!=='http:'&&u.protocol!=='https:')||u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.origin!==raw)fail('RBRIDGE_INVENTORY_ORIGIN_INVALID');return raw;
}
export function validateSurface(input:BrowserSurfaceObservationV1):BrowserSurfaceObservationV1{
  if(typeof input.active!=='boolean')fail('RBRIDGE_INVENTORY_ACTIVE_INVALID');
  if(!Number.isInteger(input.conversationGeneration)||input.conversationGeneration<1)fail('RBRIDGE_INVENTORY_GENERATION_INVALID');
  return {browserInstanceId:id(input.browserInstanceId,128,'RBRIDGE_BROWSER_INSTANCE_INVALID'),browserProfileId:id(input.browserProfileId,128,'RBRIDGE_BROWSER_PROFILE_INVALID'),
    windowId:integer(input.windowId,'RBRIDGE_WINDOW_ID_INVALID'),tabId:integer(input.tabId,'RBRIDGE_TAB_ID_INVALID'),origin:origin(input.origin),
    projectId:id(input.projectId,256,'RBRIDGE_PROJECT_ID_INVALID'),conversationId:id(input.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID'),
    conversationGeneration:input.conversationGeneration,active:input.active};
}
export function normalizeInventory(inputs:readonly BrowserSurfaceObservationV1[]):BrowserSurfaceObservationV1[]{
  if(!Array.isArray(inputs)||inputs.length>512)fail('RBRIDGE_INVENTORY_INVALID');
  const seen=new Set<string>();return inputs.map(raw=>{const s=validateSurface(raw),key=s.browserInstanceId+'\0'+String(s.tabId);if(seen.has(key))fail('RBRIDGE_INVENTORY_DUPLICATE_TAB');seen.add(key);return s;});
}
export function selectExactBrowserTarget(inputs:readonly BrowserSurfaceObservationV1[],query:BrowserTargetQueryV1):BrowserSurfaceObservationV1{
  const inventory=normalizeInventory(inputs),q={browserInstanceId:id(query.browserInstanceId,128,'RBRIDGE_BROWSER_INSTANCE_INVALID'),browserProfileId:id(query.browserProfileId,128,'RBRIDGE_BROWSER_PROFILE_INVALID'),
    origin:origin(query.origin),projectId:id(query.projectId,256,'RBRIDGE_PROJECT_ID_INVALID'),conversationId:id(query.conversationId,256,'RBRIDGE_CONVERSATION_ID_INVALID')};
  const matches=inventory.filter(s=>s.browserInstanceId===q.browserInstanceId&&s.browserProfileId===q.browserProfileId&&s.origin===q.origin&&s.projectId===q.projectId&&s.conversationId===q.conversationId);
  if(matches.length===0)fail('RBRIDGE_TARGET_NOT_FOUND');if(matches.length!==1)fail('RBRIDGE_TARGET_AMBIGUOUS');return matches[0]!;
}
