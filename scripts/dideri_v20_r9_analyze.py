#!/usr/bin/env python3
"""DiDeRi V20 R9: offline read-only comparison of existing R6/R8 captures."""
import hashlib
import os
import pathlib
import subprocess

ROOT = pathlib.Path.home() / '.local/state/ai-tool-fabric/app-execution'
R6 = ROOT / 'dideri-v20-r6-ff8fq_5h'
R8 = ROOT / 'dideri-v20-r8-ock8e67m'
FRAMES = {
    'R6_CONTROL_PRE': R6 / 'control_pre.png',
    'R6_CONTROL_POST': R6 / 'control_post.png',
    'R6_LEFT_PRE': R6 / 'left_pre.png',
    'R6_LEFT_POST': R6 / 'left_post.png',
    'R8_TITLE': R8 / '00_title.png',
    'R8_AFTER7': R8 / '01_after7.png',
    'R8_BOARD_PRE': R8 / '02_check_0.png',
    'R8_AFTER_LEFT': R8 / '03_after_left.png',
}
EXPECTED = {
    'R8_BOARD_PRE': 'fd26889b2dfd2a47d36503a5c36042dbeb7ffd78a67a39e7ec7d42863d8ed2af',
    'R8_AFTER_LEFT': '705e667e58dec365728389545b086e50c8dfa8449af7f8a3471c712a5b9e2c1d',
}


def symbol(r, g, b):
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


def decode(path):
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 1000000:
        raise RuntimeError('MISSING_OR_UNSAFE_CAPTURE: ' + str(path))
    result = subprocess.run(
        ['ffmpeg', '-nostdin', '-v', 'error', '-i', str(path),
         '-vf', 'crop=720:450:160:160,scale=80:32:flags=area,format=rgb24',
         '-frames:v', '1', '-f', 'rawvideo', '-'],
        check=True, capture_output=True, timeout=15,
    )
    rgb = result.stdout
    if len(rgb) != 80 * 32 * 3:
        raise RuntimeError('BAD_RGB_LENGTH: ' + str(path))
    rows = []
    for y in range(32):
        row = []
        for x in range(80):
            i = (y * 80 + x) * 3
            row.append(symbol(*rgb[i:i + 3]))
        rows.append(''.join(row))
    return rows, hashlib.sha256(path.read_bytes()).hexdigest()


def signature(rows):
    left = sum(rows[y][32] == 'B' for y in range(3, 27))
    right = sum(rows[y][54] == 'B' for y in range(3, 27))
    floor = sum(rows[27][x] == 'B' for x in range(32, 55, 2))
    return left, right, floor


def compare(a, b):
    different = sum(a[y][x] != b[y][x]
                    for y in range(4, 27) for x in range(33, 54))
    changed_rows = [y for y in range(4, 27)
                    if a[y][33:54] != b[y][33:54]]
    return different, changed_rows


def main():
    if os.uname().nodename.split('.')[0] != 'aether-engine' or os.getuid() != 1024:
        raise RuntimeError('OWNER_SCOPE')
    print('DIDERI_V20_R9_EXISTING_SCREENSHOT_AUDIT')
    images = {}
    for name, path in FRAMES.items():
        rows, sha = decode(path)
        if name in EXPECTED and sha != EXPECTED[name]:
            raise RuntimeError('CAPTURE_HASH_MISMATCH: ' + name)
        images[name] = rows
        left, right, floor = signature(rows)
        # Border signature is inferred from R6 captured frames; calibration only.
        board_candidate = left >= 17 and right >= 17
        print(f'{name}: BORDER_LEFT={left}/24 BORDER_RIGHT={right}/24 '
              f'FLOOR={floor}/12 BOARD_CANDIDATE={board_candidate} SHA256={sha}', flush=True)
    for a, b in [('R6_CONTROL_PRE', 'R6_CONTROL_POST'),
                 ('R6_LEFT_PRE', 'R6_LEFT_POST'),
                 ('R8_BOARD_PRE', 'R8_AFTER_LEFT')]:
        n, rows = compare(images[a], images[b])
        print(f'COMPARE {a}->{b}: BOARD_INTERIOR_CHANGED_CELLS={n}/483 '
              f'CHANGED_ROWS={rows}', flush=True)
    for name in ('R8_BOARD_PRE', 'R8_AFTER_LEFT'):
        print(f'=== {name} ===', flush=True)
        for line in images[name]:
            print(line, flush=True)
    print('R9_READ_ONLY=PASS; CONTROLLED_HORIZONTAL_MOVE=UNKNOWN; '
          'ORIGINAL_WASM_PARITY=UNKNOWN; PRODUCTION_CHANGED=FALSE', flush=True)


if __name__ == '__main__':
    main()
