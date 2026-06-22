'use strict'

/*
 * Signal K v2 Autopilot Provider — Garmin Reactor
 *
 * Registers a device-specific provider with the Signal K server Autopilot API.
 * The server owns the REST API, auth, the steering.autopilot.* (v1+v2) deltas
 * and the UI; this plugin only translates those calls to/from the Garmin
 * proprietary NMEA 2000 protocol (PGN 126720).
 *
 * Lineage / credit:
 *  - Structure based on the Signal K autopilot provider template (panaaj).
 *  - Garmin command bytes ported from jorgen-k/signalk-autopilot-garmin (Apache-2.0).
 *  - 126720 status decode is original work (Buttercup) — see garmin_pilot.js.
 */

const apModule = require('./garmin_pilot')

module.exports = function (app) {
  const autopilot = apModule(app)

  const plugin = {
    id: 'signalk-autopilot-provider-garmin',
    name: 'Garmin Reactor Autopilot Provider',
    description: 'Signal K v2 autopilot provider for Garmin Reactor (NMEA 2000 / PGN 126720)'
  }

  plugin.start = (props) => {
    autopilot.start(props)
    registerProvider()
  }

  plugin.stop = () => {
    autopilot.stop()
    // Best-effort de-registration. The plugin-facing AutopilotProviderRegistry in current
    // server-api doesn't expose an unregister, so this is a no-op there; re-registration on the
    // next start() overwrites the entry keyed by plugin id, so duplicates aren't created.
    try { if (typeof app.unregisterAutopilotProvider === 'function') app.unregisterAutopilotProvider(plugin.id) } catch (e) { /* ignore */ }
  }

  plugin.schema = autopilot.properties

  function registerProvider () {
    app.debug('registering Garmin Reactor autopilot provider')
    try {
      app.registerAutopilotProvider(
        {
          getData:      async (deviceId) => autopilot.getData(),
          getState:     async (deviceId) => autopilot.getData().state,
          setState:     async (state, deviceId) => autopilot.setState(state),
          getMode:      async (deviceId) => autopilot.getData().mode,
          setMode:      async (mode, deviceId) => autopilot.setMode(mode),
          getTarget:    async (deviceId) => autopilot.getData().target,
          setTarget:    async (value, deviceId) => autopilot.setTarget(value),
          adjustTarget: async (value, deviceId) => autopilot.adjustTarget(value),
          engage:       async (deviceId) => autopilot.engage(),
          disengage:    async (deviceId) => autopilot.disengage(),
          tack:         async (direction, deviceId) => autopilot.tack(direction),
          gybe:         async (direction, deviceId) => autopilot.gybe(direction),
          dodge:        async (value, deviceId) => autopilot.dodge(value),
          courseCurrentPoint: async (deviceId) => autopilot.courseCurrentPoint(),
          courseNextPoint:    async (deviceId) => autopilot.courseNextPoint()
        },
        [autopilot.type]
      )
      app.debug('Garmin autopilot provider registered as: ' + autopilot.type)
    } catch (error) {
      app.error('Failed to register Garmin autopilot provider: ' + error.message)
    }
  }

  return plugin
}
