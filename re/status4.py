import sys, collections
sys.path.insert(0,'/tmp')
import apre
def grab(path, key6, src=2, dst=255, pgn=126720):
    msgs=apre.parse(path); out=[]
    for t,pr,p,s,d,pl in msgs:
        if p==pgn and s==src and d==dst and len(pl)>=8:
            if ' '.join(f'{b:02X}' for b in pl[2:8])==key6: out.append(bytes(pl))
    return out
states={'standby':'/tmp/cap_base.log','heading':'/tmp/cap_adj_minus10.log','wind':'/tmp/cap_wind_steady.log'}
for key6 in ['10 17 04 04 0E 04','10 17 04 04 0A 04','10 17 04 04 0E 02','10 17 04 04 11 02','10 17 04 04 11 03','10 17 04 04 0B 04']:
    print(f"\n############ subtype [{key6}] -- modal payload per state ############")
    modal={}
    for n,p in states.items():
        pls=grab(p,key6)
        if not pls: print(f"  {n:8s}: (none)"); continue
        c=collections.Counter(pls); pl=c.most_common(1)[0][0]
        modal[n]=pl
        print(f"  {n:8s}[{len(pls):3d}]: "+' '.join(f'{b:02X}' for b in pl))
    if len(modal)==3:
        L=min(len(v) for v in modal.values())
        diff=[i for i in range(L) if len({modal[n][i] for n in modal})>1]
        print("  DIFFERING byte positions:", diff)
