# signalk-autopilot-provider-garmin

A **Signal K v2 Autopilot Provider** for **Garmin Reactor** autopilots over NMEA 2000.

It registers with the Signal K server's built-in Autopilot API (`registerAutopilotProvider`),
so the server owns the REST API, auth, the `steering.autopilot.*` (v1+v2) deltas, and the UI.
This plugin only translates those calls to/from Garmin's proprietary **PGN 126720**.

> Status: **early / alpha scaffold.** Commands are ported from prior work and need
> re-verification on our hardware; live status decode is not done yet (see below).

## Hardware (Buttercup)
- Reactor 40 CCU (Product Info model `Reactor 40`, SW 10.10) — N2K source addr 2
- GHC control head
- GND 10 gateway (addr 0), GPS 24xd (addr 3)

## What works / what doesn't

| Capability | Status |
|---|---|
| Engage / disengage (auto / standby) | Command bytes ported from jorgen-k plugin — **needs re-verify on our Reactor** |
| Mode: wind | Ported — needs re-verify |
| Mode: route/nav | **Unknown command** — TODO capture |
| Heading nudge ±1 / ±15° | Ported — needs re-verify (real increment may be ±1/±10) |
| Set absolute target heading | Not supported by any known Garmin PGN — TODO |
| Tack / gybe / dodge | Not implemented |
| **Read live state/mode/target (status)** | **Not decoded by anyone yet** — skeleton parser in `garmin_pilot.js`, to be filled from dock captures |

Until status decode lands, `getData()` returns nulls and the UI shows no live pilot state.

## Architecture
- `index.js` — registers the v2 provider; maps API methods to the device module.
- `garmin_pilot.js` — Garmin device logic: command encodings (PGN 126720 → CCU),
  CCU auto-discovery (matches `Reactor` in Product Info), and the `onStreamEvent`
  **status-decode skeleton** (parses the CCU's 126720 broadcasts; currently logs only).

### Command encoding (PGN 126720 → CCU)
Container `E5 98` (Garmin/Marine) + `10 17 04 04` (Reactor AP group) + a selector:
- Heading change: selector `26`, code `02`=+1, `03`=+15, `00`=−1, `01`=−15
- Set state: selector `05 0A`, code `05`=auto, `02`=standby, `11`=wind

(Ported verbatim from `jorgen-k/signalk-autopilot-garmin`; treat as hypotheses until re-verified.)

## Path to a working plugin
1. Dock/clutch-disengaged correlation captures on Buttercup (baseline + one GHC action per capture).
2. Diff with our `apre.py` to (a) confirm/correct the command bytes above and
   (b) decode the CCU's broadcast 126720 → fill `onStreamEvent` (state/mode/target).
3. Push the 126720 field decode to **canboat**; align the provider interface with the
   Signal K maintainers.

## Install (dev)
Symlink/copy into your Signal K server's `node_modules`, enable in the plugin config,
set the CCU address (auto-discovery attempts to find `Reactor 40`).

## Credits / license
- Provider structure: Signal K autopilot provider template (panaaj / SignalK).
- Command bytes: `jorgen-k/signalk-autopilot-garmin` (Apache-2.0).
- 126720 status decode + verification: Buttercup project.

Licensed under Apache-2.0.
