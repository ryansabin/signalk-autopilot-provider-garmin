import sys, collections
sys.path.insert(0,'/tmp')
import apre

def fields(path, src=2, dst=255, pgn=126720):
    msgs = apre.parse(path)
    pls = [pl for t,pr,p,s,d,pl in msgs if p==pgn and s==src and d==dst]
    out={}
    if not pls: return out,0
    L=max(len(p) for p in pls)
    for i in range(L):
        out[i]=collections.Counter(p[i] for p in pls if i<len(p))
    return out,len(pls)

states={'standby':'/tmp/cap_base.log','heading':'/tmp/cap_adj_minus10.log','wind':'/tmp/cap_wind_steady.log'}
data={}; counts={}
for n,p in states.items():
    data[n],counts[n]=fields(p)
print("CCU status stream 2->255 pgn126720  | frames:",{n:counts[n] for n in states})
L=max(max(v.keys()) for v in data.values() if v)+1
print(f"payload len ~{L} bytes")
print("\npos | standby heading  wind   (showing only bytes that are CONSTANT-per-state and DIFFER across states)")
for i in range(L):
    col={}; allconst=True
    for n in states:
        c=data[n].get(i,collections.Counter())
        if len(c)==1: col[n]=f"{list(c)[0]:02X}"
        else: col[n]="vv"; allconst=False
    if allconst and len(set(col.values()))>1:
        print(f"b{i:2d} |   {col['standby']}      {col['heading']}      {col['wind']}")
