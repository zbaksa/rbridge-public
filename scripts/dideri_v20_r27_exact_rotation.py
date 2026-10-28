#!/usr/bin/env python3
"""DiDeRi R27: four-cell exact original-shape rotation versus actual C++20/WASM.

Uses *existing* original verified-PLAY snapshots and builds pinned C++20 WASM
only inside a temporary directory. No original EXE execution or production edits.
"""
import collections, hashlib, io, json, os, pathlib, subprocess as sp, tarfile, tempfile

ROOT=pathlib.Path.home()/'.local/state/ai-tool-fabric/app-execution'
EVIDENCE=ROOT/'dideri-v20-r25-cr0fk3i1'
EXE=ROOT/'dideri-t312-private-boot-zlM8ZP/TETRIS.EXE'
EXE_SHA='d72cb451e63f32bfd3838b5e9ddc52954988b8fbb2b0c5087fef36b2f29085e6'
COMMIT='61553c236d51b8075c5739bf5fb296f7ca8fab26'
REPO='/home/games2d/backend'
FRAMES=[
 ('00_before_rotation','2c272f175f757f6b1b3c46597dce4324fa099278083c14eff3a92744250fe432'),
 ('01_passive_no_key','784c74bde1a85181ef1d8cea23232239b3a82bcc54eb3ede02d5519b7a83b260'),
 ('02_after_8_first','d669a41f9c64407c897877b84609823462a36448f3a84b968a0036eb33c18822'),
 ('03_after_8_second','54129f0a92439e3876af75418a89bd4d747f8f06cfbba735f02e246af1de9b8f'),
 ('04_after_8_third','958f402cfab280b54945a801412f483502ba5653c18e284ad627c29ca0da3fcb'),
 ('05_after_8_fourth','e59d561e9bc48face1b45652774f219ac0ad0f8b118b8e60334c7695bcbc1613'),
]
assert os.getuid()==1024 and os.uname().nodename.split('.')[0]=='aether-engine'
assert EXE.is_file() and not EXE.is_symlink()
assert hashlib.sha256(EXE.read_bytes()).hexdigest()==EXE_SHA

def decoded_shape(name,digest):
 path=EVIDENCE/(name+'.png')
 assert path.is_file() and not path.is_symlink() and path.stat().st_size<1000000
 assert hashlib.sha256(path.read_bytes()).hexdigest()==digest,'FRAME_INTEGRITY_'+name
 raw=sp.run(['ffmpeg','-nostdin','-v','error','-i',str(path),
             '-pix_fmt','rgb24','-frames:v','1','-f','rawvideo','-'],
            capture_output=True,check=True,timeout=12).stdout
 assert len(raw)==1024*768*3
 pts=[]
 for y in range(218,550):
  for x in range(453,648):
   p=(y*1024+x)*3
   r,g,b=raw[p:p+3]
   if g>85 and b>85 and r<120:pts.append((x,y))
 assert len(pts)==1152,'FOUR_CELL_PIXEL_AREA_'+name
 x0=min(x for x,y in pts)
 y0=min(y for x,y in pts)
 counts=collections.Counter(((x-x0)//18,(y-y0)//16) for x,y in pts)
 assert len(counts)==4 and set(counts.values())=={18*16},'EXACT_CYAN_GRID_'+name
 cell=sorted([list(c) for c in counts])
 print('ORIGINAL_EXACT_4CELLS',name,'BOX_ORIGIN',[x0,y0],'SHAPE',cell,flush=True)
 return cell

shapes={}
for n,h in FRAMES:
 shapes[n]=decoded_shape(n,h)
assert shapes['00_before_rotation']==shapes['01_passive_no_key'],'PASSIVE_SHAPE_CHANGED'
original_seq=[shapes[n] for n,h in FRAMES[1:]]
print('ORIGINAL_5_SHAPES='+json.dumps(original_seq,separators=(',',':')),flush=True)
print('ORIGINAL_TWO_STEP_RETURN='+str(original_seq[0]==original_seq[2]==original_seq[4]),flush=True)

with tempfile.TemporaryDirectory(prefix='dideri-r27-wasm-',dir=ROOT) as tmp:
 root=pathlib.Path(tmp)
 check=sp.run(['git','-C',REPO,'cat-file','-t',COMMIT],
              capture_output=True,text=True,check=True,timeout=8)
 assert check.stdout.strip()=='commit'
 a=sp.run(['git','-C',REPO,'archive','--format=tar',COMMIT,'games/tetris312-dos'],
          capture_output=True,check=True,timeout=20)
 assert 0<len(a.stdout)<8*1024*1024
 with tarfile.open(fileobj=io.BytesIO(a.stdout)) as tf:
  for item in tf.getmembers():
   pn=pathlib.PurePosixPath(item.name)
   assert not pn.is_absolute() and '..' not in pn.parts
   assert pn.parts==('games',) or pn.parts[:2]==('games','tetris312-dos')
   assert item.isfile() or item.isdir()
  tf.extractall(path=root)
 code=root/'games/tetris312-dos/src/tetris312_wasm_entry.cpp'
 inc=root/'games/tetris312-dos/include'
 out=root/'tetris312_rotation.wasm'
 assert code.is_file() and inc.is_dir()
 exports=['reset','reset_height','command','state','toggle_next','board','piece_cell']
 command=['em++','-sSTANDALONE_WASM=1','-std=c++20','-O2','-Wl,--no-entry']
 command+=['-Wl,--export=t312_preview_'+n for n in exports]
 command+=['-I',str(inc),str(code),'-o',str(out)]
 build=sp.run(command,capture_output=True,text=True,timeout=75)
 if build.returncode:print('EMXX_STDERR_TAIL',build.stderr[-1500:],flush=True)
 assert build.returncode==0,'WASM_BUILD_FAILED'
 wasm_hash=hashlib.sha256(out.read_bytes()).hexdigest()
 js=r"""
const fs=require('node:fs');
(async()=>{
 const data=fs.readFileSync(process.argv[1]);
 const goal=JSON.parse(process.argv[2]);
 const {instance}=await WebAssembly.instantiate(data,{});
 const w=instance.exports;
 function shape(){
  const o=w.t312_preview_state(0,1);
  const cells=Array.from({length:4},(_,i)=>[w.t312_preview_piece_cell(o,i,0),w.t312_preview_piece_cell(o,i,1)]);
  const x=Math.min(...cells.map(a=>a[0])),y=Math.min(...cells.map(a=>a[1]));
  return cells.map(([a,b])=>[a-x,b-y]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 }
 const goalText=goal.map(v=>JSON.stringify(v));let match=null,matchStart=0,mismatchExamples=[];
 const roots={};
 for(let seed=0;seed<16384;seed++){
  if(w.t312_preview_reset(0,seed,5)!==1)throw Error('RESET_'+seed);
  const base=w.t312_preview_state(0,11),startShape=shape();
  if(!roots[base])roots[base]={seed,shape:startShape};
  if(JSON.stringify(startShape)!==goalText[0])continue;
  matchStart++;
  const seq=[startShape],states=[w.t312_preview_state(0,1)],codes=[];
  for(let i=0;i<4;i++){
   codes.push(w.t312_preview_command(0,3));
   seq.push(shape());states.push(w.t312_preview_state(0,1));
  }
  const ok=seq.every((x,i)=>JSON.stringify(x)===goalText[i]);
  if(ok){match={seed,baseId:base,states,codes,shapes:seq};break;}
  if(mismatchExamples.length<3)mismatchExamples.push({seed,base,states,codes,seq});
 }
 console.log(JSON.stringify({maxSeeds:16384,matchingInitialSeeds:matchStart,
   match,roots,mismatchExamples,wasm:'ACTUAL_CPP20_WASM'}));
})().catch(e=>{console.error(String(e));process.exit(4)});
"""
 run=sp.run(['node','-e',js,str(out),json.dumps(original_seq,separators=(',',':'))],
            capture_output=True,text=True,timeout=30)
 if run.returncode:print('NODE_ERROR',run.stderr[-1300:],flush=True)
 assert run.returncode==0,'WASM_ROTATION_EXECUTION_FAILED'
 wasm=json.loads(run.stdout.strip())
 print('ROTATION_WASM_SEARCH='+json.dumps(wasm,sort_keys=True),flush=True)
 status='PASS_EXACT_4CELL_ROTATION_SEQUENCE' if wasm['match'] else 'NO_EXACT_MATCH'
 report={
  'schema':'DIDERI_R27_EXACT_FOUR_CELL_ROTATION_DIFFERENTIAL_V1',
  'status':status,'originalExeSha256':EXE_SHA,'originalVerifiedPlayRef':'COCWIN #22400',
  'originalShapes':original_seq,'originalImageSha256':[h for _,h in FRAMES],
  'wasmCommit':COMMIT,'wasmSha256':wasm_hash,'wasmSearch':wasm,
  'comparisonScope':'one original figure shape, four rotations, relative coordinates; no seed synchronization',
  'fullOriginalParityProven':False,'productionChanged':False}
 blob=json.dumps(report,sort_keys=True,indent=2)+'\n'
 target=EVIDENCE/'r27_exact_rotation_diff.json'
 with target.open('x',encoding='utf-8') as f:f.write(blob)
 print('R27_RESULT_STATUS='+status,flush=True)
 print('R27_PRIVATE_REPORT='+str(target),flush=True)
 print('R27_PRIVATE_REPORT_SHA256='+hashlib.sha256(blob.encode()).hexdigest(),flush=True)
