export type ChatgptRouteKind='ROOT'|'PROJECT_ROUTE'|'CONVERSATION'|'ROUTE';
export interface ChatgptConversationIdentityV1{
  ok:true;
  origin:string;
  path:string;
  key:string;
  kind:ChatgptRouteKind;
  conversationId:string;
  projectId:string;
  canonicalProjectId:string;
  projectPath:string;
  projectUrl:string;
}
const CHAT_HOSTS=new Set(['chatgpt.com','www.chatgpt.com','chat.openai.com','www.chat.openai.com']);
function fail(code:string):never{throw new Error(code);}
function normalizePath(pathname:string):string{
  let path=String(pathname||'/').replace(/\\+/g,'/').replace(/\/{2,}/g,'/');
  if(!path.startsWith('/'))path='/'+path;
  if(path.length>1)path=path.replace(/\/+$/,'');
  try{path=decodeURI(path);}catch{}
  return path||'/';
}
export function canonicalChatgptProjectId(projectId:string):string{
  const raw=String(projectId||'').trim();
  if(!raw.startsWith('g-p-'))return '';
  const match=raw.match(/^(g-p-[A-Za-z0-9]{32})(?:-[A-Za-z0-9][A-Za-z0-9-]*)?$/);
  return match?.[1]??raw;
}
export function sameCanonicalChatgptProject(a:string,b:string):boolean{
  const aa=canonicalChatgptProjectId(a),bb=canonicalChatgptProjectId(b);return aa.length>0&&bb.length>0&&aa===bb;
}
export function describeChatgptUrl(input:string):ChatgptConversationIdentityV1{
  let url:URL;try{url=new URL(String(input||''));}catch{fail('RBRIDGE_CHATGPT_URL_INVALID');}
  const host=url.hostname.toLowerCase();if(!CHAT_HOSTS.has(host)||url.protocol!=='https:')fail('RBRIDGE_CHATGPT_URL_DENIED');
  const path=normalizePath(url.pathname),segments=path.split('/').filter(Boolean);
  let kind:ChatgptRouteKind='ROUTE',conversationId='';
  const ci=segments.findIndex(x=>x.toLowerCase()==='c');
  if(ci>=0&&segments[ci+1]){kind='CONVERSATION';conversationId=segments[ci+1]!;}
  else if(path==='/')kind='ROOT';
  else if(segments.includes('project'))kind='PROJECT_ROUTE';
  const gi=segments.findIndex(x=>x.toLowerCase()==='g');
  const projectId=gi>=0&&segments[gi+1]?.startsWith('g-p-')?segments[gi+1]!:'';
  const canonicalProjectId=canonicalChatgptProjectId(projectId);
  const projectPath=projectId?'/g/'+projectId:'',projectUrl=projectId?url.origin+projectPath:'';
  return {ok:true,origin:url.origin,path,key:'CHATGPT:'+path,kind,conversationId,projectId,canonicalProjectId,projectPath,projectUrl};
}
export function requireExactProjectConversationUrl(input:string):ChatgptConversationIdentityV1{
  const identity=describeChatgptUrl(input);
  if(identity.kind!=='CONVERSATION'||!identity.conversationId||!identity.projectId||!identity.canonicalProjectId)fail('RBRIDGE_CHATGPT_PROJECT_CONVERSATION_REQUIRED');
  return identity;
}
