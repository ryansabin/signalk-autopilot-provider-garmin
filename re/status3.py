import sys, collections
sys.path.insert(0,'/tmp')
import apre
def sub_msgs(path, src=2, dst=255, pgn=126720, klen=8):
    msgs=apre.parse(path)
    g=collections.defaultdict(list)
    for t,pr,p,s,d,pl in msgs:
        if p==pgn and s==src and d==dst and len(pl)>=klen:
            key=' '.join(f'{b:02X}' for b in pl[2:klen])
            g[key].append(pl)
    return g
states={'standby':'/tmp/cap_base.log','heading':'/tmp/cap_adj_minus10.log','wind':'/tmp/cap_wind_steady.log'}
g={n:sub_msgs(p) for n,p in states.items()}
subs=set().union(*[set(g[n]) for n in states])
print("Sub-messages of 2->255 126720 keyed on bytes[2:8]:")
for k in sorted(subs):
    print(f"  [{k} ...]  counts:", {n:len(g[n].get(k,[])) for n in states})
print()
for k in sorted(subs):
    pls={n:g[n].get(k,[]) for n in states}
    if not all(pls.values()): continue
    L=min(max(len(p) for p in pls[n]) for n in states)
    rows=[]
    for i in range(L):
        col={}; allc=True
        for n in states:
            vals=set(p[i] for p in pls[n] if i<len(p))
            if len(vals)==1: col[n]=f"{list(vals)[0]:02X}"
            else: col[n]="vv"; allc=False
        if allc and len(set(col.values()))>1:
            rows.append((i,col))
    if rows:
        print(f"=== [{k}] bytes constant-per-state & differing ===")
        for i,col in rows:
            print(f"  b{i:2d} | standby={col['standby']} heading={col['heading']} wind={col['wind']}")
