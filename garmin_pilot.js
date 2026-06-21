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

// Rudder NFU jog / auto-center via the CCU's steering-test drive mode.
// Captured from the GHC steering-direction test (src5 -> CCU2):
//   enter test mode (engages drive/clutch): 05 0A 00 15   (a STATE command, new code 15)
//   jog rudder one step:                     04 15 00 <dir>   dir 00 / 01 = the two directions
//   exit test mode -> standby:               05 0A 00 02
// Sent through canboatjs ('nmea2000out') like every other command, because the CCU
// only honours these from SignalK's registered N2K device (raw cansend is ignored).
// enter/exit reuse CMD.state (codes 15 / 02); only the jog needs its own template.
const JOG = '%s,7,126720,%s,%s,0A,E5,98,10,17,04,04,04,15,00,%s,FF,FF,FF,FF,FF,FF'
const TEST_STATE_CODE = '15'                       // state code -> manual steering-test drive mode
const JOG_CODE = { port: '01', starboard: '00' }   // wire codes (verified live: 00 -> +ve/stbd, 01 -> -ve/port)
const CENTER_TOL_DEG = 2.0                          // stop when |rudder| <= this (~1 jog step ~1.8deg)
const JOG_PULSE_MS = 150                            // spacing between jog frames
const JOG_MAX_PULSES = 80                           // safety cap on one centering run
const JOG_NUDGE_MS = 250                            // drive window for one manual jog tap (~1.5-2 deg)

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
// Route/nav-follow flag. The CCU property 0E 02 holds the sentinel 71 17 whenever there is no
// active route, and a real (non-sentinel) value once it is following a Go-To / route. Verified
// live: identical 71 17 across standby, heading hold AND wind hold; flips to a live value (01 04
// observed) only under route-follow. This is what tells route apart from wind hold, since both
// stream the 00 0B wind-tracking field.
const ROUTE_FID = [0x0E, 0x02]
const ROUTE_SENTINEL = [0x71, 0x17]
const ROUTE_WINDOW_MS = 3000   // 0E 02 arrives ~1.5 Hz; use a wider window than the marker fields
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
  let routeActiveAt = 0          // last time the CCU's 0E 02 property showed an active route (ms)
  let evalTimer = null
  let kaTimer = null
  let candump = null
  let inTest = false          // rudder steering-test drive mode is active (jog or centering)
  let centering = false       // a centerRudder() run is in progress
  let testCooldownUntil = 0   // ignore engaged-markers until this time (drive disengage lag)
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
    if (inTest) { try { stopDrive() } catch (e) {} }
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
    // advance whichever target is active by the quantized step actually commanded
    const stepRad = parseInt(step, 10) * Math.PI / 180
    if (status.state === 'wind' && trackedWind !== null) {
      // a +course step turns the boat to starboard, which moves the signed wind
      // angle negative (more port) — opposite sign to the heading target. Matches GHC.
      trackedWind -= stepRad
      while (trackedWind > Math.PI) trackedWind -= 2 * Math.PI
      while (trackedWind < -Math.PI) trackedWind += 2 * Math.PI
    } else if (trackedTarget !== null) {
      trackedTarget += stepRad
      while (trackedTarget < 0) trackedTarget += 2 * Math.PI
      while (trackedTarget >= 2 * Math.PI) trackedTarget -= 2 * Math.PI
    }
  }

  pilot.setTarget = () => { throw new Error('setTarget not implemented (no known Garmin absolute-heading PGN); use adjustTarget') }
  pilot.tack = (direction) => engagePattern('tack', direction || 'starboard')
  pilot.gybe = (direction) => engagePattern('gybe', direction || 'starboard')
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
    if (String(src) !== String(ccuAddr) || dst !== 255) return
    const ts = Date.now()
    // A single 126720 message can pack several "10 17 04 04 <fhi> <flo> ..." properties;
    // scan them all so we don't miss low-rate fields like the 0E 02 route flag.
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
      } else if (fhi === ROUTE_FID[0] && flo === ROUTE_FID[1] && idx + 8 < bytes.length) {
        // 0E 02 = 71 17 when no active route; any other value => following a route/Go-To.
        if (!(bytes[idx + 7] === ROUTE_SENTINEL[0] && bytes[idx + 8] === ROUTE_SENTINEL[1])) routeActiveAt = ts
      }
    }
  }

  function evaluate () {
    // While the rudder test-drive (NFU jog / auto-center) is active, the CCU emits the
    // same engaged markers as heading-hold. Don't let that flip the reported mode to
    // 'auto' — we are not holding a heading. Report standby for the duration.
    if (inTest || Date.now() < testCooldownUntil) {
      status.state = 'standby'; status.mode = null; status.engaged = false; status.target = null
      if (typeof app.autopilotUpdate === 'function') {
        try { app.autopilotUpdate(apType, { state: 'standby', mode: null, engaged: false, target: null }) } catch (e) {}
      }
      return
    }
    const t = Date.now()
    const cnt = (k, win) => {
      const arr = (seen.get(k) || []).filter((ts) => t - ts <= win)
      seen.set(k, arr)
      return arr.length
    }
    let engHits = 0
    ENGAGED_FIDS.forEach((f) => { engHits += cnt(f[0] + ':' + f[1], ENGAGED_WINDOW_MS) })
    const windHits = cnt(WIND_FID[0] + ':' + WIND_FID[1], WIND_WINDOW_MS)
    const routeActive = (t - routeActiveAt) <= ROUTE_WINDOW_MS

    let state, engaged, target = null
    if (engHits >= ENGAGED_MIN) {
      // Engaged. The CCU does NOT broadcast its discrete sub-mode, so we infer it from the
      // two signals it does expose (all verified live):
      //   00 0B wind-tracking field : present in wind hold AND route-follow, absent in heading
      //   0E 02 != sentinel 71 17   : a route is LOADED on the plotter (not necessarily steered)
      // => no wind field            -> heading hold ('auto')
      //    wind field + route loaded -> route-follow ('route')
      //    wind field + no route     -> wind hold ('wind')
      // Caveat: wind hold with a route left loaded on the plotter reads as 'route' — the bus
      // gives nothing to tell those two apart (see findings / #41).
      engaged = true
      if (windHits >= WIND_MIN) {
        state = routeActive ? 'route' : 'wind'
        target = routeActive ? trackedTarget : trackedWind
      } else {
        state = 'auto'; target = trackedTarget
      }
    } else {
      engaged = false; state = 'standby'
    }
    // trackedTarget/trackedWind lifecycle is driven by setState/adjustTarget (commands), not by
    // the detected state, so the engage transient doesn't wipe it.

    const changed = state !== status.state
    if (changed) app.debug('Garmin AP state -> %s (eng=%d wind=%d route=%s)', state, engHits, windHits, routeActive)
    // mode is intentionally null: SignalK splits state (engagement) from mode (steering
    // sub-mode), but the Reactor exposes everything through state and we define no separate
    // modes, so publishing mode would only duplicate state.
    status.state = state; status.mode = null; status.engaged = engaged; status.target = target
    if (typeof app.autopilotUpdate === 'function') {
      try { app.autopilotUpdate(apType, { state, mode: null, engaged, target }) } catch (e) { if (changed) app.debug('autopilotUpdate failed: ' + e.message) }
    }
  }

  // ---- Rudder jog / auto-center (EXPERIMENTAL — drives the rudder) ----
  // steering.rudderAngle is published to SignalK from the bus; read it back as feedback.
  function rudderDeg () {
    const v = (typeof app.getSelfPath === 'function') ? app.getSelfPath('steering.rudderAngle.value') : null
    return (typeof v === 'number' && isFinite(v)) ? v * 180 / Math.PI : null
  }
  function sleep (ms) { return new Promise((r) => setTimeout(r, ms)) }

  // Low-level drive primitives (mirror the GHC steering test):
  //   assertTest -> 05 0A 00 15  (engage drive / hold test mode)
  //   stopDrive  -> 05 0A 00 02  (standby = stop & release)
  //   jogFrame   -> 04 15 00 dir (drive one direction; the CCU keeps driving until stopped)
  function assertTest () { send(util.format(CMD.state, now(), srcAddr, ccuAddr, TEST_STATE_CODE)); inTest = true }
  function stopDrive () { send(util.format(CMD.state, now(), srcAddr, ccuAddr, STATE_CODE.standby)); inTest = false; testCooldownUntil = Date.now() + 1500 }
  function jogFrame (code) { send(util.format(JOG, now(), srcAddr, ccuAddr, code)) }

  // ---- Clutch: persistent steering-test drive ----
  // The CCU drives continuously once given a jog and only stops on standby, so to keep the
  // drive engaged we resend assertTest on a keepalive. A jog tap sets a short drive window
  // during which the keepalive emits jog frames instead of the hold; then it falls back to
  // holding. Disengage sends standby. A max-on timer is a hard safety backstop.
  // Manual NFU nudge: the CCU drives continuously once given a jog, so bound each tap —
  // engage the drive, jog for JOG_NUDGE_MS (~1.5-2 deg), then stop with standby. Self-contained.
  let nudging = false
  async function rudderJog (dir) {
    const code = JOG_CODE[dir]
    if (code === undefined) throw new Error("jog dir must be 'port' or 'starboard'")
    if (nudging || centering) { app.debug('jog busy'); return 'busy' }
    nudging = true
    try {
      assertTest()
      await sleep(450)
      jogFrame(code)
      await sleep(JOG_NUDGE_MS)
    } finally {
      stopDrive()
      nudging = false
    }
    return 'nudged ' + dir
  }

  // Closed-loop auto-center using live steering.rudderAngle feedback.
  async function centerRudder () {
    if (centering) { app.debug('centerRudder already running'); return 'busy' }
    if (rudderDeg() === null) throw new Error('no steering.rudderAngle feedback; cannot auto-center')
    centering = true
    let result = 'maxpulses'
    try {
      assertTest()
      await sleep(600)
      const startSign = Math.sign(rudderDeg() || 0)
      let code = null
      let prev = rudderDeg()
      for (let i = 0; i < JOG_MAX_PULSES; i++) {
        const cur = rudderDeg()
        if (cur === null) { result = 'no-feedback'; break }
        if (Math.abs(cur) <= CENTER_TOL_DEG) { result = 'centered'; break }
        // crossed center (sign flipped vs start) => within one step of zero, good enough
        if (startSign !== 0 && Math.sign(cur) !== startSign) { result = 'centered'; break }
        // drive toward zero: +angle needs port, -angle needs starboard
        if (code === null) code = (cur > 0) ? JOG_CODE.port : JOG_CODE.starboard
        jogFrame(code)
        await sleep(JOG_PULSE_MS)
        const after = rudderDeg()
        // safety self-correct: if |angle| grew, we're driving the wrong way -> flip
        if (after !== null && prev !== null && Math.abs(after) > Math.abs(prev) + 0.3) {
          code = (code === JOG_CODE.port) ? JOG_CODE.starboard : JOG_CODE.port
          app.debug('center: |angle| grew %s->%s, flipping dir to %s', prev.toFixed(1), after.toFixed(1), code)
        }
        prev = after
      }
    } finally {
      stopDrive()
      centering = false
    }
    const end = rudderDeg()
    app.debug('centerRudder done: %s at %s deg', result, (end === null ? '?' : end.toFixed(1)))
    return result + (end === null ? '' : ' @' + end.toFixed(1) + 'deg')
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
  function engagePattern (name, dirS) {
    const p = PATTERNS[name]
    if (!p) throw new Error('unknown pattern: ' + name)
    const dir = (dirS === 'stbd' || dirS === 'starboard' || dirS === '0' || dirS === '00') ? '00' : '01'
    if (p.sel) send(util.format(PAT_SEL, now(), srcAddr, ccuAddr, p.sel, dir))
    send(util.format(CMD.state, now(), srcAddr, ccuAddr, p.code))
    return 'pattern ' + name + (p.sel ? ' ' + (dir === '00' ? 'stbd' : 'port') : '')
  }

  // PUT endpoints so Node-RED / the API can drive the rudder (no autopilot engagement).
  //   steering.autopilot.rudder.jog     ('port'|'starboard')  -> one bounded NFU nudge (~2 deg)
  //   steering.autopilot.rudder.center  (any value)           -> closed-loop auto-center
  //   steering.autopilot.rudder.stop    (any value)           -> stop drive / standby now
  function registerPutHandlers () {
    if (typeof app.registerPutHandler !== 'function') { app.debug('registerPutHandler unavailable; rudder PUT control disabled'); return }
    const ok = (cb, r) => cb({ state: 'COMPLETED', statusCode: 200, message: String(r) })
    const fail = (cb, e) => cb({ state: 'COMPLETED', statusCode: 502, message: e.message })
    app.registerPutHandler('vessels.self', 'steering.autopilot.rudder.jog', (ctx, path, value, cb) => {
      const dir = (typeof value === 'string') ? value : (value && (value.dir || value.value))
      rudderJog(dir).then((r) => ok(cb, r)).catch((e) => fail(cb, e))
      return { state: 'PENDING' }
    })
    app.registerPutHandler('vessels.self', 'steering.autopilot.rudder.center', (ctx, path, value, cb) => {
      centerRudder().then((r) => ok(cb, r)).catch((e) => fail(cb, e))
      return { state: 'PENDING' }
    })
    app.registerPutHandler('vessels.self', 'steering.autopilot.rudder.stop', (ctx, path, value, cb) => {
      stopDrive()
      return { state: 'COMPLETED', statusCode: 200, message: 'stopped' }
    })
    // DEBUG/RE: send a raw state code (05 0A 00 <hh>) through canboatjs. value = 2-hex string.
    app.registerPutHandler('vessels.self', 'steering.autopilot.rudder.rawstate', (ctx, path, value, cb) => {
      try { const c = ('' + ((value && value.value) || value)).trim(); send(util.format(CMD.state, now(), srcAddr, ccuAddr, c)); return { state: 'COMPLETED', statusCode: 200, message: 'state ' + c } } catch (e) { return { state: 'COMPLETED', statusCode: 502, message: e.message } }
    })
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
    app.debug('PUT handlers registered (rudder jog/center/stop/rawstate, pattern, route goto/stop)')
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
