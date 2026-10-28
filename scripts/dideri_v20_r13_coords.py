#!/usr/bin/env python3
"""DiDeRi V20 R13: read-only blue-piece coordinate audit of original SPACE-start run."""
import pathlib,subprocess,hashlib,os
assert os.getuid()==1024 and os.uname().nodename.split('.')[0]=='aether-engine','OWNER_SCOPE'
root=pathlib.Path.home()/'.local/state/ai-tool-fabric/app-execution/dideri-v20-r13-hi71x3cu'
expected={
'00_control':'9425ba6a3dd5d82edb97eb2dd374fdda9fbdaae2fae26a62f85044562fdab658',
'00b_passive':'1f27f157588123db35239f4259b8be1d54b41bd4ddf1cd9caa70198d7031ae06',
'01_left1':'869900591af2ea01d408022cd58cef827f8f40597a16ac55200a5b88ae1703b1',
'02_right1':'6cf8a316a36f2d8bd2dc47953fc3213161ef1c47db56df1397f22bb97484d206',
'03_right2':'d00c1e63b62623d363d9c344e216d6f7949f343c2cc516a356e51d7823ba5d90',
'04_left2':'dbd691a3e65bd7e9e2befcad0db77a933cb72c162f90f765f259c92ac88c5dcc'}
centers={}
for name,sha in expected.items():
 p=root/(name+'.png')
 assert p.is_file() and not p.is_symlink() and p.stat().st_size<1000000
 assert hashlib.sha256(p.read_bytes()).hexdigest()==sha,'FRAME_INTEGRITY_'+name
 r=subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(p),'-vf','crop=720:450:160:160,scale=80:32:flags=area,format=rgb24','-frames:v','1','-f','rawvideo','-'],capture_output=True,check=True,timeout=15)
 rgb=r.stdout
 assert len(rgb)==80*32*3
 for color in ('BLUE','CYAN'):
  pts=[]
  for y in range(4,27):
   for x in range(33,54):
    i=(y*80+x)*3
    red,green,blue=rgb[i:i+3]
    if (color=='BLUE' and blue>red*1.3 and blue>green*1.2 and blue>80) or (color=='CYAN' and green>85 and blue>85 and red<120):
     pts.append((x,y))
  if pts:
   cx=sum(x for x,y in pts)/len(pts);cy=sum(y for x,y in pts)/len(pts)
   bbox=(min(x for x,y in pts),min(y for x,y in pts),max(x for x,y in pts),max(y for x,y in pts))
   print('FRAME',name,color,'N',len(pts),'CX',round(cx,3),'CY',round(cy,3),'BBOX',bbox,flush=True)
   if color=='BLUE':centers[name]=(cx,cy)
  else:print('FRAME',name,color,'NONE',flush=True)
names=list(expected)
for a,b in zip(names,names[1:]):
 if a in centers and b in centers:
  print('DELTA',a,b,'DX',round(centers[b][0]-centers[a][0],3),'DY',round(centers[b][1]-centers[a][1],3),flush=True)
print('R13_COORDINATES=PASS_READ_ONLY; ORIGINAL_WASM_PARITY=UNKNOWN; PRODUCTION_CHANGED=FALSE',flush=True)
