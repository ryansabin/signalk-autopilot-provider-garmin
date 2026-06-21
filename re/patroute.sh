#!/bin/bash
P=$1; HOLD=${2:-30}
TOK=$(cat /tmp/aptok)
B=http://localhost/signalk/v1/api/vessels/self/steering/autopilot/rudder
hd(){ curl -s http://localhost/signalk/v1/api/vessels/self/navigation/headingMagnetic|python3 -c "import sys,json;v=json.load(sys.stdin).get('value');print('--' if v is None else round(v*57.2958))"; }
ru(){ curl -s http://localhost/signalk/v1/api/vessels/self/steering/rudderAngle|python3 -c "import sys,json;v=json.load(sys.stdin).get('value');print('--' if v is None else round(v*57.2958,1))"; }
echo ">>> PATTERN $P (no standby; returns to nav-follow 0D after) -- STANDBY on helm to abort"
echo "  before: hdg $(hd) rud $(ru)"
curl -s -o /dev/null -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d "{\"value\":\"$P\"}" $B/pattern
n=$((HOLD/3))
for i in $(seq 1 $n); do printf "  t%2ds  hdg %s  rud %s\n" $((i*3)) "$(hd)" "$(ru)"; sleep 3; done
curl -s -o /dev/null -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"value":"0D"}' $B/rawstate
echo ">>> back to nav-follow (0D)  hdg $(hd)"
