#!/usr/bin/env python3
# Inventory EVERY PGN emitted by a given source address (default CCU = 2), with hit counts
# and a sample first-frame payload. For low-rate / small PGNs this exposes candidate mode
# fields outside 126720. Usage: pgnsrc.py <label> [seconds] [srcaddr]
import subprocess, re, sys, time, collections
label = sys.argv[1] if len(sys.argv) > 1 else 'cap'
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 10
SRC = int(sys.argv[3]) if len(sys.argv) > 3 else 2
hits = collections.Counter()
sample = {}
p = subprocess.Popen(['candump', 'can0'], stdout=subprocess.PIPE, text=True)
t0 = time.time()
for line in p.stdout:
    m = re.search(r'\s([0-9A-Fa-f]{8})\s+\[\d\]\s+([0-9A-Fa-f ]+)', line)
    if m:
        cid = int(m.group(1), 16)
        sa = cid & 0xff
        if sa != SRC:
            continue
        dp = (cid >> 24) & 1
        pf = (cid >> 16) & 0xff
        ps = (cid >> 8) & 0xff
        pgn = ((dp << 16) | (pf << 8)) if pf < 240 else ((dp << 16) | (pf << 8) | ps)
        hits[pgn] += 1
        if pgn not in sample:
            sample[pgn] = m.group(2).strip()
    if time.time() - t0 > DUR:
        break
p.terminate()
print('=== %s  src=%d  (%.0fs) ===' % (label, SRC, time.time() - t0))
for pgn, n in sorted(hits.items(), key=lambda kv: -kv[1]):
    print('  %-6d (0x%05X)  x%-5d  %s' % (pgn, pgn, n, sample[pgn]))
