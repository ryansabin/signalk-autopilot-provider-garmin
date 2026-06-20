#!/bin/bash
L="$1"; T="${2:-12}"
timeout "$T" candump -ta can0 > "/tmp/cap_$L.log" 2>/dev/null
echo "=== $L: frames=$(wc -l < /tmp/cap_$L.log) ==="
echo "--- NOVEL command frames head->CCU (keepalive 15 03 excluded) ---"
python3 /tmp/apre.py diff /tmp/cap_base.log "/tmp/cap_$L.log" 2>&1 | grep -E '> *2 ' | grep -v '04 15 03'
