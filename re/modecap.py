#!/usr/bin/env python3
# Capture the CCU (src 02) 126720 property table for a fixed window and print, per
# property-id (the 2 bytes after container 10 17 04 04), the hit count and the LAST
# value bytes (type + up to 8 data bytes). Output is sorted by property-id so two
# captures from different modes line up for a clean `diff`.
# Usage: modecap.py <label> [seconds]
import subprocess, re, sys, time, collections
label = sys.argv[1] if len(sys.argv) > 1 else 'cap'
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 10
asm = {}
hits = collections.Counter()
last = {}
p = subprocess.Popen(['candump', 'can0'], stdout=subprocess.PIPE, text=True)
t0 = time.time()
for line in p.stdout:
    m = re.search(r'1[0-9A-Fa-f]EFFF02\s+\[\d\]\s+([0-9A-Fa-f ]+)', line)
    if m:
        d = [int(x, 16) for x in m.group(1).split()]
        seqhi = d[0] & 0xe0
        fr = d[0] & 0x1f
        if fr == 0:
            asm[seqhi] = {'len': d[1], 'b': d[2:]}
        elif seqhi in asm:
            asm[seqhi]['b'] += d[1:]
        a = asm.get(seqhi)
        if a and a['len'] > 0 and len(a['b']) >= a['len']:
            b = a['b'][:a['len']]
            del asm[seqhi]
            i = 0
            while i < len(b) - 5:
                if b[i] == 0x10 and b[i+1] == 0x17 and b[i+2] == 0x04 and b[i+3] == 0x04:
                    fid = (b[i+4], b[i+5])
                    hits[fid] += 1
                    last[fid] = ' '.join('%02X' % x for x in b[i+6:i+14])
                i += 1
    if time.time() - t0 > DUR:
        break
p.terminate()
print('=== %s  (%.0fs) ===' % (label, time.time() - t0))
for fid in sorted(last.keys()):
    print('%02X %02X  x%-4d  %s' % (fid[0], fid[1], hits[fid], last[fid]))
