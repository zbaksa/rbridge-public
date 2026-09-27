import {createHash,randomUUID} from 'node:crypto';
import {link,lstat,open,readFile,realpath,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {chromium,firefox,webkit} from 'playwright';
import type {BrowserArtifact,BrowserLabPort} from '../domain/browserTestLab.js';

export type PlaywrightBrowserName='chromium'|'firefox'|'webkit';
interface LocatorLike {
  click(options:{timeout:number}):Promise<void>;
  fill(value:string,options:{timeout:number}):Promise<void>;
  press(key:string,options:{timeout:number}):Promise<void>;
  textContent(options:{timeout:number}):Promise<string|null>;
}
interface PageLike {
  goto(url:string,options:{timeout:number;waitUntil:'domcontentloaded'}):Promise<unknown>;
  locator(value:string):LocatorLike;
  url():string;
  screenshot(options:{fullPage:boolean;type:'png'|'jpeg'|'webp';timeout:number;animations:'disabled';caret:'hide';scale:'css'}):Promise<Buffer>;
}
interface ContextLike {newPage():Promise<PageLike>;close():Promise<void>;}
interface BrowserLike {newContext(options:{viewport:{width:number;height:number}}):Promise<ContextLike>;close():Promise<void>;}
export interface PlaywrightRuntime {launch(browser:PlaywrightBrowserName,options:{headless:boolean}):Promise<BrowserLike>;}
export interface PlaywrightBrowserLabConfig {
  browser:PlaywrightBrowserName;
  artifactRoot:string;
  headless?:boolean;
  viewport?:{width:number;height:number};
  runtime?:PlaywrightRuntime;
}

const NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.(?:png|jpeg|webp)$/;
function fail(code:string):never{throw new Error(code);}
function integer(value:unknown,min:number,max:number,code:string){if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)fail(code);return value;}
function browserName(value:unknown):PlaywrightBrowserName{if(value!=='chromium'&&value!=='firefox'&&value!=='webkit')fail('RBRIDGE_PLAYWRIGHT_BROWSER_INVALID');return value;}
function screenshotType(name:string):{type:'png'|'jpeg'|'webp';mimeType:BrowserArtifact['mimeType']}{if(name.endsWith('.png'))return {type:'png',mimeType:'image/png'};if(name.endsWith('.jpeg'))return {type:'jpeg',mimeType:'image/jpeg'};if(name.endsWith('.webp'))return {type:'webp',mimeType:'image/webp'};fail('RBRIDGE_PLAYWRIGHT_SCREENSHOT_NAME_INVALID');}
async function verifyRoot(root:string){if(typeof root!=='string'||!isAbsolute(root)||root.startsWith('//')||root.includes('\0')||resolve(root)!==root)fail('RBRIDGE_PLAYWRIGHT_ARTIFACT_ROOT_INVALID');const info=await lstat(root).catch(()=>fail('RBRIDGE_PLAYWRIGHT_ARTIFACT_ROOT_INVALID'));if(info.isSymbolicLink()||!info.isDirectory())fail('RBRIDGE_PLAYWRIGHT_ARTIFACT_ROOT_INVALID');if(await realpath(root)!==root)fail('RBRIDGE_PLAYWRIGHT_ARTIFACT_ROOT_INVALID');return root;}
async function writeArtifact(root:string,name:string,data:Buffer){await verifyRoot(root);if(!NAME.test(name))fail('RBRIDGE_PLAYWRIGHT_SCREENSHOT_NAME_INVALID');const target=join(root,name);if(dirname(target)!==root)fail('RBRIDGE_PLAYWRIGHT_SCREENSHOT_NAME_INVALID');const temp=join(root,'.rbridge-browser-'+randomUUID()+'.tmp');let handle;try{handle=await open(temp,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=undefined;await link(temp,target);}finally{if(handle)await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});}return target;}
const defaultRuntime:PlaywrightRuntime={
  async launch(name,options){
    const engine=name==='chromium'?chromium:name==='firefox'?firefox:webkit;
    return await engine.launch({headless:options.headless}) as unknown as BrowserLike;
  },
};

export async function createPlaywrightBrowserLab(config:PlaywrightBrowserLabConfig):Promise<BrowserLabPort>{
  const name=browserName(config.browser),root=await verifyRoot(config.artifactRoot);
  if(config.headless!==undefined&&typeof config.headless!=='boolean')fail('RBRIDGE_PLAYWRIGHT_HEADLESS_INVALID');
  const viewport=config.viewport??{width:1280,height:720};
  integer(viewport.width,320,3840,'RBRIDGE_PLAYWRIGHT_VIEWPORT_INVALID');
  integer(viewport.height,240,2160,'RBRIDGE_PLAYWRIGHT_VIEWPORT_INVALID');
  const runtime=config.runtime??defaultRuntime,browser=await runtime.launch(name,{headless:config.headless??true});
  let context:ContextLike|undefined,page:PageLike|undefined,closed=false;
  try{context=await browser.newContext({viewport:{...viewport}});page=await context.newPage();}
  catch(error){await browser.close().catch(()=>{});throw error;}
  const requirePage=()=>{if(closed||!page)fail('RBRIDGE_PLAYWRIGHT_CLOSED');return page;};
  return {
    async goto(url,timeoutMs){await requirePage().goto(url,{timeout:timeoutMs,waitUntil:'domcontentloaded'});},
    async click(locator,timeoutMs){await requirePage().locator(locator).click({timeout:timeoutMs});},
    async fill(locator,value,timeoutMs){await requirePage().locator(locator).fill(value,{timeout:timeoutMs});},
    async press(locator,key,timeoutMs){await requirePage().locator(locator).press(key,{timeout:timeoutMs});},
    async text(locator,timeoutMs){return (await requirePage().locator(locator).textContent({timeout:timeoutMs}))??'';},
    async url(){return requirePage().url();},
    async screenshot(input){
      if(!NAME.test(input.name))fail('RBRIDGE_PLAYWRIGHT_SCREENSHOT_NAME_INVALID');
      const format=screenshotType(input.name),data=await requirePage().screenshot({fullPage:input.fullPage,type:format.type,timeout:input.timeoutMs,animations:'disabled',caret:'hide',scale:'css'});
      await writeArtifact(root,input.name,data);
      return {name:input.name,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.byteLength,mimeType:format.mimeType};
    },
    async close(){
      if(closed)return;closed=true;let first:unknown;
      try{await context!.close();}catch(error){first=error;}
      try{await browser.close();}catch(error){if(first===undefined)first=error;}
      if(first!==undefined)throw first;
    },
  };
}

export async function readPlaywrightArtifact(path:string){return await readFile(path);}
