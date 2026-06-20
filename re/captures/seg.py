import sys, collections, struct
sys.path.insert(0,'/tmp')
import apre

def segment(path):
    msgs = apre.parse(path)
    # state-change commands from heads (4,5) -> CCU(2): 10 17 04 04 05 0A 00 <code>
    NAME={0x02:'STANDBY',0x05:'HEADING',0x11:'WIND'}
    cmds=[]
    for t,pr,p,s,d,pl in msgs:
        if p==126720 and d==2 and s in (4,5) and len(pl)>=10 \
           and bytes(pl[2:8])==bytes([0x10,0x17,0x04,0x04,0x05,0x0A]):
            cmds.append((t, pl[9]))
    cmds.sort()
    # build segments: (start, end, modecode)
    segs=[]
    if cmds:
        t0=msgs[0][0]
        segs.append((t0, cmds[0][0], None))           # initial (unknown/standby)
        for i,(t,c) in enumerate(cmds):
            end = cmds[i+1][0] if i+1<len(cmds) else msgs[-1][0]
            segs.append((t, end, c))
    else:
        segs=[(msgs[0][0], msgs[-1][0], None)]
    print("Detected state commands (ts, mode):")
    for t,c in cmds: print(f"   t={t:.2f}  {NAME.get(c,hex(c))}")
    print()
    # per-segment CCU status analysis
    for (a,b,c) in segs:
        ccu=[pl for t,pr,p,s,d,pl in msgs if p==126720 and s==2 and d==255 and a<=t<b]
        if not ccu: continue
        fields=collections.Counter()
        windvals=[]; summ2=[]
        for pl in ccu:
            if len(pl)>=8 and bytes(pl[2:6])==bytes([0x10,0x17,0x04,0x04]):
                fid=f"{pl[6]:02X} {pl[7]:02X}"
                fields[fid]+=1
                if pl[6]==0x00 and pl[7]==0x0B and len(pl)>=13:
                    windvals.append(struct.unpack('<f',bytes(pl[9:13]))[0])
            if len(pl)>=17 and bytes(pl[2:8])==bytes([0x6C,0x07,0x02,0x02,0x01,0x00]):
                summ2.append(struct.unpack('<f',bytes(pl[13:17]))[0])
        label = NAME.get(c,'(initial)') if c is not None else '(initial/standby)'
        dur=b-a
        print(f"===== {label}  [{dur:.0f}s, {len(ccu)} CCU frames] =====")
        wind_fid = fields.get('00 0B',0)
        print(f"  wind-field 00 0B present: {wind_fid}x" + (f"  angle~{sum(windvals)/len(windvals):.3f} rad ({sum(windvals)/len(windvals)*57.3:.0f} deg)" if windvals else ""))
        if summ2:
            print(f"  6C0702 summary float2: {min(summ2):.1f}..{max(summ2):.1f}")
        only=[k for k,v in fields.items() if v>=3]
        print(f"  field-ids present (>=3x): {', '.join(sorted(only))}")

if __name__=='__main__':
    segment(sys.argv[1])
