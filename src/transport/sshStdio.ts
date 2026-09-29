import {M0_LIMITS,canonicalJson} from '../domain/rbridgeChatCore.js';

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const SAFE_TOKEN=/^[A-Za-z0-9._:-]+$/;
const FIXED_REMOTE_COMMAND='rbridge-chat-stdio-v1';
function fail(code:string):never{throw new Error(code);}
function absolutePath(value:string,code:string):string{if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('\0')||/[\r\n]/u.test(value))fail(code);return value;}

export interface SshStdioLaunchConfig{
  sshPath:string;
  host:string;
  port:number;
  user:'rbridge';
  identityFile:string;
  knownHostsFile:string;
}
export interface SshStdioLaunch{
  command:string;
  args:string[];
  options:{shell:false;stdio:['pipe','pipe','pipe']};
}

export function buildSshStdioLaunch(config:SshStdioLaunchConfig):SshStdioLaunch{
  const command=absolutePath(config.sshPath,'RBRIDGE_SSH_PATH_INVALID');
  if(config.user!=='rbridge')fail('RBRIDGE_SSH_USER_INVALID');
  if(typeof config.host!=='string'||!SAFE_TOKEN.test(config.host)||config.host.startsWith('-'))fail('RBRIDGE_SSH_HOST_INVALID');
  if(!Number.isInteger(config.port)||config.port<1||config.port>65535)fail('RBRIDGE_SSH_PORT_INVALID');
  const identity=absolutePath(config.identityFile,'RBRIDGE_SSH_IDENTITY_INVALID');
  const knownHosts=absolutePath(config.knownHostsFile,'RBRIDGE_SSH_KNOWN_HOSTS_INVALID');
  const args=[
    '-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oIdentitiesOnly=yes','-oPasswordAuthentication=no','-oKbdInteractiveAuthentication=no',
    '-oUserKnownHostsFile='+knownHosts,'-i',identity,'-p',String(config.port),config.user+'@'+config.host,FIXED_REMOTE_COMMAND,
  ];
  return {command,args,options:{shell:false,stdio:['pipe','pipe','pipe']}};
}

export function encodeStdioFrame(value:unknown,maxBytes=M0_LIMITS.maxRbridgeControlMessageUtf8Bytes):Uint8Array{
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>M0_LIMITS.maxRbridgeControlMessageUtf8Bytes)fail('RBRIDGE_STDIO_LIMIT_INVALID');
  const body=encoder.encode(canonicalJson(value));if(body.byteLength===0||body.byteLength>maxBytes)fail('RBRIDGE_STDIO_MESSAGE_TOO_LARGE');
  const out=new Uint8Array(body.byteLength+1);out.set(body);out[out.length-1]=0x0a;return out;
}

export class StdioFrameDecoder{
  private buffer=new Uint8Array(0);
  constructor(private readonly maxBytes=M0_LIMITS.maxRbridgeControlMessageUtf8Bytes){
    if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>M0_LIMITS.maxRbridgeControlMessageUtf8Bytes)fail('RBRIDGE_STDIO_LIMIT_INVALID');
  }
  push(chunk:Uint8Array):unknown[]{
    if(!(chunk instanceof Uint8Array))fail('RBRIDGE_STDIO_CHUNK_INVALID');
    const merged=new Uint8Array(this.buffer.byteLength+chunk.byteLength);merged.set(this.buffer);merged.set(chunk,this.buffer.byteLength);this.buffer=merged;
    const out:unknown[]=[];
    for(;;){
      const newline=this.buffer.indexOf(0x0a);if(newline<0)break;
      if(newline===0||newline>this.maxBytes)fail('RBRIDGE_STDIO_MESSAGE_TOO_LARGE');
      const body=this.buffer.slice(0,newline);let parsed:unknown;
      try{parsed=JSON.parse(decoder.decode(body));}catch{fail('RBRIDGE_STDIO_MESSAGE_INVALID');}
      out.push(parsed);this.buffer=this.buffer.slice(newline+1);
    }
    if(this.buffer.byteLength>this.maxBytes)fail('RBRIDGE_STDIO_MESSAGE_TOO_LARGE');return out;
  }
  pendingBytes():number{return this.buffer.byteLength;}
}
