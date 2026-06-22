# signalk-autopilot-provider-garmin

A **Signal K v2 Autopilot Provider** for **Garmin Reactor** autopilots over NMEA 2000.

It registers with the Signal K server's built-in Autopilot API (`registerAutopilotProvider`),
so the server owns the REST API, auth, the `steering.autopilot.*` (v1 + v2) deltas, and the UI.
This plugin translates those calls to/from Garmin's proprietary **PGN 126720**, and decodes the
CCU's broadcast of the same PGN back into live `state` / `engaged` / `target`.

> Status: **working, verified live underway** on a Reactor 40. Garmin's autopilot runs entirely
> over PGN 126720, which had not been publicly decoded — the command **and** status protocols here
> were reverse-engineered from live bus captures. See [`re/garmin-reactor-126720-findings.md`](re/garmin-reactor-126720-findings.md)
> for the full writeup.

## Hardware (reference vessel: *Buttercup*)
- Reactor 40 CCU — N2K source address 2
- GHC control head (source 5) — sends the hold-mode commands
- GPSMAP chartplotter (source 4) — sends the route/Go-To command + nav PGNs
- Wind instrument, GPS, NMEA 2000 backbone @ 250 kbit/s

## What works (all verified live)

| Capability | Notes |
|---|---|
| Engage / standby | `state` = `auto` / `standby` |
| Heading hold | hold current compass heading |
| Apparent wind hold | hold current apparent wind angle |
| Target adjust ±1 / ±10° | heading **or** wind angle, context-dependent |
| **Live readback of head-unit changes** | mode + target track what you do on the GHC/plotter, not just commands from this plugin |
| Tack & gybe | one V2 call each; **auto-picks the correct turn direction from the apparent wind** |
| Powerboat patterns | zigzag, circles, U-turn, Williamson (+ time / amplitude params) |
| GPS patterns | orbit, cloverleaf, search (require an active route on the plotter) |
| Route / Go-To follow | nav-follow engage (see limitations re: nav-source arbitration) |
| Live status | `state`, `engaged`, `target` published to `steering.autopilot.*` |

### How the mode is known
The CCU **never broadcasts its own discrete mode**. Instead, every controller (GHC, chartplotter,
or this plugin) sets the mode with a command on the bus, and the plugin watches those:

```
E5 98 10 17 04 04 05 0A 00 <code>   02=standby 05=heading 11=wind 0D=route  08/09/0A/0B/0E/0F/10=patterns
```

So `state` is correct regardless of which device engaged the mode. Engaged-vs-standby comes from the
CCU's broadcast markers (`00 A2` / `02 74` / `00 72` at ~2 Hz). The desired heading/wind `target` is
reconstructed from the bus target-adjust steps (`26 <code>`) seeded from the sensor value at engage —
because the CCU does not broadcast the target either.

## API

Standard Signal K **v2** autopilot endpoints (`/signalk/v2/api/vessels/self/autopilots/garminReactor/…`):
`state` (auto/wind/standby), `target/adjust`, `engage` / `disengage`, `tack/{port|starboard}`,
`gybe/{port|starboard}`.

Garmin-specific operations the v2 standard doesn't cover are exposed as **v1 PUT** paths:
- `steering.autopilot.rudder.pattern` — value `"<name>:<dir>"`, e.g. `circles:stbd`, `uturn:port`,
  `williamson:stbd`, `orbit:port`, `cloverleaf:stbd`, `search:port`, `zigzag`, `tack`, `gybe`
- `steering.autopilot.route.goto` — value `"lat,lon"` (drive a waypoint from the plugin side)
- `steering.autopilot.route.stop`

## Protocol summary (PGN 126720)

Container: `E5 98` (Garmin / Marine) + `10 17 04 04` (Reactor AP group), then:

| Operation | Bytes |
|---|---|
| Set state / mode | `05 0A 00 <code>` — `02` standby, `05` heading, `11` wind, `0D` route, `13` tack/gybe, patterns below |
| Target adjust | `26 <code>` — `00` −1°, `01` −10°, `02` +1°, `03` +10° |
| Pattern selector | `04 <sel> 00 <dir>` — circles `34`, U-turn `6F`, Williamson `47`, orbit `5B`, cloverleaf `3E`, search `65`, tack/gybe `A2`; `dir` `00`=stbd turn, `01`=port turn |
| Controller keepalive | `15 03 0X 00 C8 00` (~2 Hz; required to be accepted as a controller) |

Commands must be sent through the Signal K server's NMEA 2000 output (canboatjs); the CCU ignores raw
`cansend` injection. Full field-level decode is in the findings doc.

## Architecture
- `index.js` — registers the v2 provider and maps API methods to the device module.
- `garmin_pilot.js` — Garmin device logic: command encodings, CCU auto-discovery (matches `Reactor`
  in Product Info), a direct `can0` reader (via `candump`) that reassembles the CCU's fast-packet
  126720 broadcasts, the bus mode-set / target-adjust command watch, and the v1 PUT handlers for
  patterns + route.

## Install
```
cd ~/.signalk/node_modules        # or your server's plugin dir
npm install signalk-autopilot-provider-garmin
# or symlink a checkout for development
```
Enable in the Signal K plugin config; the CCU address is auto-discovered (override available).
A Node-RED **Dashboard 2.0** control page is included in the reference setup (modes, target adjust,
tack/gybe, patterns, live status).

## Known limitations
- **Target / mode are inferred, not read.** The CCU doesn't broadcast them. `state` is exact (from the
  command stream); `target` is reconstructed from adjust steps and can drift a degree over a long
  session — re-engaging the mode resyncs it.
- **Plugin-side route follow** (`route.goto`) is blocked while the chartplotter is the CCU's bonded
  nav source; route-follow engaged from the plotter works and is reported correctly.
- Powerboat patterns require the appropriate vessel hull profile; GPS patterns require an active route
  on the plotter.

## Credits / license
- Provider structure: Signal K autopilot provider template (panaaj / SignalK).
- Original command bytes: [`jorgen-k/signalk-autopilot-garmin`](https://github.com/jorgen-k/signalk-autopilot-garmin) (Apache-2.0).
- Full PGN 126720 command + status reverse engineering and live verification: Buttercup project.
- Tooling: canboat, signalk-autopilot.

Licensed under Apache-2.0.
