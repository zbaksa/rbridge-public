#!/usr/bin/env python3
"""DiDeRi V20 R8: gate keyboard test on a visually confirmed game board. Private test only."""
import os, pathlib, tempfile, hashlib, subprocess as sp, time, ctypes, ctypes.util, re
root=pathlib.Path.home()/'.local/state/ai-tool-fabric/app-execution'
source=root/'dideri-t312-private-boot-zlM8ZP/TETRIS.EXE'
stage=root/'dideri-dosbox-rootless-q9Zm5A'
runner=stage/'unpacked/usr/bin/dosbox-x'
assert os.uname().nodename.split('.')[0]=='aether-engine' and os.getuid()==1024,'OWNER_SCOPE'
assert source.is_file() and not source.is_symlink()
assert hashlib.sha256(source.read_bytes()).hexdigest()=='d72cb451e63f32bfd3838b5e9ddc52954988b8fbb2b0c5087fef36b2f29085e6'
assert runner.is_file() and not runner.is_symlink()
x11=ctypes.CDLL(ctypes.util.find_library('X11'));xt=ctypes.CDLL(ctypes.util.find_library('Xtst'))
x11.XOpenDisplay.argtypes=[ctypes.c_char_p];x11.XOpenDisplay.restype=ctypes.c_void_p
x11.XKeysymToKeycode.argtypes=[ctypes.c_void_p,ctypes.c_ulong];x11.XKeysymToKeycode.restype=ctypes.c_uint
x11.XRaiseWindow.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
x11.XSetInputFocus.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
x11.XFlush.argtypes=[ctypes.c_void_p];x11.XCloseDisplay.argtypes=[ctypes.c_void_p]
xt.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
xt.XTestFakeKeyEvent.restype=ctypes.c_int
display=x11.XOpenDisplay(None)
assert display,'DISPLAY'
dest=pathlib.Path(tempfile.mkdtemp(prefix='dideri-v20-r8-',dir=root))
game=dest/'game';game.mkdir(mode=0o700);(game/'TETRIS.EXE').write_bytes(source.read_bytes())
print('RESULT_DIR='+str(dest),flush=True)
deps=stage/'deps'
env=os.environ.copy();env.update(HOME=str(game),XDG_CONFIG_HOME=str(game),XDG_CACHE_HOME=str(game),XDG_DATA_HOME=str(game),SDL_VIDEODRIVER='x11',SDL_AUDIODRIVER='dummy',LD_LIBRARY_PATH=str(deps/'usr/lib/x86_64-linux-gnu')+':'+str(deps/'lib/x86_64-linux-gnu'))
args=[str(runner),'-noconfig','-noautoexec','-fastlaunch','-time-limit','30','-c',f'MOUNT C "{game}"','-c','C:','-c','TETRIS.EXE','-c','EXIT','-exit']
def key(sym):
    code=x11.XKeysymToKeycode(display,sym)
    assert code,'KEYCODE'
    assert xt.XTestFakeKeyEvent(display,code,1,0),'KEYDOWN'
    x11.XFlush(display);time.sleep(.12)
    assert xt.XTestFakeKeyEvent(display,code,0,0),'KEYUP'
    x11.XFlush(display)
def focus():
    raw=sp.run(['xwininfo','-root','-tree'],capture_output=True,text=True,check=True,timeout=4).stdout
    hits=[]
    for l in raw.splitlines():
        if re.search('dosbox',l,re.I):
            m=re.search(r'0x[0-9a-fA-F]+',l)
            if m:hits.append(int(m.group(),16))
    if not hits:raise RuntimeError('WINDOW_NOT_FOUND')
    x11.XRaiseWindow(display,hits[-1]);x11.XSetInputFocus(display,hits[-1],1,0);x11.XFlush(display)
    return hits[-1]
def shot(label):
    file=dest/(label+'.png')
    sp.run(['ffmpeg','-nostdin','-v','error','-f','x11grab','-video_size','1024x768','-i',os.environ['DISPLAY'],'-frames:v','1','-y',str(file)],stdout=sp.DEVNULL,stderr=sp.PIPE,timeout=8,check=True)
    raw=sp.run(['ffmpeg','-nostdin','-v','error','-i',str(file),'-vf','crop=720:450:160:160,scale=80:32:flags=area,format=rgb24','-frames:v','1','-f','rawvideo','-'],capture_output=True,timeout=8,check=True).stdout
    assert len(raw)==80*32*3,'RAW_FRAME_LENGTH'
    blue=sum(raw[i+2]>80 and raw[i+2]>raw[i]*1.3 and raw[i+2]>raw[i+1]*1.2 for i in range(0,len(raw),3))
    digest=hashlib.sha256(file.read_bytes()).hexdigest()
    print('FRAME',label,'BLUE',blue,'HASH',digest,flush=True)
    return blue,digest
def prior(label):
    f=root/'dideri-v20-r6-ff8fq_5h'/(label+'.png')
    if not f.is_file():return None
    raw=sp.run(['ffmpeg','-nostdin','-v','error','-i',str(f),'-vf','crop=720:450:160:160,scale=80:32:flags=area,format=rgb24','-frames:v','1','-f','rawvideo','-'],capture_output=True,check=True,timeout=8).stdout
    return sum(raw[i+2]>80 and raw[i+2]>raw[i]*1.3 and raw[i+2]>raw[i+1]*1.2 for i in range(0,len(raw),3))
proc=None
try:
    calibration={s:prior(s) for s in ('control_pre','left_pre')}
    print('CALIBRATION',calibration,flush=True)
    if calibration['control_pre'] is None or calibration['left_pre'] is None or calibration['control_pre']<20 or calibration['left_pre']>=10:
        raise RuntimeError('BOARD_CLASSIFIER_NOT_SEPARATED')
    with (dest/'console.log').open('wb') as log:
        proc=sp.Popen(args,cwd=game,env=env,stdin=sp.DEVNULL,stdout=log,stderr=sp.STDOUT,start_new_session=True)
        time.sleep(2.5)
        if proc.poll() is not None:raise RuntimeError('RUNNER_EXIT_EARLY')
        print('FOCUS',hex(focus()),flush=True)
        baseline=shot('00_title')
        key(ord('7'));time.sleep(1)
        after7=shot('01_after7')
        if after7[0]>=20:print('BOARD_AFTER_7=YES',flush=True)
        else:
            key(0xff0d);time.sleep(1)
        ready=None
        for j in range(6):
            if proc.poll() is not None:break
            v=shot(f'02_check_{j}')
            if v[0]>=20:
                ready=v
                break
            if j in (1,3):
                key(0xff0d)
            time.sleep(.65)
        if ready is None:
            print('BOARD_READY=BLOCKED; LEFT_NOT_SENT=TRUE',flush=True)
        else:
            print('BOARD_READY=PASS',flush=True)
            key(0xff51);time.sleep(.35)
            after=shot('03_after_left')
            print('FRAME_CHANGE_AFTER_LEFT='+str(ready[1]!=after[1]),flush=True)
            print('LEFT_XTEST_SENT=PASS; ORIGINAL_INPUT_EFFECT=UNKNOWN',flush=True)
finally:
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:proc.wait(timeout=3)
        except sp.TimeoutExpired:proc.kill();proc.wait()
    x11.XCloseDisplay(display)
print('PRODUCTION_CHANGED=FALSE; ORIGINAL_PARITY=UNKNOWN',flush=True)
