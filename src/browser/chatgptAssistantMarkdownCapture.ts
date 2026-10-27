export type SiteMarkdownObservationV3=
  |{kind:'CAPTURED';assistantTurnId:string;markdown:string}
  |{kind:'UNAVAILABLE';reason:'UI_PROTOCOL_CHANGED'};
export interface SiteMarkdownInputV3{assistantTurnId:string;captureToken:string;conversationId:string;captureEpoch:number}

// No validated site-provided exact-turn copy/export representation is available
// yet. DOM text, code blocks, private application state and a shared clipboard
// cannot establish lossless Markdown or transaction provenance.
export const SITE_ASSISTANT_MARKDOWN_AVAILABLE_V3=false;
export async function acquireSiteAssistantMarkdown(document:Document,input:SiteMarkdownInputV3):Promise<SiteMarkdownObservationV3>{
  void document;void input;
  return {kind:'UNAVAILABLE',reason:'UI_PROTOCOL_CHANGED'};
}

// Serialize this function into the admitted document's MAIN world. Its caller
// must separately fence Chrome frame/document, live capture authority and turn
// completion. This component does not enable the production adapter above.
export async function captureExactSiteCopyInMainWorldV3(input:{assistantTurnId:string;documentUrl:string}):Promise<SiteMarkdownObservationV3>{
  const unavailable=():SiteMarkdownObservationV3=>({kind:'UNAVAILABLE',reason:'UI_PROTOCOL_CHANGED'});
  const limit=4*1024*1024;
  try{
    if(!input||typeof input!=='object'||Object.keys(input).length!==2||typeof document==='undefined')return unavailable();
    const {assistantTurnId,documentUrl}=input;
    if(typeof assistantTurnId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(assistantTurnId)||typeof documentUrl!=='string')return unavailable();
    const win=document.defaultView;if(!win||win.location.href!==documentUrl)return unavailable();
    const url=new URL(documentUrl);if(url.origin!=='https://chatgpt.com'||url.username||url.password||url.search||url.hash)return unavailable();
    const mains=document.querySelectorAll('main');if(mains.length!==1)return unavailable();
    const main=mains[0]!,find=()=>[...main.querySelectorAll('[data-turn="assistant"][data-turn-id]')].filter(node=>node.getAttribute('data-turn-id')===assistantTurnId);
    const matches=find();if(matches.length!==1)return unavailable();
    const section=matches[0]!,bodies=section.querySelectorAll('[data-message-author-role="assistant"]'),buttons=section.querySelectorAll('button[data-testid="copy-turn-action-button"][aria-label="Copy response"]');
    if(bodies.length!==1||buttons.length!==1)return unavailable();
    const body=bodies[0]!,button=buttons[0]!;
    if(!(button instanceof win.HTMLButtonElement)||button.disabled||!button.getClientRects().length)return unavailable();
    const state=section.getAttribute('data-turn-state');if(state!==null&&state!=='complete')return unavailable();
    const html=body.innerHTML;if(html.length>limit)return unavailable();
    const stable=()=>win.location.href===documentUrl&&document.querySelectorAll('main').length===1&&document.querySelector('main')===main&&section.isConnected&&body.isConnected&&button.isConnected&&find().length===1&&find()[0]===section&&section.getAttribute('data-turn-state')===state&&body.innerHTML===html&&section.querySelectorAll('[data-message-author-role="assistant"]').length===1&&section.querySelector('[data-message-author-role="assistant"]')===body&&section.querySelectorAll('button[data-testid="copy-turn-action-button"]').length===1&&section.querySelector('button[data-testid="copy-turn-action-button"]')===button;
    const clipboard=win.navigator.clipboard;if(!clipboard)return unavailable();
    const itemTypes=win.ClipboardItem&&Object.getOwnPropertyDescriptor(win.ClipboardItem.prototype,'types')?.get,itemRead=win.ClipboardItem?.prototype.getType;
    const blobSize=Object.getOwnPropertyDescriptor(win.Blob.prototype,'size')?.get,blobType=Object.getOwnPropertyDescriptor(win.Blob.prototype,'type')?.get,blobRead=win.Blob.prototype.arrayBuffer;
    type Call={kind:'text';text:unknown}|{kind:'item';data:Promise<unknown>}|{kind:'invalid'};
    const calls:Call[]=[],hooks:{key:'write'|'writeText';previous:PropertyDescriptor|undefined;original:unknown;replacement:(value:unknown)=>Promise<void>}[]=[];
    let failed=false,restored=true;
    try{
      for(const key of ['write','writeText'] as const){
        const previous=Object.getOwnPropertyDescriptor(clipboard,key),original=clipboard[key];
        if(typeof original!=='function')continue;
        if(previous&&(!('value' in previous)||previous.configurable!==true))throw Error('COPY_HOOK_UNAVAILABLE');
        const replacement=(value:unknown):Promise<void>=>{
          try{
            if(key==='writeText')calls.push({kind:'text',text:value});
            else{
              if(!Array.isArray(value)||value.length!==1||!value[0]||typeof value[0]!=='object')throw Error('COPY_ITEMS_INVALID');
              if(typeof itemTypes!=='function'||typeof itemRead!=='function')throw Error('COPY_ITEM_UNAVAILABLE');
              // Native accessors reject objects that the actual Clipboard API
              // would not accept. Start its immutable data promise at invocation.
              const item=value[0] as object,types:unknown=Reflect.apply(itemTypes,item,[]);
              if(!Array.isArray(types)||types.filter(type=>type==='text/plain').length!==1||types.some(type=>type!=='text/plain'&&type!=='text/html'))throw Error('COPY_ITEM_INVALID');
              const data:Promise<unknown>=Promise.resolve(Reflect.apply(itemRead,item,['text/plain']));
              void data.catch(()=>{});calls.push({kind:'item',data});
            }
          }catch{calls.push({kind:'invalid'});}
          return Promise.resolve();
        };
        Object.defineProperty(clipboard,key,{value:replacement,configurable:true,writable:true,enumerable:previous?.enumerable??false});
        hooks.push({key,previous,original,replacement});
      }
      if(!hooks.length)throw Error('COPY_HOOK_UNAVAILABLE');
      button.click();
    }catch{failed=true;}
    finally{
      // No await occurs while these methods are intercepted. Another tab's
      // clipboard and deferred page writes cannot supply this transaction.
      for(const hook of hooks.reverse()){
        try{
          if(Object.getOwnPropertyDescriptor(clipboard,hook.key)?.value!==hook.replacement){restored=false;continue;}
          if(hook.previous)Object.defineProperty(clipboard,hook.key,hook.previous);
          else if(!Reflect.deleteProperty(clipboard,hook.key))restored=false;
          if(clipboard[hook.key]!==hook.original)restored=false;
        }catch{restored=false;}
      }
    }
    if(failed||!restored||calls.length!==1||!stable())return unavailable();
    const call=calls[0]!;let markdown:unknown;
    if(call.kind==='text')markdown=call.text;
    else if(call.kind==='item'){
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        markdown=await Promise.race([
          call.data.then(async(value)=>{
            if(typeof blobSize!=='function'||typeof blobType!=='function'||typeof blobRead!=='function')throw Error('COPY_BLOB_UNAVAILABLE');
            const size:unknown=Reflect.apply(blobSize,value,[]),mime:unknown=Reflect.apply(blobType,value,[]);
            if(typeof size!=='number'||!Number.isSafeInteger(size)||size<0||size>limit||typeof mime!=='string'||mime.split(';',1)[0]!=='text/plain')throw Error('COPY_BLOB_INVALID');
            const bytes:ArrayBuffer=await Reflect.apply(blobRead,value,[]);if(bytes.byteLength!==size)throw Error('COPY_BLOB_CHANGED');
            // Fatal decoding rejects malformed UTF-8 even when replacement
            // characters would have the same byte length. Keep a leading BOM.
            return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
          }),
          new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('COPY_READ_TIMEOUT')),2000);}),
        ]);
      }finally{if(timer!==undefined)clearTimeout(timer);}
    }else return unavailable();
    if(typeof markdown!=='string'||new TextEncoder().encode(markdown).byteLength>limit||!stable())return unavailable();
    return {kind:'CAPTURED',assistantTurnId:assistantTurnId,markdown};
  }catch{return unavailable();}
}
