# Garmin Reactor 40 — PGN 126720 Reverse-Engineering Findings

_Boat: Buttercup. Captured live on the NMEA 2000 bus (can0, 250 kbit/s) on 2026-06-20.
Reactor 40 CCU + GHC control heads. All command encodings verified by button-press correlation;
status stream structurally decoded for the first time._

## Bus layout (this vessel)

| N2K source | Device | Role |
|---|---|---|
| 2 | Reactor 40 CCU | Autopilot computer — **receives commands**, **broadcasts status** |
| 4 | GHC head | control head / nav display |
| 5 | GHC head | control head — **active controller** during this session |
| 0 | wind instrument | wind data (130306) |
| 3 | GPS / chartplotter | position, COG/SOG, nav data |
| 6, 7 | GHC heads / displays | inter-display sync |

All autopilot traffic is **PGN 126720**, Garmin proprietary fast-packet, payload prefix
`E5 98` = manufacturer code 229 (Garmin) + Marine industry. Inside that, the autopilot
command/status group is marked by `10 17 04 04`.

## Commands (head → CCU, addressed to dst=2) — VERIFIED

Container: `E5 98 10 17 04 04 <subtype> ...`

Heads continuously send a keepalive at ~2 Hz: subtype `15 03` (`E5 98 10 17 04 04 15 03 0X 00 C8 00`),
where byte 8 differs per head (`02` from the active controller, `00` otherwise). Filter this out
to isolate real commands.

### STATE / MODE — `E5 98 10 17 04 04 05 0A 00 <code>`

The single `<code>` byte selects the autopilot mode. Full map (verified live; the
pattern codes were confirmed in power-displacement vessel mode on 2026-06-21):

| Mode | code | Notes |
|---|---|---|
| Standby (disengage) | `02` | clutch released |
| Heading hold (auto) | `05` | |
| Wind hold | `11` | sailboat; CCU then broadcasts wind-target field `00 0B` |
| Steering-test drive | `15` | engages drive and drives the rudder (see rudder section) |
| **Circles pattern** | `08` | preceded by selector `04 34 00 <dir>` |
| **Zigzag pattern** | `09` | no direction selector (single engage) |
| **Williamson turn** | `0A` | preceded by selector `04 47 00 <dir>` |
| **U-turn pattern** | `0B` | preceded by selector `04 6F 00 <dir>` |
| (engages, unidentified) | `07` | engages but no pattern selector — possibly nav/route follow; TBD |

Codes `00,01,03,04,06` and `0C`–`1F` were probed and are inert/standby. After any
engage, the active head emits a status ack `E5 98 10 17 04 04 25 02 00`.

> ⚠️ Probing unknown state codes blind once drove the rudder into a stall and tripped a
> latched drive fault (cleared by an AP power-cycle). Don't fuzz state codes near the stops.

### STEERING PATTERNS (powerboat / power-displacement mode)

Each pattern = a **selector** frame then the **engage** state frame, sent together; the
`<dir>` byte (`00`/`01`) is the Port/Starboard choice offered on the head.

| Pattern | Selector frame | Engage frame |
|---|---|---|
| Zigzag | (none) | `E5 98 10 17 04 04 05 0A 00 09` |
| Circles | `E5 98 10 17 04 04 04 34 00 <dir>` | `... 05 0A 00 08` |
| U-turn | `E5 98 10 17 04 04 04 6F 00 <dir>` | `... 05 0A 00 0B` |
| Williamson turn | `E5 98 10 17 04 04 04 47 00 <dir>` | `... 05 0A 00 0A` |

GPS-based patterns (orbit / cloverleaf / search) and follow-route not yet captured.

### POWERBOAT RUDDER STEERING — `E5 98 10 17 04 04 04 2A 00 <dir>`

Emitted by the head only in a power hull profile (planing/displacement), when the steer
keys are used while engaged ("rudder steering"). `<dir>` `00`/`01`. This is the powerboat
NFU/dodge path; not available in sailboat vessel mode. Actuation unverified — captured while
the pilot was de-commissioned (compass-cal + speed-source alerts blocked the drive).

### HEADING ADJUST — `E5 98 10 17 04 04 26 <code>`

(raw, padded: `26 <code> 00 FF FF FF FF`)

| Button | code |
|---|---|
| −1° | `00` |
| −10° | `01` |
| +1° | `02` |
| +10° | `03` |

Scheme: low bit = step size (small/large), high bit = direction (−/+). On jorgen-k's GHC-20 the
large step was labeled ±15°; the **code is identical** (`01`/`03`) — the degrees come from the
head's configured increment, not the wire code. So our ±10 confirms and generalizes his ±15.

These match and extend the only prior public artifact (jorgen-k/signalk-autopilot-garmin),
now verified on Reactor 40 hardware.

## Status broadcast (CCU source 2 → 255) — NEW (nobody had decoded any of this)

The CCU broadcasts PGN 126720 at ~24 Hz. It is **not** a single mode enum; it is a stream of
**field sub-messages** in the `10 17 04 04` family:

`E5 98 10 17 04 04 <field-id> <type/len> 0A <little-endian value...> ...`

byte 6 = field id, byte 7 = type/length selector. Values are little-endian ints/IEEE-754 floats
(heading, rudder, gains, wind angle, etc.). There are also two other message types from the CCU:
`6C 07 02 02 ...` (low-rate summary) and head broadcasts `E7 08 0A 0A ...`.

### Mode is encoded structurally — reliable discriminators found

- **Wind mode** → the CCU emits a dedicated field `00 0B`:
  `E5 98 10 17 04 04 00 0B 00 <LE float>`, value ≈ `3F 95…` = ~1.16 rad ≈ **67° apparent wind angle being held**.
  This field is **absent** in standby/heading. Presence ⇒ wind mode; value ⇒ target wind angle.
  Verified: 159–160 frames in wind, 0 in standby (confirmed live on disengage → 0).
- **Engaged vs standby** → the `6C 07 02 02 01 00` summary carries two LE floats; the second reads
  ≈ **35.0 in standby → 38.5 when engaged**. Engaged-only fields `00 A2`, `02 9E`, `02 74` also appear.

### Still to confirm (next session, boat stationary)

Dock swing drifts heading/wind, which jitters the telemetry bytes and confounds a clean per-byte
diff. A controlled standby→heading→wind→standby cycle with continuous capture will (a) lock down the
mode readback, and (b) map the remaining field-ids to heading / rudder angle / target heading so the
plugin can publish full `steering.autopilot.*` (state, target.headingMagnetic, target.windAngleApparent).

## Rudder NFU jog + auto-center — NEW (2026-06-20, verified live)

The Reactor has no public way to move the rudder without engaging heading/wind hold.
Decoded the **steering-test drive mode** from the GHC's "steering-direction test"
(captured src5 → CCU2), and drove the rudder under software control for the first time.
All three commands are the same `E5 98 10 17 04 04` family:

| Action | bytes | notes |
|---|---|---|
| Enter steering-test (engages drive/clutch) | `05 0A 00 15` | a STATE command, **new code 15** |
| Jog rudder one step | `04 15 00 <dir>` | `00` = starboard / +angle, `01` = port / −angle |
| Exit → standby | `05 0A 00 02` | normal standby code |

Measured **~1.8° per jog pulse**. The CCU **ignores raw `cansend` injection** of these —
they are only honoured when sent through SignalK's registered N2K device (canboatjs),
the same path the state/heading commands use. Once in test mode the clutch emits the
same engaged-markers as heading-hold, so the status decoder suppresses mode inference
while a jog/center run is active (and ~3.5 s after, while the drive disengages).

Closed-loop **auto-center** (`centerRudder()`): enter test mode, read
`steering.rudderAngle`, jog toward zero, self-correct direction if |angle| grows,
stop within ~2° (one step) with a cross-zero backstop, exit to standby. A 6 s idle
watchdog force-exits if jogging stalls. Verified: centered from ±24° to within 2°,
AP status stayed `standby` throughout. Exposed as SignalK PUT paths
`steering.autopilot.rudder.{center,jog,stop}` and as a **Rudder** group on the
Node-RED autopilot dashboard (CENTER RUDDER / JOG PORT / JOG STBD).

## Artifacts (preserved on the Pi)

`~/dev/signalk-autopilot-provider-garmin/re/`
- `captures/cap_*.log` — raw candump for baseline, each button press, and each steady mode
- `apre.py` — fast-packet reassembler + `catalog`/`diff`
- `apcap.sh` — per-button capture+diff helper
- `status*.py` — status-stream field analyzers

## Contribution plan

1. Open a Garmin-specific canboat issue (none exists) with an annotated visual-analyzer recording +
   the command table above + the status-stream structure.
2. Once the status field-ids are confirmed, PR canboat PGN definitions (follow the #633 pattern).
3. Upstream verified commands + status decode into jorgen-k's plugin and/or finish the V2 provider.

Thanks to Jörgen Karlsson (jorgen-k) for the original command encodings, and to Kees Verruijt
(canboat) and Scott Bender (signalk-autopilot) for the tooling and methodology.
