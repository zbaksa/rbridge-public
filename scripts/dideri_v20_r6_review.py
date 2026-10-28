#!/usr/bin/env python3
import pathlib, subprocess, hashlib
root=pathlib.Path.home()/'.local/state/ai-tool-fabric/app-execution/dideri-v20-r6-ff8fq_5h'
names=['control_pre','control_post','left_pre','left_post']
W,H=80,32
def load(name):
    p=root/(name+'.png')
    if not p.is_file() or p.is_symlink() or p.stat().st_size>1000000:raise RuntimeError('UNSAFE_OR_MISSING_'+name)
    raw=subprocess.run(['ffmpeg','-nostdin','-v','error','-i',str(p),'-vf','crop=720:450:160:160,scale=80:32:flags=area,format=rgb24','-frames:v','1','-f','rawvideo','-'],capture_output=True,timeout=15,check=True).stdout
    if len(raw)!=W*H*3:raise RuntimeError('INVALID_FRAME_'+name)
    return raw
def ch(r,g,b):
    if max(r,g,b)<35:return ' '
    if max(r,g,b)-min(r,g,b)<45:return '#' if max(r,g,b)>150 else '.'
    if r>130 and g>130 and b<125:return 'Y'
    if g>85 and b>85 and r<120:return 'C'
    if r>85 and b>85 and g<120:return 'M'
    if r>g*1.4 and r>b*1.4:return 'R'
    if g>r*1.3 and g>b*1.1:return 'G'
    if b>r*1.3 and b>g*1.2:return 'B'
    return '+'
f={n:load(n) for n in names}
print('DIDERI_R6_EXISTING_FRAME_REVIEW_V1')
for n,raw in f.items():
    print('=== '+n.upper()+' ===')
    for y in range(H):
        print(''.join(ch(*raw[(y*W+x)*3:(y*W+x)*3+3]) for x in range(W)))
for a,b in [('control_pre','left_pre'),('control_pre','control_post'),('left_pre','left_post'),('control_post','left_post')]:
    changed=sum(max(abs(f[a][i+j]-f[b][i+j]) for j in range(3))>20 for i in range(0,W*H*3,3))
    print('PAIR',a,b,'CHANGED_PCT',round(100*changed/(W*H),2))
print('R6_REVIEW=PASS_READ_ONLY; GAMEPLAY_PARITY=UNKNOWN; PRODUCTION_CHANGED=FALSE')
