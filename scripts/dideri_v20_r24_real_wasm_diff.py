#!/usr/bin/env python3
"""DiDeRi R24: original PLAY screenshots vs pinned C++20 WebAssembly movement.

Behavioral directional comparison only, not full original/DOS/WASM parity.
No checkout edits, service, sudo, emulator replay, or production deploy.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path.home() / '.local/state/ai-tool-fabric/app-execution'
EVIDENCE = ROOT / 'dideri-v20-r23-15bhplq5'
ORIGINAL = ROOT / 'dideri-t312-private-boot-zlM8ZP/TETRIS.EXE'
SOURCE_SHA = 'd72cb451e63f32bfd3838b5e9ddc52954988b8fbb2b0c5087fef36b2f29085e6'
COMMIT = '61553c236d51b8075c5739bf5fb296f7ca8fab26'
REPO = Path('/home/games2d/backend')
FRAMES = [
    ('01_no_key', '8a5654d28bf79cb80f9766cc6d4019412af59d4cf489e617d15d7b2f88f31ca4'),
    ('02_left_7', 'b02c8bc7cae4db2a270c6b0a6a5f2557df33dcc4017409261522cbc7e42ad28c'),
    ('03_right_9', '7f9da4a537f46e300bcced1d00a0f323b807d1402f69313d0d6e81c262549e95'),
    ('04_right_9', '19745f33a66a4bba58401b505f188372fcc2b9db9c7e77b94be3de77d97cd4da'),
    ('05_left_7', '557180c8d63b2bf7b7afcdf0b09d92ab98e8e4ee63999b5e0f368679a09adb3'),
]
EXPORTS = ['reset','reset_height','command','state','toggle_next','board','piece_cell']

assert os.getuid() == 1024 and os.uname().nodename.split('.')[0] == 'aether-engine'
assert ORIGINAL.is_file() and not ORIGINAL.is_symlink()
assert hashlib.sha256(ORIGINAL.read_bytes()).hexdigest() == SOURCE_SHA
print('ORIGINAL_IDENTITY=PASS',flush=True)


def classify(r,g,b):
    if max(r,g,b) < 35:return ' '
    if max(r,g,b)-min(r,g,b) < 45:return '#' if max(r,g,b)>150 else '.'
    if r>130 and g>130 and b<125:return 'Y'
    if g>85 and b>85 and r<120:return 'C'
    if r>85 and b>85 and g<120:return 'M'
    if r>g*1.4 and r>b*1.4:return 'R'
    if g>r*1.3 and g>b*1.1:return 'G'
    if b>r*1.3 and b>g*1.2:return 'B'
    return '+'


original_x = []
for label, expected in FRAMES:
    file = EVIDENCE / (label+'.png')
    assert file.is_file() and not file.is_symlink() and file.stat().st_size < 1000000
    assert hashlib.sha256(file.read_bytes()).hexdigest() == expected, 'FRAME_HASH_'+label
    result = subprocess.run([
        'ffmpeg','-nostdin','-v','error','-i',str(file),
        '-vf','crop=720:450:160:160,scale=80:32:flags=area,format=rgb24',
        '-frames:v','1','-f','rawvideo','-',
    ],capture_output=True,check=True,timeout=15)
    raw = result.stdout
    assert len(raw)==80*32*3
    points=[]
    for y in range(4,27):
        for x in range(33,54):
            i=(y*80+x)*3
            if classify(*raw[i:i+3]) == 'M':
                points.append((x,y))
    assert len(points)>=5,'NO_ACTIVE_MAGENTA_'+label
    cx=sum(x for x,y in points)/len(points)
    original_x.append(cx)
    print('ORIGINAL_FRAME',label,'CENTER_X',round(cx,4),'N',len(points),flush=True)

with tempfile.TemporaryDirectory(prefix='dideri-r24-wasm-',dir=ROOT) as temp:
    dest=Path(temp)
    check=subprocess.run(['git','-C',str(REPO),'cat-file','-t',COMMIT],
                         capture_output=True,text=True,check=True,timeout=8)
    assert check.stdout.strip()=='commit'
    archive=subprocess.run(['git','-C',str(REPO),'archive','--format=tar',COMMIT,
                            'games/tetris312-dos'],
                           capture_output=True,check=True,timeout=20)
    assert 0 < len(archive.stdout) < 8*1024*1024
    with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tf:
        for item in tf.getmembers():
            name=Path(item.name)
            assert not name.is_absolute() and '..' not in name.parts
            assert item.name.startswith('games/tetris312-dos/')
            assert item.isfile() or item.isdir()
        tf.extractall(path=dest)
    src=dest/'games/tetris312-dos/src/tetris312_wasm_entry.cpp'
    include=dest/'games/tetris312-dos/include'
    assert src.is_file() and include.is_dir()
    wasm=dest/'tetris312_candidate.wasm'
    flags=['em++','-sSTANDALONE_WASM=1','-std=c++20','-O2','-Wl,--no-entry']
    flags += ['-Wl,--export=t312_preview_'+e for e in EXPORTS]
    flags += ['-I',str(include),str(src),'-o',str(wasm)]
    build=subprocess.run(flags,capture_output=True,text=True,timeout=75)
    if build.returncode:
        print('WASM_BUILD_STDERR_TAIL='+build.stderr[-1600:],flush=True)
        raise RuntimeError('WASM_BUILD_FAILED')
    module_hash=hashlib.sha256(wasm.read_bytes()).hexdigest()
    print('CANDIDATE_WASM_SHA256='+module_hash,flush=True)
    js=r"""
const fs=require('node:fs');
(async()=>{
 const bytes=fs.readFileSync(process.argv[1]);
 const {instance}=await WebAssembly.instantiate(bytes,{});
 const w=instance.exports, reset=w.t312_preview_reset(0,0,5);
 if(reset!==1)throw Error('RESET='+reset);
 const actions=[1,2,2,1],xs=[w.t312_preview_state(0,3)],results=[];
 for(const action of actions){
   const status=w.t312_preview_command(0,action);
   const x=w.t312_preview_state(0,3);
   results.push({action,status,x});
   if(status!==1)throw Error('ACTION_FAIL_'+action);
   xs.push(x);
 }
 console.log(JSON.stringify({reset,actions,xs,results,engine:'CPP20_WASM'}));
})().catch(e=>{console.error(String(e));process.exit(2)});
"""
    proc=subprocess.run(['node','-e',js,str(wasm)],capture_output=True,
                        text=True,timeout=15)
    if proc.returncode:
        print('WASM_RUNTIME_STDERR='+proc.stderr[-1000:],flush=True)
        raise RuntimeError('WASM_EXECUTION_FAILED')
    candidate=json.loads(proc.stdout.strip())
    print('CANDIDATE_X='+repr(candidate['xs']),flush=True)

delta_orig=[(original_x[i+1]-original_x[i])/2.2 for i in range(4)]
delta_wasm=[candidate['xs'][i+1]-candidate['xs'][i] for i in range(4)]
step_ok=[abs(a-b)<=0.35 for a,b in zip(delta_orig,delta_wasm)]
assert len(step_ok)==4
result={
 'schema':'DIDERI_ORIGINAL_WASM_DIRECTIONAL_COMPARISON_V1',
 'status':'PASS_DIRECTIONAL_INVARIANT' if all(step_ok) else 'DIFFERENCE_FOUND',
 'originalExeSha256':SOURCE_SHA,
 'originalCaptureMode':'VERIFIED_PLAY',
 'originalCaptureEvidence':'COCWIN #22384 / R23',
 'originalFrames':[{'name':n,'sha256':h,'centerX80':round(x,4)}
                   for (n,h),x in zip(FRAMES,original_x)],
 'originalNormalizedDxCells':[round(x,4) for x in delta_orig],
 'candidateSourceCommit':COMMIT,
 'candidateWasmSha256':module_hash,
 'candidateSeed':0,
 'candidateLevel':5,
 'candidateActions':[1,2,2,1],
 'candidateX':candidate['xs'],
 'candidateDxCells':delta_wasm,
 'stepToleranceCells':0.35,
 'stepsWithinTolerance':step_ok,
 'limitation':'Direction and approximately one-cell relative motion only; not matched seed, clock, piece identity, board, lock, RNG, or full DOS/WASM parity.',
 'fullOriginalParityProven':False,
 'productionChanged':False,
}
payload=json.dumps(result,sort_keys=True,indent=2)+'\n'
target=EVIDENCE/'r24_directional_comparison.json'
tmp=EVIDENCE/'r24_directional_comparison.tmp'
with tmp.open('x',encoding='utf-8') as fh:
    fh.write(payload)
    fh.flush()
    os.fsync(fh.fileno())
os.replace(tmp,target)
print('R24_RESULT='+json.dumps(result,sort_keys=True),flush=True)
print('R24_REPORT_PATH='+str(target),flush=True)
print('R24_REPORT_SHA256='+hashlib.sha256(payload.encode()).hexdigest(),flush=True)
