#!/usr/bin/env python3
"""DiDeRi R26: original screenshot shape-cycle and genuine WASM rotation cycle.

Read-only saved original captures. Extract pinned Git C++20 sources only in a
temporary directory; builds temporary WASM; does NOT establish piece/seed parity.
"""
import hashlib, io, json, os, pathlib, subprocess as sp, tarfile, tempfile

ROOT=pathlib.Path.home()/'.local/state/ai-tool-fabric/app-execution'
EVIDENCE=ROOT/'dideri-v20-r25-cr0fk3i1'
GAME=ROOT/'dideri-t312-private-boot-zlM8ZP/TETRIS.EXE'
SOURCE_SHA='d72cb451e63f32bfd3838b5e9ddc52954988b8fbb2b0c5087fef36b2f29085e6'
GIT_COMMIT='61553c236d51b8075c5739bf5fb296f7ca8fab26'
REPO='/home/games2d/backend'
FRAMES={
 '00_before_rotation':'2c272f175f757f6b1b3c46597dce4324fa099278083c14eff3a92744250fe432',
 '01_passive_no_key':'784c74bde1a85181ef1d8cea23232239b3a82bcc54eb3ede02d5519b7a83b260',
 '02_after_8_first':'d669a41f9c64407c897877b84609823462a36448f3a84b968a0036eb33c18822',
 '03_after_8_second':'54129f0a92439e3876af75418a89bd4d747f8f06cfbba735f02e246af1de9b8f',
 '04_after_8_third':'958f402cfab280b54945a801412f483502ba5653c18e284ad627c29ca0da3fcb',
 '05_after_8_fourth':'e59d561e9bc48face1b45652774f219ac0ad0f8b118b8e60334c7695bcbc1613',
}
assert os.getuid()==1024 and os.uname().nodename.split('.')[0]=='aether-engine'
assert GAME.is_file() and not GAME.is_symlink()
assert hashlib.sha256(GAME.read_bytes()).hexdigest()==SOURCE_SHA
print('R26_SOURCE_ORIGINAL_SHA=PASS',flush=True)
masks={}
for label,digest in FRAMES.items():
 p=EVIDENCE/(label+'.png')
 assert p.is_file() and not p.is_symlink() and 0<p.stat().st_size<1000000
 assert hashlib.sha256(p.read_bytes()).hexdigest()==digest,'BAD_FRAME_SHA_'+label
 r=sp.run(['ffmpeg','-nostdin','-v','error','-i',str(p),'-pix_fmt','rgb24',
           '-frames:v','1','-f','rawvideo','-'],capture_output=True,check=True,timeout=12)
 a=r.stdout
 assert len(a)==1024*768*3
 pts=set()
 for y in range(218,550):
  for x in range(453,648):
   q=(y*1024+x)*3
   red,green,blue=a[q:q+3]
   if green>85 and blue>85 and red<120:
    pts.add((x,y))
 assert len(pts)>150,'NO_CYAN_PIECE_'+label
 xx=[x for x,y in pts];yy=[y for x,y in pts]
 box=[min(xx),min(yy),max(xx),max(yy)]
 normalized={(x-box[0],y-box[1]) for x,y in pts}
 masks[label]=normalized
 print('ORIGINAL_CYAN',label,'PIXELS',len(pts),'BBOX',box,
       'SIZE',[box[2]-box[0]+1,box[3]-box[1]+1],flush=True)

def similarity(p,q):
 # Each shape is origin-normalized; allow small 1-pixel resampling shifts.
 best=(0.,0,0)
 for dy in range(-5,6):
  for dx in range(-5,6):
   moved={(x+dx,y+dy) for x,y in q}
   intersection=len(p.intersection(moved))
   union=len(p)+len(q)-intersection
   score=intersection/union if union else 0
   if score>best[0]:best=(score,dx,dy)
 return (round(best[0],4),best[1],best[2])

baseline=masks['01_passive_no_key']
scores={}
for name in FRAMES:
 if name=='01_passive_no_key':continue
 scores[name]=similarity(baseline,masks[name])
 print('ORIGINAL_SHAPE_IOU_VS_PASSIVE',name,scores[name],flush=True)

with tempfile.TemporaryDirectory(prefix='dideri-r26-wasm-',dir=ROOT) as tmp:
 d=pathlib.Path(tmp)
 chk=sp.run(['git','-C',REPO,'cat-file','-t',GIT_COMMIT],capture_output=True,text=True,check=True,timeout=8)
 assert chk.stdout.strip()=='commit'
 archive=sp.run(['git','-C',REPO,'archive','--format=tar',GIT_COMMIT,'games/tetris312-dos'],
                capture_output=True,check=True,timeout=20)
 assert 0<len(archive.stdout)<8*1024*1024
 with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tf:
  for item in tf.getmembers():
   n=pathlib.PurePosixPath(item.name)
   assert not n.is_absolute() and '..' not in n.parts
   assert n.parts[:2]==('games','tetris312-dos') or n.parts==('games',)
   assert item.isfile() or item.isdir()
  tf.extractall(path=d)
 src=d/'games/tetris312-dos/src/tetris312_wasm_entry.cpp'
 inc=d/'games/tetris312-dos/include'
 wasm=d/'t312.wasm'
 assert src.is_file() and inc.is_dir()
 exports=['reset','reset_height','command','state','toggle_next','board','piece_cell']
 cmd=['em++','-sSTANDALONE_WASM=1','-std=c++20','-O2','-Wl,--no-entry']
 cmd+=['-Wl,--export=t312_preview_'+n for n in exports]
 cmd+=['-I',str(inc),str(src),'-o',str(wasm)]
 build=sp.run(cmd,capture_output=True,text=True,timeout=75)
 if build.returncode:print('BUILD_FAILURE_TAIL',build.stderr[-1300:],flush=True)
 assert build.returncode==0,'WASM_BUILD_FAILED'
 digest=hashlib.sha256(wasm.read_bytes()).hexdigest()
 js=r"""
const fs=require('node:fs');
(async()=>{
 const {instance}=await WebAssembly.instantiate(fs.readFileSync(process.argv[1]),{});
 const w=instance.exports, init=w.t312_preview_reset(0,0,5);
 if(init!==1)throw Error('RESET_'+init);
 const sample=()=>{const ori=w.t312_preview_state(0,1),id=w.t312_preview_state(0,11);
  const cells=Array.from({length:4},(_,i)=>[w.t312_preview_piece_cell(ori,i,0),w.t312_preview_piece_cell(ori,i,1)]);
  let minX=Math.min(...cells.map(z=>z[0])),minY=Math.min(...cells.map(z=>z[1]));
  return {orientation:ori,baseId:id,cells:cells.map(([x,y])=>[x-minX,y-minY]).sort((a,b)=>a[0]-b[0]||a[1]-b[1])};};
 const steps=[sample()],statuses=[];
 for(let i=0;i<4;i++){statuses.push(w.t312_preview_command(0,3));steps.push(sample());}
 const same=JSON.stringify(steps[0].cells)===JSON.stringify(steps[4].cells);
 console.log(JSON.stringify({init,statuses,steps,cycleBack:same}));
})().catch(e=>{console.error(String(e));process.exit(3)});
"""
 run=sp.run(['node','-e',js,str(wasm)],capture_output=True,text=True,timeout=15)
 if run.returncode:print('WASM_RUN_ERROR',run.stderr[-1000:],flush=True)
 assert run.returncode==0,'WASM_RUNTIME_FAILED'
 result=json.loads(run.stdout.strip())
 print('CANDIDATE_WASM_SHA256',digest,flush=True)
 print('CANDIDATE_ROTATION',json.dumps(result,sort_keys=True),flush=True)

 report={
 'schema':'DIDERI_R26_ORIGINAL_WASM_ROTATION_EVIDENCE_V1',
 'originalExeSha256':SOURCE_SHA,'originalSourceEvidence':'COCWIN #22400 verified PLAY / R25',
 'originalBestCyanShapeIoU':scores,
 'originalEndSimilarityToPassive':scores['05_after_8_fourth'][0],
 'wasmSourceCommit':GIT_COMMIT,'wasmSha256':digest,
 'candidateRotation':result,
 'originalRotationCausality':'STRONGLY_SUPPORTED_BY_FOUR_INPUTS',
 'fullOriginalWasmParityProven':False,'productionChanged':False,
 'limit':'Original seed, piece ID, orientation and gravity timing not synchronized; this is qualitative shape-cycle check, not exact board parity.'
 }
 print('R26_RESULT='+json.dumps(report,sort_keys=True),flush=True)
 result_file=EVIDENCE/'r26_rotation_comparison.json'
 blob=json.dumps(report,sort_keys=True,indent=2)+'\n'
 with result_file.open('x',encoding='utf-8') as out:
  out.write(blob)
 print('R26_PRIVATE_REPORT_SHA256='+hashlib.sha256(blob.encode()).hexdigest(),flush=True)
 print('R26_PRIVATE_REPORT_PATH='+str(result_file),flush=True)
