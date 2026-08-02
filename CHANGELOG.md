# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-08-02

### Changed

- **Travel timeout now reports the truth instead of assuming.** When the travel
  window elapses without the position sensor settling, the plugin takes a fresh
  reading and reports the door's actual position. Previously it assumed the door
  had arrived, so a door that failed to move would briefly report OPEN before
  the next poll corrected it - long enough to fire automations keyed on the
  garage opening. Doors with no position sensor (`door_position_status: "none"`)
  still fall back to assumption, since nothing better is available.
- **Loss of contact with the console is now visible.** Poll failures logged at
  debug level, which meant a rotated API token or an unreachable console froze
  every door with no indication why. First failure now logs at warn with the
  underlying error and an explicit note that HTTP 401 means the token is
  invalid; repeats drop to debug; recovery logs at info with the failure count.
  A persistent failure re-warns roughly hourly.

### Added

- Sequence guard so a second command issued mid-travel is not clobbered by the
  earlier command's timeout firing late.
- Timer cleanup on Homebridge shutdown.
- Test harness (`npm test`) covering the state machine with stubbed HAP and
  Access API - stuck door, normal travel, late arrival, sensorless fallback,
  manual operation, poll failure and recovery, and superseded commands.

## [1.0.0] - 2026-07-31

Initial release.

Exposes UniFi Access doors wired to garage openers as HomeKit
`GarageDoorOpener` accessories, driven by the hub's door position sensor.

The problem it solves: the official UniFi Access plugin exposes a garage door
but does not track position, so `CurrentDoorState` never catches up with
`TargetDoorState`. HomeKit only acts when the target *changes*, so once the
target latches at OPEN, tapping Open again is a no-op and the command is
silently swallowed. The symptom is a door that takes several taps to move from
the Home app while working reliably from the UniFi Access app.

- Drives `CurrentDoorState` from `door_position_status`
- Pulses the relay on **every** target write, never conditioned on state
- Models `OPENING` / `CLOSING` with a travel timer that yields to the sensor
- Picks up manual operation (wall button, car remote) by polling
