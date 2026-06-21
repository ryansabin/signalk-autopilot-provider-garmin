import re
asm={}; rows=[]
for ln in open('/tmp/seq_cap.log'):
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
                rows.append((ts,src,b[i+4:i+12])); break
last=None
for ts,src,t in rows:
    if src!='05': continue
    hd=(t[0],t[1])
    # pattern params: 05 33 (time), 05 20 (period), 00 1F (amplitude float)
    if hd in [(0x05,0x33),(0x05,0x20),(0x00,0x1F)]:
        sig=' '.join('%02X'%x for x in t)
        if sig!=last: print("%7.2f  %s"%(ts,sig)); last=sig
