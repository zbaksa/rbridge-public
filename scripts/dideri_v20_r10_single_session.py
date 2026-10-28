#!/usr/bin/env python3
"""DiDeRi V20 R10: one original-DOS game, board-gated control/left/right trace.

Isolated private staging; captures/observations only. Does not assert gameplay parity.
"""
import ctypes
import ctypes.util
import hashlib
import os
import pathlib
import re
import subprocess as sp
import tempfile
import time

root = pathlib.Path.home() / '.local/state/ai-tool-fabric/app-execution'
original = root / 'dideri-t312-private-boot-zlM8ZP/TETRIS.EXE'
stage = root / 'dideri-dosbox-rootless-q9Zm5A'
runner = stage / 'unpacked/usr/bin/dosbox-x'
expected = 'd72cb451e63f32bfd3838b5e9ddc52954988b8fbb2b0c5087fef36b2f29085e6'
assert os.getuid() == 1024 and os.uname().nodename.split('.')[0] == 'aether-engine', 'OWNER_SCOPE'
assert original.is_file() and not original.is_symlink(), 'SOURCE_MISSING'
assert hashlib.sha256(original.read_bytes()).hexdigest() == expected, 'ORIGINAL_HASH'
assert runner.is_file() and not runner.is_symlink(), 'DOSBOX_MISSING'

x11 = ctypes.CDLL(ctypes.util.find_library('X11'))
xt = ctypes.CDLL(ctypes.util.find_library('Xtst'))
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XKeysymToKeycode.restype = ctypes.c_uint
x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
x11.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xt.XTestFakeKeyEvent.restype = ctypes.c_int

display = x11.XOpenDisplay(None)
assert display, 'XVFB_DISPLAY'
dest = pathlib.Path(tempfile.mkdtemp(prefix='dideri-v20-r10-', dir=root))
game = dest / 'game'
game.mkdir(mode=0o700)
(game / 'TETRIS.EXE').write_bytes(original.read_bytes())
print('RESULT_DIR=' + str(dest), flush=True)

deps = stage / 'deps'
env = os.environ.copy()
env.update(
    HOME=str(game),
    XDG_CONFIG_HOME=str(game),
    XDG_CACHE_HOME=str(game),
    XDG_DATA_HOME=str(game),
    SDL_VIDEODRIVER='x11',
    SDL_AUDIODRIVER='dummy',
    LD_LIBRARY_PATH=str(deps / 'usr/lib/x86_64-linux-gnu') + ':' +
                    str(deps / 'lib/x86_64-linux-gnu'),
)
args = [
    str(runner), '-noconfig', '-noautoexec', '-fastlaunch',
    '-time-limit', '30',
    '-c', f'MOUNT C "{game}"', '-c', 'C:',
    '-c', 'TETRIS.EXE', '-c', 'EXIT', '-exit',
]
start = time.monotonic()


def key(symbol, hold=0.045):
    code = x11.XKeysymToKeycode(display, symbol)
    assert code, 'KEYCODE_UNAVAILABLE'
    assert xt.XTestFakeKeyEvent(display, code, 1, 0), 'XTEST_DOWN'
    x11.XFlush(display)
    time.sleep(hold)
    assert xt.XTestFakeKeyEvent(display, code, 0, 0), 'XTEST_UP'
    x11.XFlush(display)


def focus():
    text = sp.run(
        ['xwininfo', '-root', '-tree'], capture_output=True,
        check=True, text=True, timeout=4,
    ).stdout
    windows = []
    for line in text.splitlines():
        if re.search('DOSBox', line, re.I):
            match = re.search(r'0x[0-9a-fA-F]+', line)
            if match:
                windows.append(int(match.group(), 16))
    if not windows:
        raise RuntimeError('DOSBOX_WINDOW_MISSING')
    win = windows[-1]
    x11.XRaiseWindow(display, win)
    x11.XSetInputFocus(display, win, 1, 0)
    x11.XFlush(display)
    print('FOCUS=' + hex(win), flush=True)


def classify_pixel(r, g, b):
    if max(r, g, b) < 35:
        return ' '
    if max(r, g, b) - min(r, g, b) < 45:
        return '#' if max(r, g, b) > 150 else '.'
    if r > 130 and g > 130 and b < 125:
        return 'Y'
    if g > 85 and b > 85 and r < 120:
        return 'C'
    if r > 85 and b > 85 and g < 120:
        return 'M'
    if r > g * 1.4 and r > b * 1.4:
        return 'R'
    if g > r * 1.3 and g > b * 1.1:
        return 'G'
    if b > r * 1.3 and b > g * 1.2:
        return 'B'
    return '+'


def capture(name):
    path = dest / (name + '.png')
    sp.run(
        ['ffmpeg', '-nostdin', '-v', 'error',
         '-f', 'x11grab', '-video_size', '1024x768',
         '-i', os.environ['DISPLAY'], '-frames:v', '1', '-y', str(path)],
        stdout=sp.DEVNULL, stderr=sp.PIPE, check=True, timeout=8,
    )
    raw = sp.run(
        ['ffmpeg', '-nostdin', '-v', 'error', '-i', str(path),
         '-vf', 'crop=720:450:160:160,scale=80:32:flags=area,format=rgb24',
         '-frames:v', '1', '-f', 'rawvideo', '-'],
        capture_output=True, check=True, timeout=8,
    ).stdout
    assert len(raw) == 80 * 32 * 3, 'BAD_FRAME'
    lines = []
    for y in range(32):
        chars = []
        for x in range(80):
            pos = (y * 80 + x) * 3
            chars.append(classify_pixel(*raw[pos:pos+3]))
        lines.append(''.join(chars))
    left = sum(lines[y][32] == 'B' for y in range(3, 27))
    right = sum(lines[y][54] == 'B' for y in range(3, 27))
    floor = sum(lines[27][x] == 'B' for x in range(32, 55, 2))
    board = left >= 18 and right >= 18 and floor >= 9
    # In-board red pixels: report location, not an unverified gameplay conclusion.
    red = [(x, y) for y in range(4, 27)
           for x in range(33, 54) if lines[y][x] == 'R']
    stats = ('NONE' if not red else
             f'COUNT={len(red)} CX={sum(x for x,y in red)/len(red):.2f} '
             f'CY={sum(y for x,y in red)/len(red):.2f} '
             f'BOX={min(x for x,y in red)},{min(y for x,y in red)},'
             f'{max(x for x,y in red)},{max(y for x,y in red)}')
    h = hashlib.sha256(path.read_bytes()).hexdigest()
    print(f'FRAME={name} T={time.monotonic()-start:.3f}s '
          f'BORDERS={left}/{right} FLOOR={floor} BOARD={board} '
          f'RED={stats} SHA256={h}', flush=True)
    return {'name': name, 'board': board, 'lines': lines, 'red': red}


def compare(a, b):
    n = sum(a['lines'][y][x] != b['lines'][y][x]
            for y in range(4, 27) for x in range(33, 54))
    print(f'COMPARE={a["name"]}->{b["name"]} INTERIOR_CHANGED={n}/483',
          flush=True)


def ascii_board(frame):
    print('BOARD_ASCII=' + frame['name'], flush=True)
    for y in range(3, 28):
        print(f'{y:02d}|{frame["lines"][y][32:55]}|', flush=True)


proc = None
try:
    with (dest / 'dosbox.log').open('wb') as log:
        proc = sp.Popen(
            args, cwd=game, env=env, stdin=sp.DEVNULL,
            stdout=log, stderr=sp.STDOUT, start_new_session=True,
        )
        time.sleep(2.5)
        if proc.poll() is not None:
            raise RuntimeError('DOSBOX_EXIT_EARLY')
        focus()
        key(ord('7'), 0.12)
        time.sleep(0.45)
        key(0xff0d, 0.12)
        time.sleep(0.4)
        board = None
        for attempt in range(9):
            if proc.poll() is not None:
                break
            current = capture(f'gate_{attempt:02d}')
            if current['board']:
                board = current
                break
            if attempt in (2, 5):
                key(0xff0d, 0.12)
            time.sleep(0.25)
        if board is None:
            print('BOARD_READY=BLOCKED; MOVEMENT_TEST_NOT_RUN', flush=True)
        else:
            print('BOARD_READY=PASS; SINGLE_SESSION_TEST=START', flush=True)
            # Matched no-input control before pressing any movement keys.
            time.sleep(0.12)
            control = capture('control_no_key')
            compare(board, control)
            # Three separate key events, then one screenshot.
            for _ in range(3):
                key(0xff51)
            after_left = capture('after_3_left')
            compare(control, after_left)
            for _ in range(3):
                key(0xff53)
            after_right = capture('after_3_right')
            compare(after_left, after_right)
            for frame in (control, after_left, after_right):
                ascii_board(frame)
            print('XTEST_LEFT3=PASS; XTEST_RIGHT3=PASS; '
                  'HORIZONTAL_MOVEMENT_CAUSALITY=UNKNOWN', flush=True)
finally:
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except sp.TimeoutExpired:
            proc.kill()
            proc.wait()
    x11.XCloseDisplay(display)

print('R10_CAPTURE_FINISHED=TRUE; PRODUCTION_CHANGED=FALSE; '
      'ORIGINAL_WASM_PARITY=UNKNOWN', flush=True)
