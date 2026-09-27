import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {createPlaywrightBrowserLab,type PlaywrightRuntime} from '../../src/adapters/playwrightBrowserLab.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function root(){const value=await mkdtemp(join(tmpdir(),'rbridge-browser-'));roots.push(value);return value;}

function harness(){
  const calls:string[]=[];let current='http://127.0.0.1:4173/',contextClosed=0,browserClosed=0;
  const locator={
    async click(options:{timeout:number}){calls.push('click:'+options.timeout);},
    async fill(value:string,options:{timeout:number}){calls.push('fill:'+value+':'+options.timeout);},
    async press(key:string,options:{timeout:number}){calls.push('press:'+key+':'+options.timeout);},
    async textContent(options:{timeout:number}){calls.push('text:'+options.timeout);return 'Ready';},
  };
  const page={
    async goto(url:string,options:{timeout:number;waitUntil:'domcontentloaded'}){calls.push('goto:'+url+':'+options.waitUntil+':'+options.timeout);current=url;},
    locator(value:string){calls.push('locator:'+value);return locator;},
    url(){calls.push('url');return current;},
    async screenshot(options:{fullPage:boolean;type:'png'|'jpeg'|'webp';timeout:number;animations:'disabled';caret:'hide';scale:'css'}){calls.push('shot:'+options.type+':'+String(options.fullPage)+':'+options.animations+':'+options.scale);return Buffer.from('image-bytes');},
  };
  const context={async newPage(){calls.push('newPage');return page;},async close(){contextClosed++;calls.push('contextClose');}};
  const browser={async newContext(options:{viewport:{width:number;height:number}}){calls.push('context:'+options.viewport.width+'x'+options.viewport.height);return context;},async close(){browserClosed++;calls.push('browserClose');}};
  const runtime={async launch(name:string,options:{headless:boolean}){calls.push('launch:'+name+':'+String(options.headless));return browser;}} as unknown as PlaywrightRuntime;
  return {runtime,calls,contextClosed:()=>contextClosed,browserClosed:()=>browserClosed};
}

describe('Playwright Browser Lab adapter',()=>{
  it('maps the bounded port to Playwright-style locators and stores immutable screenshot evidence',async()=>{
    const artifactRoot=await root(),h=harness();
    const port=await createPlaywrightBrowserLab({browser:'chromium',artifactRoot,headless:true,viewport:{width:800,height:600},runtime:h.runtime});
    await port.goto('http://127.0.0.1:4173/app',1200);
    await port.click('role=button[name="Open"]',1300);
    await port.fill('role=textbox','alice',1400);
    await port.press('role=textbox','Enter',1500);
    await expect(port.text('role=status',1600)).resolves.toBe('Ready');
    await expect(port.url()).resolves.toBe('http://127.0.0.1:4173/app');
    const artifact=await port.screenshot({name:'home.webp',fullPage:true,timeoutMs:1700});
    expect(artifact).toEqual({name:'home.webp',sha256:createHash('sha256').update('image-bytes').digest('hex'),bytes:11,mimeType:'image/webp'});
    expect(await readFile(join(artifactRoot,'home.webp'),'utf8')).toBe('image-bytes');
    await expect(port.screenshot({name:'home.webp',fullPage:false,timeoutMs:1000})).rejects.toMatchObject({code:'EEXIST'});
    await port.close();await port.close();
    expect(h.contextClosed()).toBe(1);expect(h.browserClosed()).toBe(1);
    expect(h.calls).toContain('launch:chromium:true');expect(h.calls).toContain('context:800x600');expect(h.calls).toContain('shot:webp:true:disabled:css');
  });

  it('rejects invalid browser, viewport and artifact names before unsafe writes',async()=>{
    const artifactRoot=await root(),h=harness();
    await expect(createPlaywrightBrowserLab({browser:'safari' as never,artifactRoot,runtime:h.runtime})).rejects.toThrow(/BROWSER_INVALID/);
    await expect(createPlaywrightBrowserLab({browser:'chromium',artifactRoot,viewport:{width:100,height:600},runtime:h.runtime})).rejects.toThrow(/VIEWPORT_INVALID/);
    const port=await createPlaywrightBrowserLab({browser:'chromium',artifactRoot,runtime:h.runtime});
    await expect(port.screenshot({name:'../escape.png',fullPage:false,timeoutMs:1000})).rejects.toThrow(/SCREENSHOT_NAME_INVALID/);
    await port.close();
  });

  it('rejects symlink artifact roots',async()=>{
    const base=await root(),real=join(base,'real'),linked=join(base,'linked');await mkdir(real);await symlink(real,linked);
    const h=harness();await expect(createPlaywrightBrowserLab({browser:'chromium',artifactRoot:linked,runtime:h.runtime})).rejects.toThrow(/ARTIFACT_ROOT_INVALID/);
    expect(h.calls).toEqual([]);
  });

  it('closes the browser if context or page creation fails',async()=>{
    const artifactRoot=await root();let browserClosed=0;
    const runtime={async launch(){return {async newContext(){return {async newPage(){throw new Error('PAGE_CREATE_FAIL');},async close(){}};},async close(){browserClosed++;}};}} as unknown as PlaywrightRuntime;
    await expect(createPlaywrightBrowserLab({browser:'firefox',artifactRoot,runtime})).rejects.toThrow('PAGE_CREATE_FAIL');
    expect(browserClosed).toBe(1);
  });
});
