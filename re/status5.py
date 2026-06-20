import sys, collections
sys.path.insert(0,'/tmp')
import apre
def sub(path, src=2,dst=255,pgn=126720):
    g=collections.defaultdict(list)
    for t,pr,p,s,d,pl in apre.parse(path):
        if p==pgn and s==src and d==dst and len(pl)>=8:
            g[' '.join(f'{b:02X}' for b in pl[2:8])].append(bytes(pl))
    return g
states={'standby':'/tmp/cap_base.log','heading':'/tmp/cap_adj_minus10.log','wind':'/tmp/cap_wind_steady.log'}
g={n:sub(p) for n,p in states.items()}
subs=set().union(*[set(g[n]) for n in states])
want={'standby':0x02,'heading':0x05,'wind':0x11}
print("Hunting byte that reads standby=02 heading=05 wind=11 ...")
hits=[]
for k in sorted(subs):
    pls={n:g[n].get(k,[]) for n in states}
    if not all(pls.values()): continue
    L=min(min(len(p) for p in pls[n]) for n in states)
    for i in range(L):
        modal={n:collections.Counter(p[i] for p in pls[n]).most_common(1)[0][0] for n in states}
        if modal==want:
            print(f"  *** EXACT 02/05/11 MATCH: subtype[{k}] byte b{i}")
            hits.append((k,i))
# also: any position where all three modal values distinct
print("\nAll positions with 3 distinct modal values (subtype, byte: standby/heading/wind):")
for k in sorted(subs):
    pls={n:g[n].get(k,[]) for n in states}
    if not all(pls.values()): continue
    L=min(min(len(p) for p in pls[n]) for n in states)
    for i in range(L):
        modal={n:collections.Counter(p[i] for p in pls[n]).most_common(1)[0][0] for n in states}
        vals=[modal['standby'],modal['heading'],modal['wind']]
        if len(set(vals))==3 and max(vals)<0x40:
            print(f"  [{k}] b{i}: {vals[0]:02X}/{vals[1]:02X}/{vals[2]:02X}")
