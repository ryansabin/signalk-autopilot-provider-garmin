import sys,struct,collections,statistics
sys.path.insert(0,'/tmp'); import apre
def fields(path,src=2):
  g=collections.defaultdict(list)
  for t,pr,p,s,d,pl in apre.parse(path):
    if p==126720 and s==src and d==255 and len(pl)>=8 and bytes(pl[2:6])==bytes([16,23,4,4]):
      g[(pl[6],pl[7])].append(bytes(pl))
  return g
P=fields('/tmp/rud_port.log'); S=fields('/tmp/rud_stbd.log')
keys=set(P)&set(S)
res=[]
for k in keys:
  pp=P[k]; ss=S[k]
  if len(pp)<5 or len(ss)<5: continue
  L=min(min(len(x) for x in pp),min(len(x) for x in ss))
  for off in range(8,L-1):
    vp=[struct.unpack('<h',x[off:off+2])[0] for x in pp]
    vs=[struct.unpack('<h',x[off:off+2])[0] for x in ss]
    mp=statistics.median(vp); ms=statistics.median(vs)
    spreadp=max(vp)-min(vp); spreads=max(vs)-min(vs)
    diff=abs(mp-ms)
    if diff>15 and diff>1.5*max(spreadp,spreads,1):
      res.append((diff,k,off,round(mp),round(ms),spreadp,spreads))
res.sort(reverse=True)
print('s16 LE fields that differ PORT vs STBD (rudder candidate = top, stable, sign-flipping):')
for r in res[:15]:
  print('  fid %02X %02X off%d: port=%5d  stbd=%5d  (diff=%d, spread p%d/s%d)'%(r[1][0],r[1][1],r[2],r[3],r[4],r[0],r[5],r[6]))
if not res: print('  (no s16 field differed; rudder feedback likely not broadcast)')
