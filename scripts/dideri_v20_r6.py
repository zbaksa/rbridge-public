import os, pathlib, tempfile, hashlib, ctypes, ctypes.util, subprocess, time, re
root=pathlib.Path.home()/'.local/state/ai-tool-fabric/app-execution'
src=root/'dideri-t312-private-boot-zlM8ZP/TETRIS.EXE'
stage=root/'dideri-dosbox-rootless-q9Zm5A'
runner=stage/'unpacked/usr/bin/dosbox-x'
deps=stage/'deps'
expected='d72cb451e63f32bfd3838b5e9ddc52954988b8fbb2b0c5087fef36b2f29085e6'
assert os.uname().nodename.split('.')[0]=='aether-engine' and os.getuid()==1024, 'OWNER_SCOPE'
assert src.is_file() and not src.is_symlink() and hashlib.sha256(src.read_bytes()).hexdigest()==expected, 'SOURCE_HASH'
assert runner.is_file() and not runner.is_symlink(), 'RUNNER'
x11=ctypes.CDLL(ctypes.util.find_library('X11'))
xt=ctypes.CDLL(ctypes.util.find_library('Xtst'))
x11.XOpenDisplay.argtypes=[ctypes.c_char_p];x11.XOpenDisplay.restype=ctypes.c_void_p
x11.XKeysymToKeycode.argtypes=[ctypes.c_void_p,ctypes.c_ulong];x11.XKeysymToKeycode.restype=ctypes.c_uint
x11.XSetInputFocus.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
x11.XRaiseWindow.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
x11.XFlush.argtypes=[ctypes.c_void_p]
x11.XCloseDisplay.argtypes=[ctypes.c_void_p]
xt.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong];xt.XTestFakeKeyEvent.restype=ctypes.c_int
d=x11.XOpenDisplay(None)
assert d,'DISPLAY'
base=pathlib.Path(tempfile.mkdtemp(prefix='dideri-v20-r6-',dir=root))
print('RESULT_DIR='+str(base),flush=True)
def key(k):
    c=x11.XKeysymToKeycode(d,k)
    if not c:raise RuntimeError('NO_KEYCODE')
    a=xt.XTestFakeKeyEvent(d,c,1,0);x11.XFlush(d);time.sleep(.12)
    b=xt.XTestFakeKeyEvent(d,c,0,0);x11.XFlush(d)
    if not a or not b:raise RuntimeError('XTEST_FAILURE')
def focus():
    o=subprocess.run(['xwininfo','-root','-tree'],capture_output=True,text=True,timeout=5,check=True).stdout
    candidates=[]
    for line in o.splitlines():
        if 'dosbox' in line.lower():
            m=re.search(r'0x[0-9a-fA-F]+',line)
            if m:candidates.append(int(m.group(),16))
    if not candidates:raise RuntimeError('WINDOW_NOT_FOUND')
    win=candidates[-1]
    x11.XRaiseWindow(d,win);x11.XSetInputFocus(d,win,1,0);x11.XFlush(d)
    return win
def frame(case,name):
    p=base/(case+'_'+name+'.png')
    r=subprocess.run(['ffmpeg','-nostdin','-loglevel','error','-f','x11grab','-video_size','1024x768','-i',os.environ['DISPLAY'],'-frames:v','1','-y',str(p)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=9)
    if r.returncode or not p.is_file():raise RuntimeError('CAPTURE_'+case+'_'+name+':'+r.stderr.decode(errors='replace')[-150:])
    digest=hashlib.sha256(p.read_bytes()).hexdigest()
    print('FRAME',case,name,p.stat().st_size,digest,flush=True)
    return p
def run(case,send_left):
    game=base/case;game.mkdir(mode=0o700);(game/'TETRIS.EXE').write_bytes(src.read_bytes())
    env=os.environ.copy();env.update(HOME=str(game),XDG_CONFIG_HOME=str(game),XDG_CACHE_HOME=str(game),XDG_DATA_HOME=str(game),SDL_VIDEODRIVER='x11',SDL_AUDIODRIVER='dummy',LD_LIBRARY_PATH=str(deps/'usr/lib/x86_64-linux-gnu')+':'+str(deps/'lib/x86_64-linux-gnu'))
    args=[str(runner),'-noconfig','-noautoexec','-fastlaunch','-time-limit','17','-c',f'MOUNT C "{game}"','-c','C:','-c','TETRIS.EXE','-c','EXIT','-exit']
    p=None
    try:
        with (base/(case+'.log')).open('wb') as f:
            p=subprocess.Popen(args,cwd=game,env=env,stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
            time.sleep(3)
            if p.poll() is not None:raise RuntimeError(case+'_RUNNER_EARLY_EXIT')
            print('FOCUS',case,hex(focus()),flush=True)
            key(ord('7'));time.sleep(1.3)
            key(0xff0d);time.sleep(1.3)
            before=frame(case,'pre')
            if send_left:key(0xff51)
            time.sleep(1.3)
            after=frame(case,'post')
            print('CASE',case,'LEFT',send_left,'RUNNING',p.poll() is None,flush=True)
            return before,after
    finally:
        if p is not None and p.poll() is None:
            p.terminate()
            try:p.wait(timeout=3)
            except subprocess.TimeoutExpired:p.kill();p.wait()
try:
    run('control',False)
    run('left',True)
    print('R6_CAPTURE=PASS; INPUT_EFFECT=UNKNOWN; PARITY=UNKNOWN; PRODUCTION_CHANGED=FALSE',flush=True)
finally:
    x11.XCloseDisplay(d)
