#!/usr/bin/env python3
# Decode the CCU (src 2) 126720 field 00 0B as a float and print it (deg) once/sec, so we can
# see whether it is the STEADY desired/target wind angle (steps when you adjust on the head unit)
# or the fluctuating measured wind. Also tracks heading field 00 9F the same way for reference.
# Usage: windtarget.py [seconds]
import subprocess, re, sys, time, struct
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 25
asm = {}
last = {}
def fl(b, off):
    try:
        return struct.unpack('<f', bytes(b[off:off+4]))[0]
    except Exception:
        return None
p = subprocess.Popen(['candump', 'can0'], stdout=subprocess.PIPE, text=True)
t0 = time.time(); tp = t0
print('watching CCU 00 0B (deg) once/sec — adjust desired wind on the head unit (%.0fs)' % DUR, flush=True)
while True:
    line = p.stdout.readline()
    if not line:
        break
    m = re.search(r'1[0-9A-Fa-f]EFFF02\s+\[\d\]\s+([0-9A-Fa-f ]+)', line)
    if m:
        d = [int(x, 16) for x in m.group(1).split()]
        seqhi = d[0] & 0xe0; fr = d[0] & 0x1f
        if fr == 0:
            asm[seqhi] = {'len': d[1], 'b': d[2:]}
        elif seqhi in asm:
            asm[seqhi]['b'] += d[1:]
        a = asm.get(seqhi)
        if a and a['len'] > 0 and len(a['b']) >= a['len']:
            b = a['b'][:a['len']]; del asm[seqhi]
            i = 0
            while i < len(b) - 10:
                if b[i] == 0x10 and b[i+1] == 0x17 and b[i+2] == 0x04 and b[i+3] == 0x04:
                    fid = (b[i+4], b[i+5])
                    if fid in [(0x00, 0x0B), (0x00, 0x9F)]:
                        f = fl(b, i+7)
                        if f is not None and abs(f) < 7:
                            last[fid] = f
                i += 1
    now = time.time()
    if now - tp >= 1:
        tp = now
        wb = last.get((0x00, 0x0B))
        hb = last.get((0x00, 0x9F))
        ws = '%+.1f deg' % (wb*57.2958) if wb is not None else '--'
        hs = '%+.1f' % (hb*57.2958) if hb is not None else '--'
        print('  t+%4.0fs   00 0B = %-12s   00 9F = %s' % (now-t0, ws, hs), flush=True)
    if now - t0 > DUR:
        break
p.terminate()
print('done', flush=True)
