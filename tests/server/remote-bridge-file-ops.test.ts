import {mkdtemp,mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {createRemoteBridgeFileOps} from '../../src/server/remoteBridgeFileOps.js';
type ListResult={entries:Array<{name:string;type:string}>};
type StatResult={type:string;size:number};
type ReadResult={text:string};
type ReadManyResult={files:Array<{path:string;text:string}>};
type SearchResult={matches:Array<{path:string}>;truncated:boolean};

async function fixture(){
  const base=await mkdtemp(join(tmpdir(),'bridge-fileops-'));
  const root=join(base,'root'),outside=join(base,'outside');
  await mkdir(root);await mkdir(outside);
  const fileOps=createRemoteBridgeFileOps({allowedRoots:[root],maxReadBytes:64,maxSearchResults:2});
  return {base,root,outside,fileOps};
}

describe('remote bridge safe FILE operations',()=>{
  it('lists, stats, reads and reads many only below an allowed root',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'a.txt'),'alpha');
    await writeFile(join(root,'b.txt'),'beta');
    const list=await fileOps.execute({kind:'FILE',action:'LIST',target:root,args:{maxEntries:10}}) as ListResult;
    expect(list.entries.map(x=>x.name)).toEqual(['a.txt','b.txt']);
    const stat=await fileOps.execute({kind:'FILE',action:'STAT',target:join(root,'a.txt'),args:{}}) as StatResult;
    expect(stat.type).toBe('file');expect(stat.size).toBe(5);
    const read=await fileOps.execute({kind:'FILE',action:'READ',target:join(root,'a.txt'),args:{}}) as ReadResult;
    expect(read.text).toBe('alpha');
    const many=await fileOps.execute({kind:'FILE',action:'READ_MANY',target:root,args:{paths:['a.txt','b.txt']}}) as ReadManyResult;
    expect(many.files.map(x=>x.text)).toEqual(['alpha','beta']);
  });

  it('writes/appends/edits/moves atomically inside one allowed root',async()=>{
    const {root,fileOps}=await fixture();
    const a=join(root,'a.txt'),b=join(root,'b.txt');
    await fileOps.execute({kind:'FILE',action:'WRITE_TEXT',target:a,args:{text:'one two one'}});
    await fileOps.execute({kind:'FILE',action:'APPEND_TEXT',target:a,args:{text:' three'}});
    await fileOps.execute({kind:'FILE',action:'EDIT_EXACT',target:a,args:{oldText:'one',newText:'ONE',expectedReplacements:2}});
    expect(await readFile(a,'utf8')).toBe('ONE two ONE three');
    await fileOps.execute({kind:'FILE',action:'MOVE',target:a,args:{destination:b}});
    expect(await readFile(b,'utf8')).toBe('ONE two ONE three');
  });

  it('searches with bounded results and deterministic ordering',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'a.txt'),'needle a');
    await writeFile(join(root,'b.txt'),'needle b');
    await writeFile(join(root,'c.txt'),'needle c');
    const out=await fileOps.execute({kind:'FILE',action:'SEARCH',target:root,args:{query:'needle'}}) as SearchResult;
    expect(out.matches).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.matches.map(x=>x.path)).toEqual([join(root,'a.txt'),join(root,'b.txt')]);
  });

  it('fails closed on traversal, symlink escapes, secret paths, cross-root moves and oversized reads',async()=>{
    const {root,outside,fileOps}=await fixture();
    const outsideFile=join(outside,'outside.txt');await writeFile(outsideFile,'outside');
    await symlink(outside,join(root,'escape'));
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'escape','outside.txt'),args:{}})).rejects.toThrow(/SYMLINK|ROOT/);
    await symlink(outsideFile,join(root,'final-link'));
    await expect(fileOps.execute({kind:'FILE',action:'WRITE_TEXT',target:join(root,'final-link'),args:{text:'x'}})).rejects.toThrow(/SYMLINK/);
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'..','outside','outside.txt'),args:{}})).rejects.toThrow(/PATH|ROOT/);
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'.ssh','id_ed25519'),args:{}})).rejects.toThrow(/SECRET/);
    await writeFile(join(root,'big.txt'),'x'.repeat(65));
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'big.txt'),args:{}})).rejects.toThrow(/TOO_LARGE/);
    await expect(fileOps.execute({kind:'FILE',action:'MOVE',target:outsideFile,args:{destination:join(root,'moved.txt')}})).rejects.toThrow(/ROOT/);
  });

  it('requires exact replacement count and leaves the original unchanged on mismatch',async()=>{
    const {root,fileOps}=await fixture();const target=join(root,'edit.txt');
    await writeFile(target,'x x');
    await expect(fileOps.execute({kind:'FILE',action:'EDIT_EXACT',target,args:{oldText:'x',newText:'y',expectedReplacements:1}})).rejects.toThrow(/REPLACEMENT_COUNT/);
    expect(await readFile(target,'utf8')).toBe('x x');
  });

  it('rejects READ target paths containing actual NUL characters with REMOTE_BRIDGE_FILE_PATH_INVALID',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'file.txt'),'content');
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'file\u0000.txt'),args:{}})).rejects.toThrow(/REMOTE_BRIDGE_FILE_PATH_INVALID/);
  });

  it('rejects READ_MANY with relative items containing actual NUL characters with REMOTE_BRIDGE_FILE_PATH_INVALID',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'file.txt'),'content');
    await expect(fileOps.execute({kind:'FILE',action:'READ_MANY',target:root,args:{paths:['file\u0000.txt']}})).rejects.toThrow(/REMOTE_BRIDGE_FILE_PATH_INVALID/);
  });

  it('rejects WRITE_TEXT with text containing actual NUL characters with REMOTE_BRIDGE_FILE_TEXT_INVALID',async()=>{
    const {root,fileOps}=await fixture();
    await expect(fileOps.execute({kind:'FILE',action:'WRITE_TEXT',target:join(root,'file.txt'),args:{text:'content\u0000'} })).rejects.toThrow(/REMOTE_BRIDGE_FILE_TEXT_INVALID/);
  });

  it('rejects READ_MANY when aggregate text bytes exceed maxReadBytes',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'a.txt'),'a'.repeat(40));
    await writeFile(join(root,'b.txt'),'b'.repeat(40));
    await expect(fileOps.execute({kind:'FILE',action:'READ_MANY',target:root,args:{paths:['a.txt','b.txt']}})).rejects.toThrow(/REMOTE_BRIDGE_FILE_TOO_LARGE/);
  });
});
