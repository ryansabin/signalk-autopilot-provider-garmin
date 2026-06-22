# Node-RED control dashboard

A reference **Node-RED Dashboard 2.0** page for driving this plugin — modes, course/wind adjust,
tack/gybe, steering patterns, and a live status readout. Optional; the plugin works fine without it
(the Signal K Autopilot API and any v2 autopilot UI can drive it too).

`autopilot-dashboard.flows.json` is an importable Node-RED flow export.

![groups: Heading & Target, Wind, Status, Mode, Course Adjust, Sailing (tack/gybe), Powerboat Patterns, GPS Patterns]

## Requirements
- Node-RED with **[@flowfuse/node-red-dashboard](https://flows.nodered.org/node/@flowfuse/node-red-dashboard)** (Dashboard 2.0)
- **[@signalk/node-red-embedded](https://www.npmjs.com/package/@signalk/node-red-embedded)** — provides the `signalk-subscribe` nodes used for the live readouts
- The `signalk-autopilot-provider-garmin` plugin enabled on the same Signal K server

## Install
1. In Node-RED: **menu → Import**, paste the contents of `autopilot-dashboard.flows.json`, and deploy.
2. **Set your Signal K token.** Three function nodes — *build request*, *build pattern request*,
   *build tack/gybe request* — contain:
   ```js
   const TOK='Bearer REPLACE_WITH_YOUR_SIGNALK_TOKEN';
   ```
   Replace `REPLACE_WITH_YOUR_SIGNALK_TOKEN` with a Signal K access token (Signal K → Security →
   Access Requests / Devices, or a personal token). All three must match.
3. **Assign the page to your dashboard.** The imported `ui-page` references a Dashboard 2.0 UI base
   and theme that aren't included in the export — open the page config and pick (or create) your own
   UI base + theme, then deploy.
4. If Node-RED is **not** on the same host as Signal K, change the `http://localhost/...` base URLs
   in the three function nodes to your server's address.

## What it calls
- **v2 autopilot API** for the standard ops: `…/autopilots/garminReactor/state`, `/target/adjust`,
  `/tack/{dir}`, `/gybe/{dir}`
- **v1 PUT** for the Garmin-specific steering patterns: `steering.autopilot.rudder.pattern`
  (value `"<name>:<dir>"`, e.g. `circles:stbd`)

> Note: button widths/layout are tuned for the author's helm display — adjust group/button sizes to
> taste for your screen.
