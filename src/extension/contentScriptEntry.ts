import {ChatgptContentRuntimeV1} from './contentRuntime.js';
import {installContentMessageBridgeV1,type ContentMessageRuntimeApiV1} from './contentMessageBridge.js';

declare const chrome:{
  runtime:ContentMessageRuntimeApiV1['onMessage'] extends never?never:{
    onMessage:ContentMessageRuntimeApiV1['onMessage'];
    sendMessage(message:unknown):Promise<unknown>;
  };
};

type ContentGlobal=typeof globalThis & {__COCWIN_RBRIDGE_CONTENT_V1__?:ChatgptContentRuntimeV1};
const root=globalThis as ContentGlobal;
if(!root.__COCWIN_RBRIDGE_CONTENT_V1__){
  const runtime=new ChatgptContentRuntimeV1(document,{emit:async frame=>{try{await chrome.runtime.sendMessage(frame);}catch{}}});
  installContentMessageBridgeV1({onMessage:chrome.runtime.onMessage},runtime);
  root.__COCWIN_RBRIDGE_CONTENT_V1__=runtime;
}
