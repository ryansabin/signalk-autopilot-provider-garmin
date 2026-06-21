#!/usr/bin/env python3
# Reassemble every 126720 from NON-CCU sources (src != 2) and print each UNIQUE payload that
# contains the Garmin AP container (10 17 04 04), tagged by source + count + first-seen time.
# Run across a mode change to see exactly what the GHC/chartplotter send to engage a mode.
# Usage: cmddump.py [seconds]
import subprocess, re, sys, time, collections
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 45
asm = {}
seen = collections.OrderedDict()   # (src, payloadhex) -> [count, firsttime]
p = subprocess.Popen(['candump', 'can0'], stdout=subprocess.PIPE, text=True)
t0 = time.time()
print('dumping AP-container msgs from non-CCU sources (%.0fs)...' % DUR, flush=True)
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
        if pgn == 126720 and sa != 2:
            d = [int(x, 16) for x in m.group(2).split()]
            seqhi = d[0] & 0xe0; fr = d[0] & 0x1f
            key = (sa, seqhi)
            if fr == 0:
                asm[key] = {'len': d[1], 'b': d[2:]}
            elif key in asm:
                asm[key]['b'] += d[1:]
            a = asm.get(key)
            if a and a['len'] > 0 and len(a['b']) >= a['len']:
                b = a['b'][:a['len']]; del asm[key]
                # only AP-container payloads
                if any(b[i:i+4] == [0x10, 0x17, 0x04, 0x04] for i in range(len(b) - 4)):
                    h = ' '.join('%02X' % x for x in b)
                    k = (sa, h)
                    if k in seen:
                        seen[k][0] += 1
                    else:
                        seen[k] = [1, time.time() - t0]
    if time.time() - t0 > DUR:
        break
p.terminate()
print('=== unique AP-container msgs from non-CCU sources ===', flush=True)
for (sa, h), (cnt, ft) in seen.items():
    print('  src %-3d  t+%4.1fs  x%-4d  %s' % (sa, ft, cnt, h), flush=True)
print('done', flush=True)
