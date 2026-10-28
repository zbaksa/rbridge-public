import pathlib, subprocess, hashlib
root=pathlib.Path.home()/'.local/state/ai-tool-fabric/app-execution/dideri-v20-r8-ock8e67m'
for name in ['02_check_0','03_after_left']:
 p=root/(name+'.png')
 b=p.read_bytes()
 print(name,len(b),hashlib.sha256(b).hexdigest())
 r=subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(p),'-vf','crop=720:450:160:160,scale=80:32:flags=area,format=rgb24','-frames:v','1','-f','rawvideo','-'],capture_output=True,check=True,timeout=15)
 a=r.stdout
 print('FRAME',name)
 for y in range(32):
  line=''
  for x in range(80):
   k=(y*80+x)*3
   red,green,blue=a[k:k+3]
   line+=(' ' if max(red,green,blue)<35 else 'B' if blue>80 and blue>red*1.3 and blue>green*1.2 else 'C' if green>85 and blue>85 and red<120 else 'Y' if red>130 and green>130 and blue<125 else 'R' if red>green*1.4 and red>blue*1.4 else '#' if max(red,green,blue)>150 else '.')
  print(line)
print('INPUT_EFFECT=UNKNOWN; PRODUCTION_CHANGED=FALSE')
