# homebridge-unifi-access-garage

Exposes UniFi Access doors that are wired to garage openers as proper HomeKit
`GarageDoorOpener` accessories, driven by the hub's door position sensor.

## Why

The official UniFi Access plugin exposes a `GarageDoorOpener` but does not track
door position. HomeKit only acts when `TargetDoorState` **changes** - so once the
target is stuck at OPEN and the current state never catches up, tapping Open again
is a no-op and the command is silently swallowed. The symptom is *"it takes several
taps before the door moves"*, while the same door operates reliably from the UniFi
Access app.

This plugin:

- drives `CurrentDoorState` from `door_position_status` (the DPS on the hub)
- pulses the relay on **every** target write, never conditioned on perceived state
- models `OPENING` / `CLOSING` with a travel timer that yields to the sensor
- picks up manual operation (wall button, car remote) by polling, so HomeKit and
  reality stay in step

## Requirements

- A UniFi Access door whose hub has both a **lock relay** wired to the opener's
  trigger terminals and a **door position sensor**. Check with:

      curl -sk -H "Authorization: Bearer $TOKEN" \
        https://<host>:12445/api/v1/developer/doors | jq '.data'

  A door reporting `"door_position_status": "none"` has no sensor; this plugin will
  fall back to timer-only state and log a warning.

- An **Access API token**, created in UniFi Access under
  *Settings → General → API Token*. This is **not** the same thing as a UniFi OS
  API key from the Integrations page - those are rejected by this API.

  Grant least privilege. `Locations: Edit`, `Device: View`, `API Server: View`, and
  `None` for everything else. In particular do not grant `Credentials`.

## Status

This plugin is **not published to npm and not Homebridge-verified**, and that is
deliberate. Verification requires that a plugin not "offer the same nor less
functionality than that of any existing verified plugin", and
[`homebridge-unifi-access`](https://github.com/hjdhjd/homebridge-unifi-access) is
verified and covers all of UniFi Access. This plugin does one thing that plugin
currently does not do well, rather than replacing it. The right long-term
outcome is the fix landing upstream.

Install it from this repository.

## Install

    sudo env PATH="/opt/homebridge/bin:$PATH" npm install --prefix /var/lib/homebridge \
      --save --no-audit --no-fund \
      github:09kleinkd/homebridge-unifi-access-garage
    sudo chown -R homebridge:homebridge /var/lib/homebridge/node_modules/homebridge-unifi-access-garage
    sudo hb-service restart

The `sudo env PATH=...` wrapper is needed because `sudo` resets `PATH` and root
will not otherwise find the Homebridge-bundled node.

### Do not install from a working directory

`npm install <directory>` does **not** copy the package. npm records a `file:`
dependency and drops a **symlink** into `node_modules` pointing at the source. If
that source is somewhere transient - `/tmp`, a build directory you later delete -
the plugin vanishes on the next reboot while `package.json`, `ls`, and the
Homebridge UI all continue to report it as installed. The only honest signal is a
line in the log reading `No plugin was found for the platform "UniFiAccessGarage"`.

Diagnose with `ls -ld /var/lib/homebridge/node_modules/homebridge-unifi-access-garage`
- you want a `d`, not an `l`. Install from this repo, or from a tarball produced
by `npm pack`, and the problem does not arise.

## Testing

    npm test

Runs the state machine against stubbed HAP and Access APIs - no console and no
real door required. Covers a stuck door, normal travel, late arrival, the
sensorless fallback, manual operation, poll failure and recovery, and superseded
commands.

## Config

```json
{
  "platform": "UniFiAccessGarage",
  "name": "UniFi Access Garage",
  "host": "192.168.1.10",
  "port": 12445,
  "token": "YOUR_ACCESS_API_TOKEN",
  "rejectUnauthorized": false,
  "pollInterval": 5,
  "travelSeconds": 12,
  "unlockMethod": "PUT",
  "testMode": false,
  "doors": [
    { "name": "Left Garage", "id": "11111111-2222-3333-4444-555555555555" },
    { "name": "Right Garage", "id": "66666666-7777-8888-9999-aaaaaaaaaaaa" }
  ]
}
```

### First run

Set `"testMode": true` initially. The plugin will log the exact request it *would*
send without sending it:

    testMode: would send PUT https://192.168.1.10:12445/api/v1/developer/doors/<id>/unlock

Confirm that matches your Access API documentation, then set `testMode` to `false`.
Verifying the endpoint before it can move a physical door is worth the extra restart.

If unlock returns HTTP 405, switch `unlockMethod` to `POST`. If it returns 403, the
token is missing `Locations: Edit`.

## Notes

- Most garage openers use a single momentary contact that **toggles**. Open and
  Close therefore send the identical unlock pulse; direction comes from the door's
  current position, not from the command.
- `travelSeconds` is a fallback only. When the sensor reports, it wins immediately.
  Set it comfortably above real travel time - 12 seconds for a 5-8 second door.
- When the travel window elapses without the sensor settling, the plugin takes a
  **fresh reading** and reports the door's actual position rather than assuming it
  arrived. A door that was told to open but never moved stays CLOSED in HomeKit,
  with a warning in the log, so open-triggered automations do not fire on a door
  that is still shut. Only a door with no position sensor at all
  (`door_position_status: "none"`) falls back to assuming the command succeeded.
- Loss of contact with the console is logged at **warn** level on the first
  failure and again on recovery, with repeats demoted to debug. A stale API token
  shows up as `HTTP 401` there. Without this the doors simply stop tracking and
  nothing says why.
- Obstruction detection is always reported as `false`; UniFi Access exposes no such
  signal.
- The token can open your doors. Treat the Homebridge config as a secret, and give
  this plugin its own token so it can be revoked independently.
