import re,sys
log=sys.argv[1]
asm={}; rows=[]
for ln in open(log):
    m=re.search(r'\(([\d.]+)\)\s+\w+\s+1[0-9A-Fa-f]EF02([0-9A-Fa-f]{2})\s+\[\d\]\s+([0-9A-Fa-f ]+)',ln)
    if not m: continue
    ts=float(m.group(1)); src=m.group(2).lower(); data=[int(x,16) for x in m.group(3).split()]
    seqhi=data[0]&0xe0; frame=data[0]&0x1f; key=src+':'+str(seqhi)
    if frame==0: asm[key]={'len':data[1],'b':data[2:]}
    elif key in asm: asm[key]['b']+=data[1:]
    a=asm.get(key)
    if a and a['len']>0 and len(a['b'])>=a['len']:
        b=a['b'][:a['len']]; del asm[key]
        for i in range(len(b)-3):
            if b[i]==0x10 and b[i+1]==0x17 and b[i+2]==0x04 and b[i+3]==0x04:
                rows.append((ts,src,' '.join('%02X'%x for x in b[i+4:i+12]))); break
prev=None
for ts,src,sub in rows:
    if sub.startswith('15 03'): continue
    if (src,sub)!=prev: print("%8.2f  src=%s  %s"%(ts,src,sub)); prev=(src,sub)
