#!/usr/bin/env python3
"""DiDeRi V20 R10: read-only quantification of green piece in saved frames."""
import pathlib, subprocess, hashlib, os
assert os.getuid()==1024 and os.uname().nodename.split('.')[0]=='aether-engine'
root=pathlib.Path.home()/'.local/state/ai-tool-fabric/app-execution/dideri-v20-r10-9epl3fzy'
names=['control_no_key','after_3_left','after_3_right']
expect={
'control_no_key':'6d993b08f54f4eda950212daeca46da41bd53bf570840c777993353de09a939a',
'after_3_left':'244b06b5ebeb0c3053d81d0896b0f68adb42757dedee061958c023f4debdc8a4',
'after_3_right':'6343fb786a652c0919424a2846622bab83f161129a42e8a5bdce91fe53fc620c'}
results={}
for name in names:
 p=root/(name+'.png')
 assert p.is_file() and not p.is_symlink() and p.stat().st_size<1000000
 assert hashlib.sha256(p.read_bytes()).hexdigest()==expect[name],name+'_HASH_MISMATCH'
 r=subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(p),'-vf','crop=720:450:160:160,scale=80:32:flags=area,format=rgb24','-frames:v','1','-f','rawvideo','-'],capture_output=True,check=True,timeout=15)
 raw=r.stdout
 assert len(raw)==80*32*3
 pts=[]
 for y in range(4,27):
  for x in range(33,54):
   i=(y*80+x)*3
   red,green,blue=raw[i:i+3]
   if green>85 and green>red*1.3 and green>blue*1.1:
    pts.append((x,y))
 assert pts,name+'_NO_GREEN_PIECE'
 cx=sum(x for x,y in pts)/len(pts)
 cy=sum(y for x,y in pts)/len(pts)
 bbox=(min(x for x,y in pts),min(y for x,y in pts),max(x for x,y in pts),max(y for x,y in pts))
 print('FRAME',name,'PIXELS',len(pts),'CENTER_X',round(cx,3),'CENTER_Y',round(cy,3),'BBOX',bbox,flush=True)
 results[name]=(cx,cy)
for before,after in zip(names,names[1:]):
 dx=results[after][0]-results[before][0]
 dy=results[after][1]-results[before][1]
 print('DELTA',before,'TO',after,'DX',round(dx,3),'DY',round(dy,3),flush=True)
print('R10_COORDS=PASS_READ_ONLY; CAUSALITY=UNKNOWN; PRODUCTION_CHANGED=FALSE',flush=True)
