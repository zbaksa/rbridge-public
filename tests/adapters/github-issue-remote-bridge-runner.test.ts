import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createGitHubIssueRemoteBridge} from '../../src/adapters/githubIssueRemoteBridge.js';

vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const REPO='example/control',AUTHOR='owner',CAP=1_048_576;
function childFor(output:(child:ReturnType<typeof childFor>,input:string)=>void){
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
  let input='';child.stdin.on('data',chunk=>{input+=chunk.toString();});
  child.stdin.on('finish',()=>output(child,input));return child;
}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('bounded gh child output',()=>{
  it('decodes fragmented UTF-8 only after collecting raw bytes',async()=>{
    vi.mocked(spawn).mockImplementation(()=>childFor((child,input)=>{
      const request=input?JSON.parse(input) as {query:string}:undefined;
      const issue={number:1,title:'[COCWIN BRIDGE REQUEST] č🙂',body:'č🙂',author:{login:AUTHOR},state:'OPEN',url:`https://github.com/${REPO}/issues/1`};
      const repository=request?.query.includes('issues(')?{nameWithOwner:REPO,issues:{nodes:[issue],pageInfo:{hasNextPage:false,endCursor:null}}}:{nameWithOwner:REPO,issue};
      const bytes=Buffer.from(JSON.stringify(request?{data:{repository}}:[issue]));
      for(const byte of bytes)child.stdout.write(Buffer.from([byte]));child.emit('close',0);
    }) as unknown as ReturnType<typeof spawn>);
    const found=await createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR}).listOpenRequests();
    expect(found[0]!.body).toBe('č🙂');expect(found[0]!.title).toBe('[COCWIN BRIDGE REQUEST] č🙂');
  });
  it.each(['stdout','stderr'] as const)('kills a command after %s exceeds the configured raw-byte cap',async stream=>{
    const children:ReturnType<typeof childFor>[]=[];
    vi.mocked(spawn).mockImplementation(()=>{const child=childFor(target=>{target[stream].write(Buffer.alloc(CAP+1));target[stream].write(Buffer.alloc(100));target.emit('close',0);});children.push(child);return child as unknown as ReturnType<typeof spawn>;});
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,maxOutputBytes:CAP}).publishResult(1,{ok:true})).rejects.toThrow('REMOTE_BRIDGE_GITHUB_OUTPUT_TOO_LARGE');
    expect(children).toHaveLength(1);expect(children[0]!.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });
  it('allows each stream at its own cap without combining stdout and stderr',async()=>{
    vi.mocked(spawn).mockImplementation(()=>childFor(child=>{child.stdout.write(Buffer.alloc(CAP,120));child.stderr.write(Buffer.alloc(CAP,121));child.emit('close',0);}) as unknown as ReturnType<typeof spawn>);
    await expect(createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,maxOutputBytes:CAP}).publishResult(1,{ok:true})).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('terminates at the configured timeout',async()=>{
    vi.useFakeTimers();const child=childFor(()=>{});vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const promise=createGitHubIssueRemoteBridge({repository:REPO,authorLogin:AUTHOR,timeoutMs:1000}).publishResult(1,{ok:true});
    const assertion=expect(promise).rejects.toThrow('REMOTE_BRIDGE_GITHUB_TIMEOUT');
    await vi.advanceTimersByTimeAsync(1000);await assertion;expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });
});
