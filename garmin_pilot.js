'use strict'

/*
 * Garmin Reactor autopilot — device logic for the Signal K v2 provider.
 *
 * PROVEN vs HYPOTHESIS:
 *  - Commands (PGN 126720 -> CCU): ported verbatim from
 *    jorgen-k/signalk-autopilot-garmin (Apache-2.0), reported working on a
 *    Reactor 40 + GHC-20. Covers state auto/standby/wind and heading nudge +-1/+-15.
 *    >>> Re-verify on Buttercup's Reactor 40 (SW 10.10) before trusting. <<<
 *  - Status decode (reading mode/target/engaged from the CCU's 126720 broadcasts)
 *    is NOT yet reverse engineered by anyone. onStreamEvent() below is a SKELETON
 *    with documented byte hypotheses, to be filled from dock correlation captures.
 *    Until then getData() returns nulls.
 */

const apType = 'garminReactor'

// Reactor CCU advertises model "Reactor 40" in PGN 126996 (Product Info).
const AP_DISCOVERY_TEXT = 'Reactor'

// Commands: PGN 126720 addressed to the CCU. canboat "plain" wire format emitted
// via 'nmea2000out':  <ISO8601>,<prio>,<pgn>,<src>,<dst>,<len>,<byte>,<byte>,...
// %s placeholders, in order: timestamp, src, dst, code.
// Container: E5 98 = Garmin(229)+Marine; 10 17 04 04 = Reactor AP data group; then
// a command selector. Ported verbatim from jorgen-k/signalk-autopilot-garmin.
const CMD = {
  // selector 26 = relative heading change
  heading: '%s,7,126720,%s,%s,09,E5,98,10,17,04,04,26,%s,00,FF,FF,FF,FF',
  // selector 05,0A = set state
  state:   '%s,7,126720,%s,%s,0B,E5,98,10,17,04,04,05,0A,00,%s,00,FF,FF'
}

// degrees -> code. NOTE: jorgen labelled the big step '15'; the Reactor/GHC big
// step may actually be 10 deg. Confirm the real increment from captures.
const HEADING_CODE = { '1': '02', '15': '03', '-1': '00', '-15': '01' }
const STATE_CODE = { auto: '05', standby: '02', wind: '11' }

const AP_OPTIONS = {
  states: [
    { name: 'auto', engaged: true },
    { name: 'wind', engaged: true },
    { name: 'route', engaged: true },     // command not yet known (TODO capture)
    { name: 'standby', engaged: false }
  ],
  modes: []
}

const util = require('util')

module.exports = function (app) {
  const status = { state: null, mode: null, engaged: null, target: null }

  let srcAddr = '3'      // address this plugin transmits from (configurable)
  let ccuAddr = null     // discovered Reactor CCU N2K source address (e.g. '2')
  let discovered = false

  const pilot = { id: null, type: apType }

  pilot.start = (props) => {
    props = props || {}
    srcAddr = props.srcAddr || srcAddr
    ccuAddr = props.ccuAddr || ccuAddr
    app.debug('Garmin Reactor provider start. srcAddr=%s ccuAddr=%s', srcAddr, ccuAddr)
    app.on('N2KAnalyzerOut', onStreamEvent)
  }

  pilot.stop = () => {
    try { app.removeListener('N2KAnalyzerOut', onStreamEvent) } catch (e) {}
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

  // ---- Status decode (SKELETON — fill from dock captures) ----
  // The CCU broadcasts PGN 126720 with the same Garmin container we send commands in:
  //   [E5 98] 10 17 04 04 <subtype> <...>
  // canboat does not yet decode Garmin AP 126720, so we parse raw bytes ourselves.
  // The exact evt shape (whether E5 98 is included, where Data lives) must be
  // confirmed from live decoded output on Buttercup — hence the marker search.
  const onStreamEvent = (evt) => {
    if (!evt || evt.pgn !== 126720) return
    if (ccuAddr !== null && String(evt.src) !== String(ccuAddr)) return
    const bytes = rawBytes(evt)
    if (!bytes) return
    const m = findMarker(bytes)           // index of [10 17 04 04]
    if (m === -1) return
    const subtype = bytes[m + 4]
    // TODO(capture): map subtype + following bytes to state/mode/target.
    // Hypotheses to confirm with baseline + per-button diffs:
    //   - a state/mode subtype whose byte encodes standby/auto/wind/route
    //   - a target-heading subtype carrying a 16-bit angle (likely rad*1e4, LE)
    //   - keepalive/heartbeat subtype(s) to ignore
    app.debug('126720 CCU subtype=0x%s raw=%s', (subtype || 0).toString(16), hex(bytes))
    // When decoded, publish e.g.:
    //   status.state = ...; status.engaged = ...
    //   app.autopilotUpdate(apType, 'state', status.state)
    //   app.autopilotUpdate(apType, 'engaged', status.engaged)
    //   app.autopilotUpdate(apType, 'target', angleRad)
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
    const sz = Math.abs(deg) >= 8 ? 15 : 1   // big vs small step; refine after verifying real increment
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
  function hex (arr) { return arr.map((x) => ('0' + (x & 0xff).toString(16)).slice(-2)).join(' ') }

  return pilot
}
