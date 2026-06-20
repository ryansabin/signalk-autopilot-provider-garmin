'use strict'

/*
 * Garmin Reactor autopilot — device logic for the Signal K v2 provider.
 *
 * Verified live on Buttercup's Reactor 40 (2026-06-20).
 *
 * COMMANDS (TX) — sent as PGN 126720 to the CCU via SignalK 'nmea2000out'
 * (canboatjs assigns SignalK's own N2K source address). Confirmed by capture:
 *   state set:     E5 98 10 17 04 04 05 0A 00 <code>   standby=02 auto=05 wind=11
 *   heading nudge: E5 98 10 17 04 04 26 <code>         -1=00 -10=01 +1=02 +10=03
 *
 * STATUS (RX) — READ DIRECTLY FROM can0 (candump), NOT via canboatjs.
 *   canboatjs only decodes the Garmin "AHRS ATT" 126720 variant and silently
 *   drops the autopilot container, so N2KAnalyzerOut never delivers it. We tap
 *   the bus ourselves, reassemble fast-packets, and decode the CCU's broadcasts:
 *     E5 98 10 17 04 04 <fid_hi> <fid_lo> ...   (field sub-messages)
 *   Mode by field presence:
 *     00 0B  -> WIND mode; payload carries target apparent wind angle
 *               as a little-endian float32 (radians) at marker+7.
 *     00 A2 / 02 74 / 00 72 -> present only when ENGAGED; absent in standby.
 *   no 00 0B + no engaged-markers => STANDBY.
 *   (Target heading field not yet isolated — TODO from a stationary capture.)
 */

const apType = 'garminReactor'
const AP_DISCOVERY_TEXT = 'Reactor'

const CMD = {
  heading: '%s,7,126720,%s,%s,09,E5,98,10,17,04,04,26,%s,00,FF,FF,FF,FF',
  state:   '%s,7,126720,%s,%s,0B,E5,98,10,17,04,04,05,0A,00,%s,00,FF,FF'
}
const HEADING_CODE = { '1': '02', '10': '03', '15': '03', '-1': '00', '-10': '01', '-15': '01' }
const STATE_CODE = { auto: '05', standby: '02', wind: '11' }

const AP_OPTIONS = {
  states: [
    { name: 'auto', engaged: true },
    { name: 'wind', engaged: true },
    { name: 'standby', engaged: false }
  ],
  modes: []
}

// Status-decode tuning
const WIND_FID = [0x00, 0x0B]
const ENGAGED_FIDS = [[0x00, 0xA2], [0x02, 0x74], [0x00, 0x72]]
const WIND_WINDOW_MS = 1500
const ENGAGED_WINDOW_MS = 2500
const WIND_MIN = 3
const ENGAGED_MIN = 2
const EVAL_MS = 500

const util = require('util')
const { spawn } = require('child_process')

module.exports = function (app) {
  const status = { state: null, mode: null, engaged: null, target: null }

  let srcAddr = '3'
  let ccuAddr = '2'      // Reactor CCU N2K source address (discovered or configured)
  let canInterface = 'can0'
  let discovered = false

  const seen = new Map()      // 'hi:lo' -> [timestamps ms]
  let lastWindAngle = null
  let evalTimer = null
  let candump = null
  const asm = {}              // fast-packet reassembly: key -> { len, bytes }

  const pilot = { id: null, type: apType }

  pilot.start = (props) => {
    props = props || {}
    srcAddr = props.srcAddr || srcAddr
    ccuAddr = props.ccuAddr || ccuAddr
    canInterface = props.canInterface || canInterface
    app.debug('Garmin Reactor provider start. srcAddr=%s ccuAddr=%s if=%s', srcAddr, ccuAddr, canInterface)
    startCanReader()
    evalTimer = setInterval(evaluate, EVAL_MS)
  }

  pilot.stop = () => {
    if (evalTimer) { clearInterval(evalTimer); evalTimer = null }
    if (candump) { try { candump.kill() } catch (e) {} candump = null }
  }

  pilot.getData = () => ({
    state: status.state,
    mode: status.mode,
    engaged: status.engaged,
    target: status.target,
    options: AP_OPTIONS
  })

  pilot.setState = (value) => {
    const code = STATE_CODE[value]
    if (code === undefined) throw new Error('Unsupported state: ' + value + ' (known: auto, standby, wind)')
    send(util.format(CMD.state, now(), srcAddr, ccuAddr, code))
    status.state = value
    status.engaged = (value !== 'standby')
    return status.engaged
  }

  pilot.engage = () => pilot.setState('auto')
  pilot.disengage = () => pilot.setState('standby')
  pilot.setMode = (mode) => pilot.setState(mode)

  pilot.adjustTarget = (value) => {
    if (!status.engaged) app.debug('adjustTarget while not engaged; sending anyway')
    const step = quantizeStep(radToDeg(value))
    const code = HEADING_CODE[step]
    if (code === undefined) throw new Error('Cannot map adjustment to a Garmin step')
    send(util.format(CMD.heading, now(), srcAddr, ccuAddr, code))
  }

  pilot.setTarget = () => { throw new Error('setTarget not implemented (no known Garmin absolute-heading PGN); use adjustTarget') }
  pilot.tack = () => { throw new Error('tack not implemented yet (Garmin wind-mode tack TBD)') }
  pilot.gybe = () => { throw new Error('gybe not implemented for Garmin Reactor') }
  pilot.dodge = () => { throw new Error('dodge not implemented for Garmin Reactor') }

  // ---- Discovery + config schema ----
  pilot.properties = () => {
    if (!discovered) {
      const sources = app.getPath('/sources')
      if (sources) {
        Object.values(sources).forEach((bus) => {
          if (bus && typeof bus === 'object') {
            Object.keys(bus).forEach((addr) => {
              const n2k = bus[addr] && bus[addr].n2k
              if (!n2k) return
              const hay = [n2k.hardwareVersion, n2k.modelId, n2k.productName]
                .filter((x) => typeof x === 'string').join(' ')
              if (hay.indexOf(AP_DISCOVERY_TEXT) !== -1) {
                ccuAddr = String(addr); discovered = true
                app.debug('Discovered Garmin Reactor CCU at N2K addr ' + ccuAddr)
              }
            })
          }
        })
      }
    }
    const desc = discovered ? 'Discovered Reactor CCU at N2K address ' + ccuAddr
      : 'Reactor not auto-discovered; set the CCU address manually.'
    pilot.id = ccuAddr
    return {
      properties: {
        ccuAddr: { type: 'string', title: 'Garmin Reactor CCU NMEA2000 address', description: desc, default: ccuAddr || '2' },
        srcAddr: { type: 'string', title: 'Source address this plugin transmits from', description: 'Use a free N2K address.', default: srcAddr },
        canInterface: { type: 'string', title: 'CAN interface to read for status', description: 'socketcan interface the CCU is on (read directly via candump).', default: canInterface }
      }
    }
  }

  // ---- Status RX: read can0 directly, reassemble fast-packets, decode ----
  function startCanReader () {
    try {
      candump = spawn('candump', [canInterface])
    } catch (e) {
      app.setPluginError && app.setPluginError('cannot start candump: ' + e.message)
      app.error && app.error('candump spawn failed: ' + e.message)
      return
    }
    candump.stdout.setEncoding('utf8')
    let partial = ''
    candump.stdout.on('data', (chunk) => {
      partial += chunk
      let i
      while ((i = partial.indexOf('\n')) >= 0) {
        handleCanLine(partial.slice(0, i)); partial = partial.slice(i + 1)
      }
    })
    candump.on('error', (e) => { app.error && app.error('candump error: ' + e.message) })
    candump.on('exit', (code) => {
      app.debug('candump exited (%s); restarting in 3s', code)
      candump = null
      if (evalTimer) setTimeout(() => { if (evalTimer) startCanReader() }, 3000)
    })
  }

  // candump default line: "  can0  18EF0205   [8]  E5 98 10 17 04 04 15 03"
  const LINE_RE = /\b([0-9A-Fa-f]{3,8})\s+\[(\d+)\]\s+([0-9A-Fa-f ]+)$/
  function handleCanLine (line) {
    const m = LINE_RE.exec(line.trim())
    if (!m) return
    const canId = parseInt(m[1], 16)
    const data = m[3].trim().split(/\s+/).map((x) => parseInt(x, 16))
    const pf = (canId >> 16) & 0xff
    const ps = (canId >> 8) & 0xff
    const sa = canId & 0xff
    const dp = (canId >> 24) & 1
    let pgn, dst
    if (pf < 240) { pgn = (dp << 16) | (pf << 8); dst = ps } else { pgn = (dp << 16) | (pf << 8) | ps; dst = 255 }
    if (pgn !== 126720) return
    // fast-packet reassembly
    const seqhi = data[0] & 0xe0
    const frame = data[0] & 0x1f
    const key = sa + ':' + seqhi
    if (frame === 0) {
      asm[key] = { len: data[1], bytes: data.slice(2) }
    } else if (asm[key]) {
      asm[key].bytes = asm[key].bytes.concat(data.slice(1))
    }
    const a = asm[key]
    if (a && a.len > 0 && a.bytes.length >= a.len) {
      const payload = a.bytes.slice(0, a.len)
      delete asm[key]
      onReassembled(sa, dst, payload)
    }
  }

  function onReassembled (src, dst, bytes) {
    if (String(src) !== String(ccuAddr) || dst !== 255) return
    const idx = findMarker(bytes)
    if (idx === -1 || idx + 5 >= bytes.length) return
    const fhi = bytes[idx + 4]
    const flo = bytes[idx + 5]
    const k = fhi + ':' + flo
    const arr = seen.get(k) || []
    arr.push(Date.now())
    seen.set(k, arr)
    if (fhi === WIND_FID[0] && flo === WIND_FID[1] && idx + 10 < bytes.length) {
      const f = readFloatLE(bytes, idx + 7)
      if (f !== null && isFinite(f) && Math.abs(f) < 7) lastWindAngle = f
    }
  }

  function evaluate () {
    const t = Date.now()
    const cnt = (k, win) => {
      const arr = (seen.get(k) || []).filter((ts) => t - ts <= win)
      seen.set(k, arr)
      return arr.length
    }
    const windHits = cnt(WIND_FID[0] + ':' + WIND_FID[1], WIND_WINDOW_MS)
    let engHits = 0
    ENGAGED_FIDS.forEach((f) => { engHits += cnt(f[0] + ':' + f[1], ENGAGED_WINDOW_MS) })

    let state, mode, engaged, target = null
    if (windHits >= WIND_MIN) { state = 'wind'; mode = 'wind'; engaged = true; target = lastWindAngle } else if (engHits >= ENGAGED_MIN) { state = 'auto'; mode = 'auto'; engaged = true } else { state = 'standby'; mode = 'standby'; engaged = false }

    const changed = state !== status.state
    if (changed) app.debug('Garmin AP state -> %s (wind=%d eng=%d)', state, windHits, engHits)
    status.state = state; status.mode = mode; status.engaged = engaged; status.target = target
    if (typeof app.autopilotUpdate === 'function') {
      try { app.autopilotUpdate(apType, { state, mode, engaged, target }) } catch (e) { if (changed) app.debug('autopilotUpdate failed: ' + e.message) }
    }
  }

  // ---- helpers ----
  function send (msg) {
    if (!ccuAddr) { app.debug('no CCU address; not sending: ' + msg); return }
    app.debug('nmea2000out: ' + msg)
    app.emit('nmea2000out', msg)
  }
  function now () { return new Date().toISOString() }
  function radToDeg (r) { return (typeof r === 'number' ? r : 0) * 180 / Math.PI }
  function quantizeStep (deg) {
    const sz = Math.abs(deg) >= 6 ? 10 : 1
    return (deg < 0 ? '-' : '') + sz
  }
  function findMarker (b) {
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] === 0x10 && b[i + 1] === 0x17 && b[i + 2] === 0x04 && b[i + 3] === 0x04) return i
    }
    return -1
  }
  function readFloatLE (b, off) {
    if (off + 3 >= b.length) return null
    return Buffer.from([b[off], b[off + 1], b[off + 2], b[off + 3]]).readFloatLE(0)
  }

  return pilot
}
