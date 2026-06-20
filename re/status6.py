import sys, collections
sys.path.insert(0,'/tmp')
import apre
def grabpref(path, pref, src=2,dst=255,pgn=126720):
    out=[]
    for t,pr,p,s,d,pl in apre.parse(path):
        if p==pgn and s==src and d==dst:
            h=' '.join(f'{b:02X}' for b in pl)
            if h.startswith(pref): out.append(h)
    return out
states={'standby':'/tmp/cap_base.log','heading':'/tmp/cap_adj_minus10.log','wind':'/tmp/cap_wind_steady.log'}
for label,pref in [('6C0702 status-summary','E5 98 6C 07 02 02'),('00 0B wind-only field','E5 98 10 17 04 04 00 0B')]:
    print(f"\n========= {label}  (prefix {pref}) =========")
    for n,p in states.items():
        ds=collections.Counter(grabpref(p,pref))
        print(f" --{n}--")
        for h,c in ds.most_common(6):
            print(f"   x{c:<3} {h}")
