/** Detect duplicate keys before parsing; retain producer JSON number semantics. */
export function parseStrictJson(raw:string,limits:{depth?:number;nodes?:number}={}):unknown{
  // Each JSON value consumes at least one source character. The caller's reviewed
  // byte bound therefore also bounds this walk without rejecting legitimate arrays.
  let at=0,nodes=0;const depthLimit=limits.depth??64,nodeLimit=limits.nodes??raw.length;
  function fail():never{throw new Error('INSTALL_JSON_INVALID');}
  const whitespace=()=>{while(/[ \t\r\n]/.test(raw[at]??'!'))at++;};
  function string(){const start=at;if(raw[at++]!=='"')fail();let ended=false;
    while(at<raw.length){const c=raw[at++];if(c==='"'){ended=true;break;}if(c==='\\'){if(at>=raw.length)fail();at++;}}
    if(!ended)fail();try{return JSON.parse(raw.slice(start,at)) as string;}catch{fail();}
  }
  function value(depth:number){whitespace();if(depth>depthLimit||++nodes>nodeLimit)fail();const c=raw[at];
    if(c==='{'){
      at++;whitespace();const keys=new Set<string>();if(raw[at]==='}'){at++;return;}
      for(;;){whitespace();const key=string();if(keys.has(key))fail();keys.add(key);whitespace();if(raw[at++]!==':')fail();value(depth+1);whitespace();const end=raw[at++];if(end==='}')return;if(end!==',')fail();}
    }else if(c==='['){at++;whitespace();if(raw[at]===']'){at++;return;}for(;;){value(depth+1);whitespace();const end=raw[at++];if(end===']')return;if(end!==',')fail();}}
    else if(c==='"')string();
    else{const match=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(at));if(!match)fail();if(/^-?[0-9]/.test(match[0])&&!Number.isFinite(Number(match[0])))fail();at+=match[0].length;}
  }
  value(0);whitespace();if(at!==raw.length)fail();let result:unknown;try{result=JSON.parse(raw);}catch{fail();}return result;
}
