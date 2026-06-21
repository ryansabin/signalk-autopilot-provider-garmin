import sys,struct,collections,statistics
sys.path.insert(0,'/tmp'); import apre
def fields(path):
  g=collections.defaultdict(list)   # (src,fhi,flo) -> payloads
  for t,pr,p,s,d,pl in apre.parse(path):
    if p==126720 and d==255 and len(pl)>=8 and bytes(pl[2:6])==bytes([16,23,4,4]):
      g[(s,pl[6],pl[7])].append(bytes(pl))
  return g
P=fields('/tmp/rud_port.log'); S=fields('/tmp/rud_stbd.log')
res=[]
for k in set(P)&set(S):
  pp=P[k]; ss=S[k]
  if len(pp)<4 or len(ss)<4: continue
  L=min(min(len(x) for x in pp),min(len(x) for x in ss))
  for off in range(8,L):
    for nm,rd,w in [('s16',lambda x,o: struct.unpack('<h',x[o:o+2])[0] if o+2<=len(x) else None,2),
                    ('u16',lambda x,o: struct.unpack('<H',x[o:o+2])[0] if o+2<=len(x) else None,2),
                    ('f32',lambda x,o: struct.unpack('<f',x[o:o+4])[0] if o+4<=len(x) else None,4)]:
      vp=[rd(x,off) for x in pp]; vs=[rd(x,off) for x in ss]
      if None in vp or None in vs: continue
      if nm=='f32':
        vp=[v for v in vp if abs(v)<1e6]; vs=[v for v in vs if abs(v)<1e6]
        if not vp or not vs: continue
      mp=statistics.median(vp); ms=statistics.median(vs)
      sp=max(vp)-min(vp); ssp=max(vs)-min(vs)
      diff=abs(mp-ms)
      sc=diff/(max(sp,ssp,1e-9)+1e-9)
      if sc>3 and diff>(0.05 if nm=='f32' else 8):
        res.append((sc,nm,k,off,mp,ms,round(sp,3),round(ssp,3)))
res.sort(reverse=True)
print('candidates differing PORT vs STBD across all 126720 srcs (top by stability*diff):')
for r in res[:18]:
  print('  src%d fid %02X %02X %s off%d: port=%s stbd=%s  score=%.0f'%(r[2][0],r[2][1],r[2][2],r[1],r[3],round(r[4],3),round(r[5],3),r[0]))
if not res: print('  NONE — rudder position is not on the bus (no feedback sensor / Shadow Drive).')
