import {describe,expect,it} from 'vitest';
import {parseBrowserScenario,runBrowserScenario,type BrowserLabConfig,type BrowserLabPort} from '../../src/domain/browserTestLab.js';

function config(patch:Partial<BrowserLabConfig>={}):BrowserLabConfig{
  let tick=0;
  return {allowedOrigins:['http://127.0.0.1:4173'],maxSteps:12,maxTotalInputBytes:1024,defaultStepTimeoutMs:5000,now:()=>new Date(tick++?'2026-09-27T10:00:01.000Z':'2026-09-27T10:00:00.000Z'),...patch};
}
function fake(options:{text?:string;closeError?:boolean;artifactValid?:boolean}={}){
  const calls:string[]=[];let current='http://127.0.0.1:4173/login',closed=0;
  const port:BrowserLabPort={
    async goto(url){calls.push('goto:'+url);current=url;},
    async click(locator){calls.push('click:'+locator);current='http://127.0.0.1:4173/home';},
    async fill(locator,value){calls.push('fill:'+locator+':'+value);},
    async press(locator,key){calls.push('press:'+locator+':'+key);},
    async text(locator){calls.push('text:'+locator);return options.text??'Ready';},
    async url(){calls.push('url');return current;},
    async screenshot(input){calls.push('shot:'+input.name+':'+String(input.fullPage));return options.artifactValid===false?{name:input.name,sha256:'bad',bytes:12,mimeType:'image/png'}:{name:input.name,sha256:'a'.repeat(64),bytes:12,mimeType:'image/png'};},
    async close(){closed++;calls.push('close');if(options.closeError)throw new Error('BROWSER_CLOSE_FAILED');},
  };
  return {port,calls,closed:()=>closed};
}

describe('RBridge Browser Test Lab core',()=>{
  it('runs a bounded locator-style scenario and emits screenshot evidence',async()=>{
    const h=fake();
    const out=await runBrowserScenario({id:'smoke.1',steps:[
      {id:'goto',action:'GOTO',url:'http://127.0.0.1:4173/login'},
      {id:'fill',action:'FILL',locator:'role=textbox[name="User"]',value:'alice'},
      {id:'press',action:'PRESS',locator:'role=textbox[name="User"]',key:'Enter'},
      {id:'click',action:'CLICK',locator:'role=button[name="Open"]'},
      {id:'text',action:'ASSERT_TEXT',locator:'role=status',expected:'Ready'},
      {id:'url',action:'ASSERT_URL',expected:'http://127.0.0.1:4173/home'},
      {id:'shot',action:'SCREENSHOT',name:'home.png',fullPage:true},
    ]},config(),h.port);
    expect(out).toMatchObject({schema:'RBRIDGE_BROWSER_TEST_LAB_V1',scenarioId:'smoke.1',status:'PASS',cleanup:'PASS',writes:1});
    expect(out.steps).toHaveLength(7);expect(out.steps.every(x=>x.status==='PASS')).toBe(true);
    expect(out.steps.at(-1)?.artifact).toMatchObject({name:'home.png',sha256:'a'.repeat(64),bytes:12,mimeType:'image/png'});
    expect(h.calls).toContain('click:role=button[name="Open"]');expect(h.closed()).toBe(1);
  });

  it('rejects navigation outside the configured origins and URL credentials',()=>{
    expect(()=>parseBrowserScenario({id:'x',steps:[{id:'g',action:'GOTO',url:'https://example.com/'}]},config())).toThrow(/URL_DENIED/);
    expect(()=>parseBrowserScenario({id:'x',steps:[{id:'g',action:'GOTO',url:'http://user:pass@127.0.0.1:4173/'}]},config())).toThrow(/URL_DENIED/);
    expect(()=>parseBrowserScenario({id:'x',steps:[{id:'g',action:'GOTO',url:'file:///tmp/x'}]},config())).toThrow(/URL_DENIED/);
  });

  it('rejects duplicate step IDs, extra fields and unsafe screenshot names',()=>{
    expect(()=>parseBrowserScenario({id:'x',steps:[{id:'a',action:'CLICK',locator:'button'},{id:'a',action:'CLICK',locator:'button'}]},config())).toThrow(/STEP_ID_INVALID/);
    expect(()=>parseBrowserScenario({id:'x',steps:[{id:'a',action:'CLICK',locator:'button',unexpected:true}]},config())).toThrow(/STEP_FIELDS_INVALID/);
    expect(()=>parseBrowserScenario({id:'x',steps:[{id:'a',action:'SCREENSHOT',name:'../x.png'}]},config())).toThrow(/SCREENSHOT_NAME_INVALID/);
  });

  it('enforces the aggregate input byte budget',()=>{
    expect(()=>parseBrowserScenario({id:'x',steps:[{id:'a',action:'FILL',locator:'input',value:'123456789'}]},config({maxTotalInputBytes:8}))).toThrow(/INPUT_LIMIT_EXCEEDED/);
  });

  it('fails fast, marks later steps NOT_RUN and still closes the browser',async()=>{
    const h=fake({text:'Wrong'});
    const out=await runBrowserScenario({id:'fail.1',steps:[
      {id:'g',action:'GOTO',url:'http://127.0.0.1:4173/'},
      {id:'a',action:'ASSERT_TEXT',locator:'role=status',expected:'Ready'},
      {id:'later',action:'CLICK',locator:'button'},
    ]},config(),h.port);
    expect(out.status).toBe('FAIL');expect(out.steps.map(x=>x.status)).toEqual(['PASS','FAIL','NOT_RUN']);
    expect(out.steps[1]?.reason).toMatch(/ASSERT_TEXT_FAILED/);expect(h.closed()).toBe(1);expect(h.calls).not.toContain('click:button');
  });

  it('turns cleanup failure into scenario failure',async()=>{
    const h=fake({closeError:true});
    const out=await runBrowserScenario({id:'cleanup.1',steps:[{id:'g',action:'GOTO',url:'http://127.0.0.1:4173/'}]},config(),h.port);
    expect(out).toMatchObject({status:'FAIL',cleanup:'FAIL',cleanupReason:'BROWSER_CLOSE_FAILED'});
  });

  it('rejects malformed screenshot evidence from an adapter',async()=>{
    const h=fake({artifactValid:false});
    const out=await runBrowserScenario({id:'artifact.1',steps:[{id:'s',action:'SCREENSHOT',name:'x.png'}]},config(),h.port);
    expect(out.status).toBe('FAIL');expect(out.steps[0]).toMatchObject({status:'FAIL',reason:'RBRIDGE_BROWSER_ARTIFACT_INVALID'});expect(h.closed()).toBe(1);
  });
});
