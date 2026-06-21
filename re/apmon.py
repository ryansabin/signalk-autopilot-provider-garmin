import subprocess,re,time,sys
markers={(0x00,0xA2),(0x02,0x74),(0x00,0x72)}
windf=(0x00,0x0B)
asm={}; last_eng=0; last_wind=0
DUR=float(sys.argv[1]) if len(sys.argv)>1 else 8
p=subprocess.Popen(['candump','can0'],stdout=subprocess.PIPE,text=True)
t0=time.time(); tp=t0
for line in p.stdout:
    now=time.time()
    m=re.search(r'1[0-9A-Fa-f]EFFF02\s+\[\d\]\s+([0-9A-Fa-f ]+)',line)
    if m:
        d=[int(x,16) for x in m.group(1).split()]
        seqhi=d[0]&0xe0; fr=d[0]&0x1f
        if fr==0: asm[seqhi]={'len':d[1],'b':d[2:]}
        elif seqhi in asm: asm[seqhi]['b']+=d[1:]
        a=asm.get(seqhi)
        if a and a['len']>0 and len(a['b'])>=a['len']:
            b=a['b'][:a['len']]; del asm[seqhi]
            for i in range(len(b)-5):
                if b[i]==0x10 and b[i+1]==0x17 and b[i+2]==0x04 and b[i+3]==0x04:
                    fid=(b[i+4],b[i+5])
                    if fid in markers: last_eng=now
                    if fid==windf: last_wind=now
                    break
    if now-tp>=1:
        tp=now
        eng=(last_eng and now-last_eng<1.3); wind=(last_wind and now-last_wind<1.3)
        st='WIND-HOLD' if (eng and wind) else ('ENGAGED' if eng else 'STANDBY')
        print("  %4.0fs  %-10s"%(now-t0,st),flush=True)
    if now-t0>DUR: break
p.terminate()
