'use strict'

/*
 * Garmin Reactor autopilot — device logic for the Signal K v2 provider.
 *
 * STATUS (verified live on Buttercup's Reactor 40, 2026-06-20):
 *  - Commands (PGN 126720 -> CCU) CONFIRMED by button-press correlation:
 *      state set:  E5 98 10 17 04 04 05 0A 00 <code>   standby=02 auto=05 wind=11
 *      heading nudge: E5 98 10 17 04 04 26 <code>      -1=00 -10=01 +1=02 +10=03
 *    (jorgen-k labelled the big step "15"; on the Reactor 40 / GHC the wire code
 *     is identical, the degrees come from the head's configured increment.)
 *  - Status read-back DECODED from the CCU's own 126720 broadcasts (src=2):
 *    the CCU emits "field" sub-messages  E5 98 10 17 04 04 <fid_hi> <fid_lo> ...
 *    Mode is conveyed by which fields are present:
 *      field 00 0B  -> WIND mode; payload carries target apparent wind angle
 *                      as a little-endian float32 (radians) at marker+7.
 *      fields 00 A2 / 02 74 / 00 72  -> present only when ENGAGED (auto or wind),
 *                      absent in standby. Used as the engaged/standby discriminator.
 *    => no 00 0B and no engaged-markers  => STANDBY.
 *    Target HEADING field is not yet isolated (needs a stationary capture); until
 *    then target is published only in wind mode.
 */

const apType = 'garminReactor'

// Reactor CCU advertises model "Reactor 40" in PGN 126996 (Product Info).
const AP_DISCOVERY_TEXT = 'Reactor'

// Commands: PGN 126720 addressed to the CCU. canboat "plain" wire format emitted
// via 'nmea2000out':  <ISO8601>,<prio>,<pgn>,<src>,<dst>,<len>,<byte>,<byte>,...
const CMD = {
  // selector 26 = relative heading change
  heading: '%s,7,126720,%s,%s,09,E5,98,10,17,04,04,26,%s,00,FF,FF,FF,FF',
  // selector 05,0A = set state
  state:   '%s,7,126720,%s,%s,0B,E5,98,10,17,04,04,05,0A,00,%s,00,FF,FF'
}

// degrees -> code. Verified on Reactor 40: small step (+-1) and big step (the GHC
// big-step button, 10 deg on Buttercup). Both 10 and 15 map to the big-step code.
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
const WIND_FID = [0x00, 0x0B]                                  // wind-mode field (+ target wind angle)
const ENGAGED_FIDS = [[0x00, 0xA2], [0x02, 0x74], [0x00, 0x72]] // present only when engaged
const WIND_WINDOW_MS = 2000      // wind field is high-rate; recent presence => wind
const ENGAGED_WINDOW_MS = 4000   // engaged markers are ~1 Hz
const WIND_MIN = 3               // min hits in window to assert wind
const ENGAGED_MIN = 2            // min hits in window to assert engaged (reject strays)
const EVAL_MS = 1000

const util = require('util')

module.exports = function (app) {
  const status = { state: null, mode: null, engaged: null, target: null }

  let srcAddr = '3'      // address this plugin transmits from (configurable)
  let ccuAddr = null     // discovered Reactor CCU N2K source address (e.g. '2')
  let discovered = false

  const seen = new Map()      // 'hi:lo' -> [timestamps ms]
  let lastWindAngle = null    // radians, from the 00 0B field
  let evalTimer = null

  const pilot = { id: null, type: apType }

  pilot.start = (props) => {
    props = props || {}
    srcAddr = props.srcAddr || srcAddr
    ccuAddr = props.ccuAddr || ccuAddr
    app.debug('Garmin Reactor provider start. srcAddr=%s ccuAddr=%s', srcAddr, ccuAddr)
    app.on('N2KAnalyzerOut', onStreamEvent)
    evalTimer = setInterval(evaluate, EVAL_MS)
  }

  pilot.stop = () => {
    try { app.removeListener('N2KAnalyzerOut', onStreamEvent) } catch (e) {}
    if (evalTimer) { clearInterval(evalTimer); evalTimer = null }
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
    if (code === undefined) {
      throw new Error('Unsupported state: ' + value + ' (known: auto, standby, wind)')
    }
    send(util.format(CMD.state, now(), srcAddr, ccuAddr, code))
    status.state = value
    status.engaged = (value !== 'standby')
    return status.engaged
  }

  pilot.engage = () => pilot.setState('auto')
  pilot.disengage = () => pilot.setState('standby')
  pilot.setMode = (mode) => pilot.setState(mode)

  // API passes a delta in RADIANS. Garmin accepts discrete nudges only; quantize.
  pilot.adjustTarget = (value) => {
    if (!status.engaged) app.debug('adjustTarget while not engaged; sending anyway')
    const step = quantizeStep(radToDeg(value))
    const code = HEADING_CODE[step]
    if (code === undefined) throw new Error('Cannot map adjustment to a Garmin step')
    send(util.format(CMD.heading, now(), srcAddr, ccuAddr, code))
  }

  pilot.setTarget = () => {
    throw new Error('setTarget not implemented (no known Garmin absolute-heading PGN); use adjustTarget')
  }
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
                ccuAddr = String(addr)
                discovered = true
                app.debug('Discovered Garmin Reactor CCU at N2K addr ' + ccuAddr)
              }
            })
          }
        })
      }
    }
    const desc = discovered
      ? 'Discovered Reactor CCU at N2K address ' + ccuAddr
      : 'Reactor not auto-discovered; set the CCU address manually.'
    pilot.id = ccuAddr
    return {
      properties: {
        ccuAddr: { type: 'string', title: 'Garmin Reactor CCU NMEA2000 address', description: desc, default: ccuAddr || '2' },
        srcAddr: { type: 'string', title: 'Source address this plugin transmits from', description: 'Use a free N2K address.', default: srcAddr }
      }
    }
  }

  // ---- Status decode (VERIFIED structure; see header) ----
  const onStreamEvent = (evt) => {
    if (!evt || evt.pgn !== 126720) return
    if (ccuAddr !== null && String(evt.src) !== String(ccuAddr)) return
    const bytes = rawBytes(evt)
    if (!bytes) return
    const m = findMarker(bytes)           // index of [10 17 04 04]
    if (m === -1 || m + 5 >= bytes.length) return
    const fhi = bytes[m + 4]
    const flo = bytes[m + 5]
    const key = fhi + ':' + flo
    const arr = seen.get(key) || []
    arr.push(Date.now())
    seen.set(key, arr)
    // wind-mode field also carries the target apparent wind angle (LE float32, rad)
    if (fhi === WIND_FID[0] && flo === WIND_FID[1] && m + 10 < bytes.length) {
      const f = readFloatLE(bytes, m + 7)
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
    if (windHits >= WIND_MIN) {
      state = 'wind'; mode = 'wind'; engaged = true; target = lastWindAngle
    } else if (engHits >= ENGAGED_MIN) {
      state = 'auto'; mode = 'auto'; engaged = true
    } else {
      state = 'standby'; mode = 'standby'; engaged = false
    }

    const changed = state !== status.state
    if (changed) app.debug('Garmin AP state -> %s (wind=%d eng=%d)', state, windHits, engHits)
    status.state = state; status.mode = mode; status.engaged = engaged; status.target = target
    if (typeof app.autopilotUpdate === 'function') {
      try {
        app.autopilotUpdate(apType, { state, mode, engaged, target })
      } catch (e) { if (changed) app.debug('autopilotUpdate failed: ' + e.message) }
    }
  }

  // ---- helpers ----
  function send (msg) {
    if (ccuAddr === null) { app.debug('no CCU address; not sending: ' + msg); return }
    app.debug('nmea2000out: ' + msg)
    app.emit('nmea2000out', msg)
  }
  function now () { return new Date().toISOString() }
  function radToDeg (r) { return (typeof r === 'number' ? r : 0) * 180 / Math.PI }
  function quantizeStep (deg) {
    const sz = Math.abs(deg) >= 6 ? 10 : 1   // big-step button is 10 deg on the GHC
    return (deg < 0 ? '-' : '') + sz
  }
  function rawBytes (evt) {
    let d = (evt.fields && (evt.fields.Data || evt.fields.data)) || evt.data || evt.input
    if (Array.isArray(d)) return d.map((x) => (typeof x === 'string' ? parseInt(x, 16) : x))
    if (typeof d === 'string') return d.trim().split(/[\s,]+/).map((x) => parseInt(x, 16))
    if (Buffer.isBuffer(d)) return Array.from(d)
    return null
  }
  function findMarker (b) {
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] === 0x10 && b[i + 1] === 0x17 && b[i + 2] === 0x04 && b[i + 3] === 0x04) return i
    }
    return -1
  }
  function readFloatLE (b, off) {
    if (off + 3 >= b.length) return null
    const buf = Buffer.from([b[off], b[off + 1], b[off + 2], b[off + 3]])
    return buf.readFloatLE(0)
  }
  function hex (arr) { return arr.map((x) => ('0' + (x & 0xff).toString(16)).slice(-2)).join(' ') }

  return pilot
}
