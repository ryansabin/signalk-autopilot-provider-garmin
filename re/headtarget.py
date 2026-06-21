#!/usr/bin/env python3
# Heading-hold target hunt. Prints the ACTUAL heading (PGN 127250) plus every CCU (src 2) 126720
# float field whose value is a plausible angle (0..360 deg), once/sec. Change the desired heading
# on the head unit by a known amount: the TARGET field jumps to the new desired immediately while
# the actual heading follows gradually. Usage: headtarget.py [seconds]
import subprocess, re, sys, time, struct
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 30
asm = {}
fields = {}        # (hi,lo) -> deg
heading = None
def fl(b, off):
    try:
        return struct.unpack('<f', bytes(b[off:off+4]))[0]
    except Exception:
        return None
p = subprocess.Popen(['candump', 'can0'], stdout=subprocess.PIPE, text=True)
t0 = time.time(); tp = t0
print('actual heading + CCU angle fields once/sec — change desired heading on the head unit (%.0fs)' % DUR, flush=True)
while True:
    line = p.stdout.readline()
    if not line:
        break
    m = re.search(r'\s([0-9A-Fa-f]{8})\s+\[\d\]\s+([0-9A-Fa-f ]+)', line)
    if not m:
        continue
    cid = int(m.group(1), 16); sa = cid & 0xff
    pf = (cid >> 16) & 0xff; ps = (cid >> 8) & 0xff; dp = (cid >> 24) & 1
    pgn = ((dp << 16) | (pf << 8)) if pf < 240 else ((dp << 16) | (pf << 8) | ps)
    d = [int(x, 16) for x in m.group(2).split()]
    if pgn == 127250 and sa == 2 and len(d) >= 3:
        h = (d[1] | (d[2] << 8)) * 1e-4
        if 0 <= h < 7:
            heading = h * 57.2958
    elif pgn == 126720 and sa == 2:
        seqhi = d[0] & 0xe0; fr = d[0] & 0x1f
        if fr == 0:
            asm[seqhi] = {'len': d[1], 'b': d[2:]}
        elif seqhi in asm:
            asm[seqhi]['b'] += d[1:]
        a = asm.get(seqhi)
        if a and a['len'] > 0 and len(a['b']) >= a['len']:
            b = a['b'][:a['len']]; del asm[seqhi]
            i = 0
            while i < len(b) - 11:
                if b[i] == 0x10 and b[i+1] == 0x17 and b[i+2] == 0x04 and b[i+3] == 0x04:
                    fid = (b[i+4], b[i+5]); typ = b[i+6]
                    if typ in (0x00, 0x04, 0x0C, 0x17):
                        f = fl(b, i+7)
                        if f is not None and 0 <= f < 6.3:          # plausible angle in radians
                            fields[fid] = f * 57.2958
                i += 1
    now = time.time()
    if now - tp >= 1:
        tp = now
        parts = ['%02X%02X=%3.0f' % (k[0], k[1], v) for k, v in sorted(fields.items())]
        print('  t+%4.0fs  HDG=%s   %s' % (now-t0, ('%3.0f' % heading) if heading is not None else '--', '  '.join(parts)), flush=True)
        fields = {}
    if now - t0 > DUR:
        break
p.terminate()
print('done', flush=True)
