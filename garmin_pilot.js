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

// Controller-registration keepalive. The GHC heads broadcast this ~2 Hz to the
// CCU; without it the Reactor treats us as an unregistered sender and faults to
// standby on a heading-adjust. Payload mirrors a head's keepalive (byte8=02 =>
// active controller). Sending it makes the CCU accept our heading nudges.
const KEEPALIVE = '%s,7,126720,%s,%s,0C,E5,98,10,17,04,04,15,03,02,00,C8,00'
const KEEPALIVE_MS = 500


// Steering patterns (powerboat). Each = a selector frame 04 <sel> 00 <dir> then the engage
// state 05 0A 00 <code>. Zigzag has no selector. dir 00/01 = port/starboard.
const PAT_SEL = '%s,7,126720,%s,%s,0A,E5,98,10,17,04,04,04,%s,00,%s,FF,FF,FF,FF,FF,FF'
const PATTERNS = {
  zigzag:     { sel: null, code: '09' },
  circles:    { sel: '34', code: '08' },
  uturn:      { sel: '6F', code: '0B' },
  williamson: { sel: '47', code: '0A' },
  // GPS patterns — require active navigation (a Go-To / route) on the chartplotter
  orbit:      { sel: '5B', code: '0F' },
  cloverleaf: { sel: '3E', code: '0E' },
  search:     { sel: '65', code: '10' },
  // Sailing maneuvers (from wind/heading hold). Tack and gybe are the SAME wire command;
  // the CCU decides tack vs gybe from the wind geometry. dir = turn direction.
  tack:       { sel: 'A2', code: '13' },
  gybe:       { sel: 'A2', code: '13' }
}

const AP_OPTIONS = {
  states: [
    { name: 'auto', engaged: true },     // compass heading hold
    { name: 'wind', engaged: true },     // apparent wind hold
    { name: 'route', engaged: true },    // nav / route follow (observed only; engaged from the plotter)
    { name: 'standby', engaged: false }
  ],
  modes: []
}

// Status-decode tuning
const WIND_FID = [0x00, 0x0B]
const ENGAGED_FIDS = [[0x00, 0xA2], [0x02, 0x74], [0x00, 0x72]]
// The CCU never broadcasts its discrete mode, so we read the MODE-SET COMMANDS on the bus
// instead. Any controller sets the CCU mode with the frame  10 17 04 04 05 0A 00 <code>  :
// the GHC (src 5) sends 02/05/11 for standby/heading/wind, the chartplotter (src 4) sends 0D
// for route. We watch these from every source and take the latest as the authoritative mode.
// Verified live (captured src 5: 05 0A 00 02 / 11 / 05). The user's workflow guarantees a clean
// standby->engage command for every mode change, so this is unambiguous.
const STATECMD = [0x10, 0x17, 0x04, 0x04, 0x05, 0x0A, 0x00]   // prefix; next byte is the code
const CMD_MODE = {
  0x02: 'standby', 0x05: 'auto', 0x11: 'wind', 0x0D: 'route',
  0x08: 'pattern', 0x09: 'pattern', 0x0A: 'pattern', 0x0B: 'pattern',
  0x0E: 'pattern', 0x0F: 'pattern', 0x10: 'pattern'
  // 0x06 hard-turn, 0x13 tack/gybe, 0x15 rudder-test intentionally omitted (transient; they
  // must not overwrite the underlying hold mode)
}
// Target-adjust steps: 10 17 04 04 26 <code>. Degrees per press (low bit = step size, high
// bit = sign). Watched on the bus so head-unit adjustments move the tracked target too.
const ADJUST_DELTA = { 0x00: -1, 0x01: -10, 0x02: 1, 0x03: 10 }
// The CCU broadcasts engaged/wind markers continuously at ~24 Hz while engaged, so a tight
// window with a low threshold tracks the true state within ~1 s and drops to standby promptly.
// (The old 3 s window + "stay engaged on 1 marker" hysteresis lagged badly — it falsely held
// engaged for seconds after a real standby. Removed.)
const WIND_WINDOW_MS = 2500
const ENGAGED_WINDOW_MS = 3000   // engaged markers arrive ~2/s but bursty; a 1.3 s window dipped
                                 // below threshold between bursts and flapped engaged->standby.
const WIND_MIN = 3
const ENGAGED_MIN = 2     // markers in the window to report engaged (no hysteresis)
const EVAL_MS = 400

const util = require('util')
const { spawn } = require('child_process')

module.exports = function (app) {
  const status = { state: null, mode: null, engaged: null, target: null }

  let srcAddr = '3'
  let ccuAddr = '2'      // Reactor CCU N2K source address (discovered or configured)
  let canInterface = 'can0'
  let registerController = true   // broadcast the controller keepalive (needed for heading nudges)
  let discovered = false

  const seen = new Map()      // 'hi:lo' -> [timestamps ms]
  let lastWindAngle = null
  let lastHeading = null         // radians, vessel heading from PGN 127250 (CCU)
  let lastApparentWind = null    // radians (signed +-pi), apparent wind angle from PGN 130306
  let trackedTarget = null       // radians, target heading tracked locally in auto mode
  let trackedWind = null         // radians (signed +-pi), desired wind angle tracked in wind mode
  let lastCmdMode = null         // mode from the last 05 0A 00 <code> command seen on the bus
  let evalTimer = null
  let kaTimer = null
  let candump = null
  const asm = {}              // fast-packet reassembly: key -> { len, bytes }

  const pilot = { id: null, type: apType }

  pilot.start = (props) => {
    props = props || {}
    srcAddr = props.srcAddr || srcAddr
    ccuAddr = props.ccuAddr || ccuAddr
    canInterface = props.canInterface || canInterface
    if (props.registerController !== undefined) registerController = props.registerController
    app.debug('Garmin Reactor provider start. srcAddr=%s ccuAddr=%s if=%s register=%s', srcAddr, ccuAddr, canInterface, registerController)
    startCanReader()
    evalTimer = setInterval(evaluate, EVAL_MS)
    if (registerController) kaTimer = setInterval(() => { app.emit('nmea2000out', util.format(KEEPALIVE, now(), srcAddr, ccuAddr)) }, KEEPALIVE_MS)
    registerPutHandlers()
  }

  pilot.stop = () => {
    if (evalTimer) { clearInterval(evalTimer); evalTimer = null }
    if (kaTimer) { clearInterval(kaTimer); kaTimer = null }
    if (routeTimer) { clearInterval(routeTimer); routeTimer = null }
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
    // Locally track the target (the CCU doesn't broadcast it decodably).
    if (value === 'auto') { trackedTarget = lastHeading; trackedWind = null }            // hold current heading
    else if (value === 'wind') { trackedWind = lastApparentWind; trackedTarget = null }  // hold current apparent wind angle
    else { trackedTarget = null; trackedWind = null }                                    // standby
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
    // The tracked target is advanced when this command is observed back on the bus (see
    // onReassembled's 26-adjust watch), which also covers head-unit adjustments — so we don't
    // advance it locally here, to avoid double-counting our own command.
  }

  pilot.setTarget = () => { throw new Error('setTarget not implemented (no known Garmin absolute-heading PGN); use adjustTarget') }
  // V2 API passes a direction (port/starboard), but the CCU only accepts the one valid turn for
  // the current point of sail, so we auto-pick from the wind and use the requested side only as a
  // fallback when no wind is available.
  pilot.tack = (direction) => engagePattern('tack', maneuverDir('tack') || direction)
  pilot.gybe = (direction) => engagePattern('gybe', maneuverDir('gybe') || direction)
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
        canInterface: { type: 'string', title: 'CAN interface to read for status', description: 'socketcan interface the CCU is on (read directly via candump).', default: canInterface },
        registerController: { type: 'boolean', title: 'Register as a controller (keepalive)', description: 'Broadcast the GHC controller keepalive so the CCU accepts heading-adjust commands. Required for heading nudges.', default: true }
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
    // PGN 127250 Vessel Heading (single frame): byte0=SID, bytes1-2 = heading u16 * 1e-4 rad
    if (pgn === 127250) {
      if (String(sa) === String(ccuAddr) && data.length >= 3) {
        const h = (data[1] | (data[2] << 8)) * 1e-4
        if (h >= 0 && h < 7) lastHeading = h
      }
      return
    }
    // PGN 130306 Wind Data: byte0=SID, b3-4 = wind angle u16 * 1e-4 rad, b5 = reference (2 = apparent)
    if (pgn === 130306) {
      if (data.length >= 6 && (data[5] & 0x07) === 2) {
        let a = (data[3] | (data[4] << 8)) * 1e-4
        if (a > Math.PI) a -= 2 * Math.PI   // 0..2pi -> signed +-pi (negative = port)
        if (a >= -Math.PI && a <= Math.PI) lastApparentWind = a
      }
      return
    }
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
    // Watch commands from ANY controller (GHC src 5, chartplotter src 4, or us), directed to the
    // CCU, in the 10 17 04 04 container:
    //   05 0A 00 <code>  mode set  -> current mode (+ seed the target baseline on a transition)
    //   26 <code>        target adjust (+-1/+-10 deg step) -> advance desired heading / wind angle
    // Reading the adjust from the bus means head-unit changes move the tracked target too, not
    // just our own API commands.
    for (let i = 0; i + 5 < bytes.length; i++) {
      if (bytes[i] !== 0x10 || bytes[i + 1] !== 0x17 || bytes[i + 2] !== 0x04 || bytes[i + 3] !== 0x04) continue
      if (bytes[i + 4] === 0x05 && bytes[i + 5] === 0x0A && bytes[i + 6] === 0x00 && i + 7 < bytes.length) {
        const m = CMD_MODE[bytes[i + 7]]
        if (m !== undefined) {
          if (m !== lastCmdMode) {                                  // mode transition: seed baseline
            if (m === 'auto') { trackedTarget = lastHeading; trackedWind = null }
            else if (m === 'wind') { trackedWind = lastApparentWind; trackedTarget = null }
            else if (m === 'standby') { trackedTarget = null; trackedWind = null }
          }
          lastCmdMode = m
        }
      } else if (bytes[i + 4] === 0x26 && ADJUST_DELTA[bytes[i + 5]] !== undefined) {
        const stepRad = ADJUST_DELTA[bytes[i + 5]] * Math.PI / 180
        if (lastCmdMode === 'wind' && trackedWind !== null) {       // wind step is opposite sign (GHC)
          trackedWind -= stepRad
          while (trackedWind > Math.PI) trackedWind -= 2 * Math.PI
          while (trackedWind < -Math.PI) trackedWind += 2 * Math.PI
        } else if (trackedTarget !== null) {
          trackedTarget += stepRad
          while (trackedTarget < 0) trackedTarget += 2 * Math.PI
          while (trackedTarget >= 2 * Math.PI) trackedTarget -= 2 * Math.PI
        }
      }
    }
    // CCU status broadcast only: engaged markers + wind-tracking field (used for the
    // engaged/standby gate and the wind-angle value).
    if (String(src) !== String(ccuAddr) || dst !== 255) return
    const ts = Date.now()
    for (let idx = 0; idx + 5 < bytes.length; idx++) {
      if (bytes[idx] !== 0x10 || bytes[idx + 1] !== 0x17 || bytes[idx + 2] !== 0x04 || bytes[idx + 3] !== 0x04) continue
      const fhi = bytes[idx + 4]
      const flo = bytes[idx + 5]
      const k = fhi + ':' + flo
      const arr = seen.get(k) || []
      arr.push(ts)
      seen.set(k, arr)
      if (fhi === WIND_FID[0] && flo === WIND_FID[1] && idx + 10 < bytes.length) {
        const f = readFloatLE(bytes, idx + 7)
        if (f !== null && isFinite(f) && Math.abs(f) < 7) lastWindAngle = f
      }
    }
  }

  function evaluate () {
    const t = Date.now()
    const cnt = (k, win) => {
      const arr = (seen.get(k) || []).filter((ts) => t - ts <= win)
      seen.set(k, arr)
      return arr.length
    }
    let engHits = 0
    ENGAGED_FIDS.forEach((f) => { engHits += cnt(f[0] + ':' + f[1], ENGAGED_WINDOW_MS) })
    const windHits = cnt(WIND_FID[0] + ':' + WIND_FID[1], WIND_WINDOW_MS)

    let state, engaged, target = null
    if (engHits >= ENGAGED_MIN) {
      // Engaged. Mode = the last mode-set command observed on the bus (authoritative; works
      // no matter which device engaged it). If we haven't seen a command yet this session,
      // fall back to the wind-field heuristic (wind hold streams 00 0B; heading hold doesn't).
      engaged = true
      if (lastCmdMode && lastCmdMode !== 'standby') state = lastCmdMode
      else state = (windHits >= WIND_MIN) ? 'wind' : 'auto'
      // Seed a baseline if we came up already engaged (missed the engage command after a restart).
      if (state === 'auto' && trackedTarget === null && lastHeading !== null) trackedTarget = lastHeading
      else if (state === 'wind' && trackedWind === null && lastApparentWind !== null) trackedWind = lastApparentWind
      target = (state === 'wind') ? trackedWind : trackedTarget
    } else {
      engaged = false; state = 'standby'
    }
    // trackedTarget/trackedWind lifecycle is driven by setState/adjustTarget (commands), not by
    // the detected state, so the engage transient doesn't wipe it.

    const changed = state !== status.state
    if (changed) app.debug('Garmin AP state -> %s (eng=%d cmd=%s wind=%d)', state, engHits, lastCmdMode, windHits)
    // mode is intentionally null: SignalK splits state (engagement) from mode (steering
    // sub-mode), but the Reactor exposes everything through state and we define no separate
    // modes, so publishing mode would only duplicate state.
    status.state = state; status.mode = null; status.engaged = engaged; status.target = target
    if (typeof app.autopilotUpdate === 'function') {
      try { app.autopilotUpdate(apType, { state, mode: null, engaged, target }) } catch (e) { if (changed) app.debug('autopilotUpdate failed: ' + e.message) }
    }
  }

  // ---- Route follow: drive a waypoint from our side (no chartplotter Go-To needed) ----
  // The CCU follows the standard nav PGNs the chartplotter normally broadcasts. We generate
  // them ourselves from the live GPS position toward a target waypoint, then engage nav-follow
  // (state 0D). Templates captured live from this boat's GPSMAP; we patch in distance, bearing
  // and destination (129284) and cross-track error (129283), keeping the other fields as-is.
  // NOTE: the chartplotter must NOT be navigating, or it will broadcast conflicting nav data.
  const NAV284 = [0xFF, 0x59, 0xF3, 0x00, 0x00, 0x00, 0x40, 0x8C, 0x5A, 0x29, 0x91, 0x50, 0x7C, 0x4A, 0x45, 0x4A, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x25, 0x45, 0x65, 0x16, 0x21, 0x32, 0x27, 0xB7, 0xFF, 0x7F]
  const NAV283 = [0xFF, 0xF1, 0x55, 0x01, 0x00, 0x00]
  // 129285 Route/WP Information template (from the GPSMAP). Declares the active route + its
  // destination waypoint; we patch the waypoint lat (bytes 32-35) and lon (36-39).
  const NAV285 = [0xFF, 0xFF, 0x02, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xE0, 0x02, 0x01, 0xFF, 0xFF, 0xFF, 0x02, 0x01, 0xFF, 0xFF, 0xFF, 0x7F, 0xFF, 0xFF, 0xFF, 0x7F, 0x08, 0x00, 0x06, 0x01, 0x30, 0x30, 0x39, 0x33, 0x25, 0x45, 0x65, 0x16, 0x21, 0x32, 0x27, 0xB7]
  const NAV_MS = 500
  let routeTarget = null
  let routeStart = null
  let routeTimer = null
  let nav285ctr = 0

  function toRad (d) { return d * Math.PI / 180 }
  function distBrg (la1, lo1, la2, lo2) {
    const R = 6371000, p1 = toRad(la1), p2 = toRad(la2), dp = toRad(la2 - la1), dl = toRad(lo2 - lo1)
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    let brg = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))
    if (brg < 0) brg += 2 * Math.PI
    return { dist, brg }
  }
  function crossTrack (la1, lo1, laS, loS, laT, loT) {
    const R = 6371000
    const a = distBrg(laS, loS, la1, lo1)
    const brg12 = distBrg(laS, loS, laT, loT).brg
    return Math.asin(Math.sin(a.dist / R) * Math.sin(a.brg - brg12)) * R
  }
  function putI32LE (b, off, v) { v |= 0; b[off] = v & 0xFF; b[off + 1] = (v >> 8) & 0xFF; b[off + 2] = (v >> 16) & 0xFF; b[off + 3] = (v >> 24) & 0xFF }
  function putU16LE (b, off, v) { b[off] = v & 0xFF; b[off + 1] = (v >> 8) & 0xFF }
  function emitPgn (pgn, bytes) {
    const hex = bytes.map((v) => ('0' + (v & 0xFF).toString(16)).slice(-2).toUpperCase()).join(',')
    app.emit('nmea2000out', util.format('%s,3,%d,%s,255,%d,%s', now(), pgn, srcAddr, bytes.length, hex))
  }
  function emitNav () {
    const pos = (typeof app.getSelfPath === 'function') ? app.getSelfPath('navigation.position.value') : null
    if (!pos || !routeTarget || typeof pos.latitude !== 'number') return
    const { dist, brg } = distBrg(pos.latitude, pos.longitude, routeTarget.lat, routeTarget.lon)
    let xte = 0
    try { if (routeStart) xte = crossTrack(pos.latitude, pos.longitude, routeStart.lat, routeStart.lon, routeTarget.lat, routeTarget.lon) } catch (e) {}
    const b = NAV284.slice()
    putI32LE(b, 1, Math.max(0, Math.round(dist * 100)))          // distance, 0.01 m
    const bu = Math.round(brg / 0.0001) & 0xFFFF
    putU16LE(b, 12, bu); putU16LE(b, 14, bu)                      // bearing origin->dest, pos->dest (rad*1e4)
    putI32LE(b, 24, Math.round(routeTarget.lat * 1e7))           // dest latitude
    putI32LE(b, 28, Math.round(routeTarget.lon * 1e7))           // dest longitude
    emitPgn(129284, b)
    const x = NAV283.slice()
    putI32LE(x, 2, Math.round(xte * 100))                        // XTE, 0.01 m (signed)
    emitPgn(129283, x)
    // 129285 Route/WP Information at a lower rate (~1 Hz) — declares the active route.
    nav285ctr = (nav285ctr + 1) % 2
    if (nav285ctr === 0) {
      const r = NAV285.slice()
      putI32LE(r, 32, Math.round(routeTarget.lat * 1e7))
      putI32LE(r, 36, Math.round(routeTarget.lon * 1e7))
      emitPgn(129285, r)
    }
  }
  function gotoStart (lat, lon) {
    const pos = (typeof app.getSelfPath === 'function') ? app.getSelfPath('navigation.position.value') : null
    if (!pos || typeof pos.latitude !== 'number') throw new Error('no GPS position; cannot start route')
    routeTarget = { lat, lon }
    routeStart = { lat: pos.latitude, lon: pos.longitude }
    emitNav()                                                    // prime the nav data before engaging
    send(util.format(CMD.state, now(), srcAddr, ccuAddr, '0D')) // engage nav-follow
    if (routeTimer) clearInterval(routeTimer)
    routeTimer = setInterval(emitNav, NAV_MS)
    return 'goto ' + lat.toFixed(5) + ',' + lon.toFixed(5)
  }
  function gotoStop () {
    if (routeTimer) { clearInterval(routeTimer); routeTimer = null }
    routeTarget = null
    send(util.format(CMD.state, now(), srcAddr, ccuAddr, STATE_CODE.standby))
    return 'route stopped'
  }

  // Engage a steering pattern / maneuver by name (+ direction). Sends the selector frame
  // (if any) then the engage state. GPS patterns need an active route; sailing maneuvers
  // need wind/heading hold engaged first.
  // Pick the turn direction for a tack/gybe from the apparent wind. The CCU only accepts the
  // ONE valid direction for the current point of sail (verified live: tack turns TOWARD the
  // wind, gybe turns AWAY from it); a wrong direction is silently ignored. Returns 'starboard'
  // or 'port', or null if no wind is available. dir 00 = starboard turn, 01 = port turn.
  function maneuverDir (name) {
    let wa = lastApparentWind
    if ((wa === null || !isFinite(wa)) && typeof app.getSelfPath === 'function') {
      const v = app.getSelfPath('environment.wind.angleApparent.value')
      if (typeof v === 'number' && isFinite(v)) wa = v
    }
    if (wa === null || !isFinite(wa)) return null
    const windStbd = wa > 0                                       // +ve apparent angle = wind on starboard
    if (name === 'tack') return windStbd ? 'starboard' : 'port'   // tack: turn toward the wind
    return windStbd ? 'port' : 'starboard'                        // gybe: turn away from the wind
  }

  function engagePattern (name, dirS) {
    const p = PATTERNS[name]
    if (!p) throw new Error('unknown pattern: ' + name)
    if ((name === 'tack' || name === 'gybe') && !dirS) {
      dirS = maneuverDir(name)
      if (!dirS) throw new Error('no apparent wind available to choose ' + name + ' direction')
    }
    const dir = (dirS === 'stbd' || dirS === 'starboard' || dirS === '0' || dirS === '00') ? '00' : '01'
    if (p.sel) send(util.format(PAT_SEL, now(), srcAddr, ccuAddr, p.sel, dir))
    send(util.format(CMD.state, now(), srcAddr, ccuAddr, p.code))
    return 'pattern ' + name + (p.sel ? ' ' + (dir === '00' ? 'stbd' : 'port') : '')
  }

  // Custom PUT endpoints for the Garmin-specific operations the standard V2 API doesn't cover
  // (steering patterns + our own route-follow). State/target/tack/gybe go through the V2 API.
  function registerPutHandlers () {
    if (typeof app.registerPutHandler !== 'function') { app.debug('registerPutHandler unavailable; pattern/route PUT control disabled'); return }
    // Engage a steering pattern. value = "<name>:<dir>", e.g. "circles:stbd", "uturn:port", "zigzag".
    app.registerPutHandler('vessels.self', 'steering.autopilot.rudder.pattern', (ctx, path, value, cb) => {
      try {
        const v = ('' + ((value && value.value) || value)).trim()
        const [name, dirS] = v.split(':')
        return { state: 'COMPLETED', statusCode: 200, message: engagePattern(name, dirS) }
      } catch (e) { return { state: 'COMPLETED', statusCode: 502, message: e.message } }
    })
    // Route follow from our side. value = "<lat>,<lon>" or { latitude, longitude }.
    //   steering.autopilot.route.goto  -> generate nav data toward the waypoint + engage nav-follow
    //   steering.autopilot.route.stop  -> stop generating + standby
    app.registerPutHandler('vessels.self', 'steering.autopilot.route.goto', (ctx, path, value, cb) => {
      try {
        const v = (value && value.value !== undefined) ? value.value : value
        let lat, lon
        if (v && typeof v === 'object') { lat = v.latitude; lon = v.longitude } else { const p = String(v).split(','); lat = parseFloat(p[0]); lon = parseFloat(p[1]) }
        if (!isFinite(lat) || !isFinite(lon)) throw new Error('need "latitude,longitude"')
        return { state: 'COMPLETED', statusCode: 200, message: gotoStart(lat, lon) }
      } catch (e) { return { state: 'COMPLETED', statusCode: 502, message: e.message } }
    })
    app.registerPutHandler('vessels.self', 'steering.autopilot.route.stop', (ctx, path, value, cb) => {
      return { state: 'COMPLETED', statusCode: 200, message: gotoStop() }
    })
    app.debug('PUT handlers registered (pattern, route goto/stop)')
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
