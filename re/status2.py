import sys, collections
sys.path.insert(0,'/tmp')
import apre

def sub_msgs(path, src=2, dst=255, pgn=126720):
    msgs=apre.parse(path)
    g=collections.defaultdict(list)
    for t,pr,p,s,d,pl in msgs:
        if p==pgn and s==src and d==dst and len(pl)>=6:
            key=' '.join(f'{b:02X}' for b in pl[2:6])  # type selector after E5 98
            g[key].append(pl)
    return g

states={'standby':'/tmp/cap_base.log','heading':'/tmp/cap_adj_minus10.log','wind':'/tmp/cap_wind_steady.log'}
g={n:sub_msgs(p) for n,p in states.items()}
# subtypes present across all states
subs=set(g['standby'])|set(g['heading'])|set(g['wind'])
print("Subtypes of 2->255 126720 (E5 98 <sel..>):")
for k in sorted(subs):
    print(f"  sel[{k}]  counts:", {n:len(g[n].get(k,[])) for n in states})
print()
for k in sorted(subs):
    pls_all={n:g[n].get(k,[]) for n in states}
    if not all(pls_all.values()): continue
    L=min(max(len(p) for p in pls_all[n]) for n in states)
    diffrows=[]
    for i in range(L):
        col={}; allconst=True
        for n in states:
            vals=set(p[i] for p in pls_all[n] if i<len(p))
            if len(vals)==1: col[n]=f"{list(vals)[0]:02X}"
            else: col[n]="vv"; allconst=False
        if allconst and len(set(col.values()))>1:
            diffrows.append((i,col))
    if diffrows:
        print(f"=== sel[{k}] : bytes constant-per-state and differing ===")
        for i,col in diffrows:
            print(f"  b{i:2d} | standby={col['standby']} heading={col['heading']} wind={col['wind']}")
