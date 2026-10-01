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
