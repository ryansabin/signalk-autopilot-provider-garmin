#!/usr/bin/env python3
# When a tack/gybe selector (10 17 04 04 04 A2 00 <dir>) appears on the bus, print its direction
# byte alongside the current apparent wind side (from PGN 130306). Run while the helm gybes back
# and forth to nail the dir<->wind-side mapping. Usage: maneuverwind.py [seconds]
import subprocess, re, sys, time, math
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 50
asm = {}
lastwind = None
p = subprocess.Popen(['candump', 'can0'], stdout=subprocess.PIPE, text=True)
t0 = time.time()
print('watching for tack/gybe selectors + wind side (%.0fs)...' % DUR, flush=True)
while True:
    line = p.stdout.readline()
    if not line:
        break
    m = re.search(r'\s([0-9A-Fa-f]{8})\s+\[\d\]\s+([0-9A-Fa-f ]+)', line)
    if m:
        cid = int(m.group(1), 16)
        sa = cid & 0xff
        pf = (cid >> 16) & 0xff; ps = (cid >> 8) & 0xff; dp = (cid >> 24) & 1
        pgn = ((dp << 16) | (pf << 8)) if pf < 240 else ((dp << 16) | (pf << 8) | ps)
        d = [int(x, 16) for x in m.group(2).split()]
        if pgn == 130306 and len(d) >= 6 and (d[5] & 0x07) == 2:
            a = (d[3] | (d[4] << 8)) * 1e-4
            if a > math.pi:
                a -= 2 * math.pi
            if -math.pi <= a <= math.pi:
                lastwind = a
            continue
        if pgn == 126720:
            seqhi = d[0] & 0xe0; fr = d[0] & 0x1f
            key = (sa, seqhi)
            if fr == 0:
                asm[key] = {'len': d[1], 'b': d[2:]}
            elif key in asm:
                asm[key]['b'] += d[1:]
            a = asm.get(key)
            if a and a['len'] > 0 and len(a['b']) >= a['len']:
                b = a['b'][:a['len']]; del asm[key]
                for i in range(len(b) - 7):
                    if b[i:i+7] == [0x10, 0x17, 0x04, 0x04, 0x04, 0xA2, 0x00]:
                        dirb = b[i+7]
                        if lastwind is None:
                            ws = 'wind=?'
                        else:
                            deg = lastwind * 57.2958
                            ws = 'apparentWind=%+.0f deg (%s)' % (deg, 'STBD' if lastwind > 0 else 'PORT')
                        print('  %s  src %-3d  selector dir=%02X   %s' % (time.strftime('%H:%M:%S'), sa, dirb, ws), flush=True)
                        break
    if time.time() - t0 > DUR:
        break
p.terminate()
print('done', flush=True)
