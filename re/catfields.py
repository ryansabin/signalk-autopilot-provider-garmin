#!/usr/bin/env python3
# Catalog every 126720 field-id (the 2 bytes after container 10 17 04 04) the
# CCU (src 02) broadcasts, with hit counts and a sample of following bytes.
# Usage: catfields.py [seconds]
import subprocess, re, sys, time, collections
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 8
asm = {}
hits = collections.Counter()
sample = {}
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
                    if fid not in sample:
                        sample[fid] = ' '.join('%02X' % x for x in b[i:i+12])
                i += 1
    if time.time() - t0 > DUR:
        break
p.terminate()
print('captured %.1fs' % (time.time() - t0))
for fid, n in sorted(hits.items(), key=lambda kv: -kv[1]):
    print('  %02X %02X  x%-5d  %s' % (fid[0], fid[1], n, sample[fid]))
