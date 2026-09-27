import {URL} from 'node:url';

export type BrowserStep =
  | {id:string;action:'GOTO';url:string;timeoutMs?:number}
  | {id:string;action:'CLICK';locator:string;timeoutMs?:number}
  | {id:string;action:'FILL';locator:string;value:string;timeoutMs?:number}
  | {id:string;action:'PRESS';locator:string;key:string;timeoutMs?:number}
  | {id:string;action:'ASSERT_TEXT';locator:string;expected:string;timeoutMs?:number}
  | {id:string;action:'ASSERT_URL';expected:string;timeoutMs?:number}
  | {id:string;action:'SCREENSHOT';name:string;fullPage?:boolean;timeoutMs?:number};

export interface BrowserScenario {id:string;steps:BrowserStep[];}
export interface BrowserArtifact {name:string;sha256:string;bytes:number;mimeType:'image/png'|'image/jpeg'|'image/webp';}
export interface BrowserLabPort {
  goto(url:string,timeoutMs:number):Promise<void>;
  click(locator:string,timeoutMs:number):Promise<void>;
  fill(locator:string,value:string,timeoutMs:number):Promise<void>;
  press(locator:string,key:string,timeoutMs:number):Promise<void>;
  text(locator:string,timeoutMs:number):Promise<string>;
  url():Promise<string>;
  screenshot(input:{name:string;fullPage:boolean;timeoutMs:number}):Promise<BrowserArtifact>;
  close():Promise<void>;
}
export interface BrowserLabConfig {
  allowedOrigins:readonly string[];
  maxSteps:number;
  maxTotalInputBytes:number;
  defaultStepTimeoutMs:number;
  now?:()=>Date;
}
export interface BrowserStepResult {id:string;action:BrowserStep['action'];status:'PASS'|'FAIL'|'NOT_RUN';reason?:string;artifact?:BrowserArtifact;}
export interface BrowserScenarioResult {
  schema:'RBRIDGE_BROWSER_TEST_LAB_V1';
  scenarioId:string;
  status:'PASS'|'FAIL';
  startedAt:string;
  finishedAt:string;
  steps:BrowserStepResult[];
  cleanup:'PASS'|'FAIL';
  cleanupReason?:string;
  writes:number;
}

const ID=/^[a-z0-9][a-z0-9._:-]{0,95}$/;
const SCREENSHOT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.(?:png|jpeg|webp)$/;
const SHA=/^[0-9a-f]{64}$/;
function fail(code:string):never{throw new Error(code);}
function row(value:unknown,code:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail(code);return value as Record<string,unknown>;}
function exact(value:Record<string,unknown>,allowed:readonly string[],code:string){const set=new Set(allowed);if(Object.keys(value).some(k=>!set.has(k)))fail(code);}
function str(value:unknown,max:number,code:string){if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>max)fail(code);return value;}
function timeout(value:unknown,fallback:number){if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isInteger(value)||value<100||value>30_000)fail('RBRIDGE_BROWSER_STEP_TIMEOUT_INVALID');return value;}
function safeReason(error:unknown){const value=error instanceof Error?error.message:String(error);return value.replace(/\s+/g,' ').trim().slice(0,256)||'RBRIDGE_BROWSER_STEP_FAILED';}
function normalizeOrigin(value:string){let u:URL;try{u=new URL(value);}catch{fail('RBRIDGE_BROWSER_ORIGIN_INVALID');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)fail('RBRIDGE_BROWSER_ORIGIN_INVALID');return u.origin;}
function allowedUrl(value:unknown,origins:Set<string>,code:string){const raw=str(value,2048,code);let u:URL;try{u=new URL(raw);}catch{fail(code);}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!origins.has(u.origin))fail(code);return u.toString();}

export function parseBrowserScenario(input:unknown,config:BrowserLabConfig):BrowserScenario{
  if(!Array.isArray(config.allowedOrigins)||config.allowedOrigins.length<1||config.allowedOrigins.length>32)fail('RBRIDGE_BROWSER_ORIGINS_INVALID');
  if(!Number.isInteger(config.maxSteps)||config.maxSteps<1||config.maxSteps>100)fail('RBRIDGE_BROWSER_MAX_STEPS_INVALID');
  if(!Number.isInteger(config.maxTotalInputBytes)||config.maxTotalInputBytes<1||config.maxTotalInputBytes>1_048_576)fail('RBRIDGE_BROWSER_INPUT_LIMIT_INVALID');
  if(!Number.isInteger(config.defaultStepTimeoutMs)||config.defaultStepTimeoutMs<100||config.defaultStepTimeoutMs>30_000)fail('RBRIDGE_BROWSER_DEFAULT_TIMEOUT_INVALID');
  const origins=new Set(config.allowedOrigins.map(normalizeOrigin));
  const root=row(input,'RBRIDGE_BROWSER_SCENARIO_INVALID');exact(root,['id','steps'],'RBRIDGE_BROWSER_SCENARIO_FIELDS_INVALID');
  if(typeof root.id!=='string'||!ID.test(root.id))fail('RBRIDGE_BROWSER_SCENARIO_ID_INVALID');
  if(!Array.isArray(root.steps)||root.steps.length<1||root.steps.length>config.maxSteps)fail('RBRIDGE_BROWSER_STEPS_INVALID');
  const seen=new Set<string>();let total=0;const steps:BrowserStep[]=[];
  for(const item of root.steps){
    const s=row(item,'RBRIDGE_BROWSER_STEP_INVALID'),action=s.action;
    if(typeof s.id!=='string'||!ID.test(s.id)||seen.has(s.id))fail('RBRIDGE_BROWSER_STEP_ID_INVALID');seen.add(s.id);
    const t=timeout(s.timeoutMs,config.defaultStepTimeoutMs);
    if(action==='GOTO'){exact(s,['id','action','url','timeoutMs'],'RBRIDGE_BROWSER_STEP_FIELDS_INVALID');steps.push({id:s.id,action,url:allowedUrl(s.url,origins,'RBRIDGE_BROWSER_URL_DENIED'),timeoutMs:t});continue;}
    if(action==='CLICK'){exact(s,['id','action','locator','timeoutMs'],'RBRIDGE_BROWSER_STEP_FIELDS_INVALID');steps.push({id:s.id,action,locator:str(s.locator,1024,'RBRIDGE_BROWSER_LOCATOR_INVALID'),timeoutMs:t});continue;}
    if(action==='FILL'){exact(s,['id','action','locator','value','timeoutMs'],'RBRIDGE_BROWSER_STEP_FIELDS_INVALID');const value=str(s.value,16_384,'RBRIDGE_BROWSER_VALUE_INVALID');total+=Buffer.byteLength(value);steps.push({id:s.id,action,locator:str(s.locator,1024,'RBRIDGE_BROWSER_LOCATOR_INVALID'),value,timeoutMs:t});continue;}
    if(action==='PRESS'){exact(s,['id','action','locator','key','timeoutMs'],'RBRIDGE_BROWSER_STEP_FIELDS_INVALID');steps.push({id:s.id,action,locator:str(s.locator,1024,'RBRIDGE_BROWSER_LOCATOR_INVALID'),key:str(s.key,64,'RBRIDGE_BROWSER_KEY_INVALID'),timeoutMs:t});continue;}
    if(action==='ASSERT_TEXT'){exact(s,['id','action','locator','expected','timeoutMs'],'RBRIDGE_BROWSER_STEP_FIELDS_INVALID');const expected=str(s.expected,16_384,'RBRIDGE_BROWSER_EXPECTED_INVALID');total+=Buffer.byteLength(expected);steps.push({id:s.id,action,locator:str(s.locator,1024,'RBRIDGE_BROWSER_LOCATOR_INVALID'),expected,timeoutMs:t});continue;}
    if(action==='ASSERT_URL'){exact(s,['id','action','expected','timeoutMs'],'RBRIDGE_BROWSER_STEP_FIELDS_INVALID');steps.push({id:s.id,action,expected:allowedUrl(s.expected,origins,'RBRIDGE_BROWSER_URL_DENIED'),timeoutMs:t});continue;}
    if(action==='SCREENSHOT'){exact(s,['id','action','name','fullPage','timeoutMs'],'RBRIDGE_BROWSER_STEP_FIELDS_INVALID');if(typeof s.name!=='string'||!SCREENSHOT.test(s.name))fail('RBRIDGE_BROWSER_SCREENSHOT_NAME_INVALID');if(s.fullPage!==undefined&&typeof s.fullPage!=='boolean')fail('RBRIDGE_BROWSER_SCREENSHOT_OPTION_INVALID');steps.push({id:s.id,action,name:s.name,fullPage:s.fullPage??false,timeoutMs:t});continue;}
    fail('RBRIDGE_BROWSER_ACTION_INVALID');
  }
  if(total>config.maxTotalInputBytes)fail('RBRIDGE_BROWSER_INPUT_LIMIT_EXCEEDED');
  return {id:root.id,steps};
}

export async function runBrowserScenario(input:unknown,config:BrowserLabConfig,port:BrowserLabPort):Promise<BrowserScenarioResult>{
  const scenario=parseBrowserScenario(input,config),now=config.now??(()=>new Date()),startedAt=now().toISOString(),results:BrowserStepResult[]=[];
  let failed=false,writes=0;
  for(let i=0;i<scenario.steps.length;i++){
    const step=scenario.steps[i]!;
    if(failed){results.push({id:step.id,action:step.action,status:'NOT_RUN'});continue;}
    try{
      let artifact:BrowserArtifact|undefined;
      if(step.action==='GOTO')await port.goto(step.url,step.timeoutMs!);
      else if(step.action==='CLICK')await port.click(step.locator,step.timeoutMs!);
      else if(step.action==='FILL')await port.fill(step.locator,step.value,step.timeoutMs!);
      else if(step.action==='PRESS')await port.press(step.locator,step.key,step.timeoutMs!);
      else if(step.action==='ASSERT_TEXT'){if(await port.text(step.locator,step.timeoutMs!)!==step.expected)fail('RBRIDGE_BROWSER_ASSERT_TEXT_FAILED');}
      else if(step.action==='ASSERT_URL'){if(await port.url()!==step.expected)fail('RBRIDGE_BROWSER_ASSERT_URL_FAILED');}
      else {artifact=await port.screenshot({name:step.name,fullPage:step.fullPage??false,timeoutMs:step.timeoutMs!});if(!artifact||!SHA.test(artifact.sha256)||!Number.isInteger(artifact.bytes)||artifact.bytes<0||artifact.name!==step.name)fail('RBRIDGE_BROWSER_ARTIFACT_INVALID');writes++;}
      results.push({id:step.id,action:step.action,status:'PASS',...(artifact?{artifact}:{})});
    }catch(error){failed=true;results.push({id:step.id,action:step.action,status:'FAIL',reason:safeReason(error)});}
  }
  let cleanup:'PASS'|'FAIL'='PASS',cleanupReason:string|undefined;
  try{await port.close();}catch(error){cleanup='FAIL';cleanupReason=safeReason(error);failed=true;}
  return {schema:'RBRIDGE_BROWSER_TEST_LAB_V1',scenarioId:scenario.id,status:failed?'FAIL':'PASS',startedAt,finishedAt:now().toISOString(),steps:results,cleanup,...(cleanupReason?{cleanupReason}:{}),writes};
}
