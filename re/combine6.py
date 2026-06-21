#!/usr/bin/env python3
# 6-way compare. Columns: standby, heading, wind (no route loaded), route (no route-loaded
# baseline), rf2 (route-follow, route loaded), wr (wind hold, route still loaded).
# The rf2-vs-wr pair is the controlled one: both have a route loaded, only the AP mode differs.
import re
modes = ['standby', 'heading', 'wind', 'route', 'rf2', 'wr']
data = {m: {} for m in modes}
for m in modes:
    try:
        for line in open('/tmp/m_%s.txt' % m):
            mm = re.match(r'([0-9A-F]{2}) ([0-9A-F]{2})\s+x(\d+)\s+(.*)', line.strip())
            if mm:
                data[m][(mm.group(1), mm.group(2))] = mm.group(4).strip()
    except FileNotFoundError:
        print('missing', m)
allfids = sorted(set().union(*[set(data[m]) for m in modes]))
hdr = 'FID  | ' + ' | '.join('%-14s' % m for m in modes)
print(hdr); print('-' * len(hdr))
for fid in allfids:
    cells = [('%-14s' % data[m].get(fid, '-')) for m in modes]
    # flag rows where rf2 and wr differ in presence (the controlled pair)
    rf2p = fid in data['rf2']; wrp = fid in data['wr']
    flag = '  <-- rf2/wr presence' if rf2p != wrp else ''
    print('%s %s| %s%s' % (fid[0], fid[1], ' | '.join(cells), flag))
