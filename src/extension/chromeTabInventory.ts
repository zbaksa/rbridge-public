import {describeChatgptUrl} from '../browser/chatgptConversationIdentity.js';

export interface ChromeTabObservationV1 {
  id?:number;
  windowId:number;
  url?:string;
  active?:boolean;
}

export interface DiscoveredChatgptConversationV1 {
  browserInstanceId:string;
  browserProfileId:string;
  windowId:number;
  tabId:number;
  origin:string;
  projectId:string;
  canonicalProjectId:string;
  conversationId:string;
  conversationKey:string;
  active:boolean;
}

export interface ChromeTabsReadApiV1 {
  query(queryInfo:Record<string,never>):Promise<ChromeTabObservationV1[]>;
}

export interface ExactDiscoveredTargetQueryV1 {
  browserInstanceId:string;
  browserProfileId:string;
  canonicalProjectId:string;
  conversationId:string;
}

function identity(value:string,label:string):string {
  if(typeof value!=='string'||value.length===0||value.length>256)throw new Error(label+'_INVALID');
  return value;
}

export function discoverChatgptConversationTabs(
  tabs:readonly ChromeTabObservationV1[],
  browserInstanceId:string,
  browserProfileId:string,
):DiscoveredChatgptConversationV1[] {
  const instance=identity(browserInstanceId,'RBRIDGE_BROWSER_INSTANCE');
  const profile=identity(browserProfileId,'RBRIDGE_BROWSER_PROFILE');
  if(!Array.isArray(tabs)||tabs.length>4096)throw new Error('RBRIDGE_TAB_INVENTORY_INVALID');
  const seen=new Set<string>();
  const out:DiscoveredChatgptConversationV1[]=[];
  for(const tab of tabs){
    if(!Number.isInteger(tab.id)||Number(tab.id)<0||!Number.isInteger(tab.windowId)||tab.windowId<0||typeof tab.url!=='string')continue;
    let parsed;
    try{parsed=describeChatgptUrl(tab.url);}catch{continue;}
    if(parsed.kind!=='CONVERSATION'||!parsed.projectId||!parsed.canonicalProjectId||!parsed.conversationId)continue;
    const key=instance+':'+String(tab.id);
    if(seen.has(key))throw new Error('RBRIDGE_TAB_INVENTORY_DUPLICATE_TAB');
    seen.add(key);
    out.push({
      browserInstanceId:instance,browserProfileId:profile,windowId:tab.windowId,tabId:tab.id!,
      origin:parsed.origin,projectId:parsed.projectId,canonicalProjectId:parsed.canonicalProjectId,
      conversationId:parsed.conversationId,conversationKey:parsed.key,active:tab.active===true,
    });
  }
  return out.sort((a,b)=>a.windowId-b.windowId||a.tabId-b.tabId);
}

export function selectExactDiscoveredChatgptTarget(
  rows:readonly DiscoveredChatgptConversationV1[],
  query:ExactDiscoveredTargetQueryV1,
):DiscoveredChatgptConversationV1 {
  const instance=identity(query.browserInstanceId,'RBRIDGE_BROWSER_INSTANCE');
  const profile=identity(query.browserProfileId,'RBRIDGE_BROWSER_PROFILE');
  const project=identity(query.canonicalProjectId,'RBRIDGE_CANONICAL_PROJECT');
  const conversation=identity(query.conversationId,'RBRIDGE_CONVERSATION_ID');
  const matches=rows.filter(row=>row.browserInstanceId===instance&&row.browserProfileId===profile&&
    row.canonicalProjectId===project&&row.conversationId===conversation);
  if(matches.length===0)throw new Error('RBRIDGE_TARGET_NOT_FOUND');
  if(matches.length!==1)throw new Error('RBRIDGE_TARGET_AMBIGUOUS');
  return matches[0]!;
}

export class ChromeTabsInventoryAdapterV1 {
  constructor(
    private readonly tabsApi:ChromeTabsReadApiV1,
    private readonly browserInstanceId:string,
    private readonly browserProfileId:string,
  ){}

  async discover():Promise<DiscoveredChatgptConversationV1[]> {
    return discoverChatgptConversationTabs(await this.tabsApi.query({}),this.browserInstanceId,this.browserProfileId);
  }
}
