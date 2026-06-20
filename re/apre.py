import sys, re, collections

PROP = lambda pgn: pgn==126720 or pgn==126208 or 65240<=pgn<=65535 or pgn in (127245,130850,130851)

def decid(c):
    c=int(c,16); sa=c&0xff; ps=(c>>8)&0xff; pf=(c>>16)&0xff; dp=(c>>24)&1; prio=(c>>26)&7
    if pf<240: return prio,(dp<<16)|(pf<<8),sa,ps
    return prio,(dp<<16)|(pf<<8)|ps,sa,255

FAST=set([126720,126208,126996,130850,130851])

def parse(path):
    asm={}
    msgs=[]
    for line in open(path):
        m=re.search(r'\(([0-9.]+)\)\s+can0\s+([0-9A-Fa-f]{8})\s+\[(\d+)\]\s+(.+)$',line)
        if not m: continue
        ts=float(m.group(1)); prio,pgn,src,dst=decid(m.group(2))
        data=[int(x,16) for x in m.group(4).split()]
        if pgn in FAST:
            seqhi=data[0]&0xE0; frame=data[0]&0x1F; key=(src,pgn,seqhi)
            if frame==0:
                asm[key]=[data[1],bytearray(data[2:]),ts,prio,dst]
            else:
                if key in asm: asm[key][1]+=bytes(data[1:])
            if key in asm and len(asm[key][1])>=asm[key][0]>0:
                tot,buf,t0,pr,ds=asm[key]
                msgs.append((t0,pr,pgn,src,ds,bytes(buf[:tot]))); del asm[key]
        else:
            msgs.append((ts,prio,pgn,src,dst,bytes(data)))
    return msgs

def catalog(path, only_prop=True):
    msgs=parse(path)
    groups=collections.defaultdict(list)
    for t,pr,pgn,src,dst,pl in msgs:
        if only_prop and not PROP(pgn): continue
        groups[(src,dst,pgn)].append(pl)
    print("SRC->DST  PGN     #     payload (.. = varying byte)")
    for (src,dst,pgn),pls in sorted(groups.items()):
        L=max(len(p) for p in pls)
        varies=[False]*L
        for i in range(L):
            vals=set(p[i] for p in pls if i<len(p))
            if len(vals)>1: varies[i]=True
        sample=pls[-1]
        masked=' '.join('..' if (i<len(sample) and varies[i]) else f'{sample[i]:02X}' for i in range(len(sample)))
        print(f"{src:3d}->{dst:<3d}  {pgn:<7} {len(pls):>4}  [{sum(varies)}v] {masked}")

def diff(base, test):
    bmsgs=parse(base); tmsgs=parse(test)
    stable={}
    bydst=collections.defaultdict(list)
    for t,pr,pgn,src,dst,pl in bmsgs:
        if not PROP(pgn): continue
        bydst[(src,dst,pgn)].append(pl)
    for k,pls in bydst.items():
        L=max(len(p) for p in pls)
        st={}
        for i in range(L):
            vals=set(p[i] for p in pls if i<len(p))
            if len(vals)==1: st[i]=vals.pop()
        stable[k]=st
    print("NOVEL vs baseline:")
    seen=set()
    for t,pr,pgn,src,dst,pl in tmsgs:
        if not PROP(pgn): continue
        k=(src,dst,pgn); st=stable.get(k)
        if st is None:
            tag="NEWKEY"
        else:
            diffs=[i for i,v in st.items() if i<len(pl) and pl[i]!=v]
            if not diffs: continue
            tag="b"+",".join(str(i) for i in diffs)
        hexs=' '.join(f'{b:02X}' for b in pl)
        sig=(k,hexs)
        if sig in seen: continue
        seen.add(sig)
        print(f"  t={t:.3f} {src}->{dst} pgn{pgn} [{tag}] {hexs}")

if __name__=='__main__':
    if sys.argv[1]=='catalog': catalog(sys.argv[2])
    elif sys.argv[1]=='diff': diff(sys.argv[2],sys.argv[3])
