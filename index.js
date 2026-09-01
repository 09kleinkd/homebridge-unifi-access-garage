'use strict';

/**
 * homebridge-unifi-access-garage
 *
 * Exposes UniFi Access doors that are wired to garage openers as proper HomeKit
 * GarageDoorOpener accessories.
 *
 * Why this exists: the official plugin does not track door position, so
 * CurrentDoorState never catches up with TargetDoorState. HomeKit only acts when
 * TargetDoorState *changes*, so once target is stuck at OPEN, tapping Open again
 * is a no-op and the command is silently swallowed. The symptom is "it takes
 * several taps to make the door move."
 *
 * This plugin fixes that by:
 *   - driving CurrentDoorState from the hub's door position sensor (DPS)
 *   - pulsing the relay on every target write, conditioned only on a *fresh*
 *     sensor reading, never on perceived state (see v1.2.0 below)
 *   - modelling OPENING/CLOSING with a travel timer that yields to the sensor
 *   - picking up manual operation (wall button, remote) via polling
 *
 * v1.2.0
 *   - suppress the relay pulse when the position sensor has just confirmed the
 *     door is already where HomeKit is asking it to go. A single-button opener
 *     toggles, so a redundant CLOSE on a closed door *opens* it - which silently
 *     inverts a "close the garage at bedtime" automation. Suppression requires a
 *     sensor reading newer than sensorMaxAgeSeconds; with no sensor or a stale
 *     one the relay pulses exactly as before. Disable with
 *     suppressRedundantCommands: false.
 *
 * v1.3.0
 *   - a position sensor that STOPS reporting is now loud. The old sensorSeen
 *     flag was a one-way latch: a door that came up healthy could later drop to
 *     door_position_status "none" - a loose contact, a magnet off the door - and
 *     nothing was ever logged. State silently reverted to timer-based and 1.2.0's
 *     redundant-command suppression silently stopped working. Loss and recovery
 *     are now both reported.
 *   - optional "open too long" contact sensor per door, so HomeKit can notify
 *     when a door has been open past a threshold. Notifying is a safer answer to
 *     "don't leave the garage open all night" than automating a physical close,
 *     since this plugin cannot see obstructions. Off unless openAlertMinutes is
 *     set.
 *
 * v1.1.0
 *   - on travel timeout, re-read the sensor and report actual position rather
 *     than assuming the door arrived. A door that failed to move no longer
 *     flickers to OPEN before correcting, and never fires open-triggered
 *     automations.
 *   - poll failures are surfaced at warn level on first occurrence and on
 *     recovery, so a stale API token or an unreachable console is visible
 *     instead of silently freezing door state.
 */

const https = require('https');

const PLUGIN_NAME = 'homebridge-unifi-access-garage';
const PLATFORM_NAME = 'UniFiAccessGarage';
const ALERT_SUBTYPE = 'open-alert';

let Service, Characteristic, UUIDGen;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, UniFiAccessGaragePlatform);
};

class UniFiAccessGaragePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.doors = new Map();

    this.host = this.config.host;
    this.port = this.config.port || 12445;
    this.token = this.config.token;
    this.basePath = this.config.basePath || '/api/v1/developer';
    this.unlockMethod = (this.config.unlockMethod || 'PUT').toUpperCase();
    this.pollInterval = Math.max(2, this.config.pollInterval || 5);
    this.defaultTravel = this.config.travelSeconds || 12;
    this.rejectUnauthorized = this.config.rejectUnauthorized === true;
    this.testMode = this.config.testMode === true;

    // Suppress the relay pulse when the position sensor *confidently* reports the
    // door is already where HomeKit is asking it to go. A single-button opener
    // toggles, so a redundant CLOSE on a closed door opens it - which turns a
    // "close the garage at bedtime" automation into one that opens it overnight.
    // Only ever suppresses on a fresh sensor reading; with no sensor, or a stale
    // one, behaviour is unchanged and we still pulse.
    this.suppressRedundant = this.config.suppressRedundantCommands !== false;
    this.sensorMaxAge = Math.max(
      this.pollInterval * 3,
      this.config.sensorMaxAgeSeconds || 30,
    ) * 1000;

    // Optional per-door "open too long" contact sensor. 0 or absent disables it.
    this.defaultOpenAlert = Math.max(0, this.config.openAlertMinutes || 0);

    // Poll health. A failed poll used to log at debug level, which meant a
    // rotated token or a rebooted console froze every door silently.
    this.pollFailures = 0;
    this.polling = false;
    this.pollTimer = null;
    // Re-warn roughly hourly while a failure persists, rather than every cycle.
    this.pollWarnEvery = Math.max(1, Math.round(3600 / this.pollInterval));

    if (!this.host || !this.token) {
      this.log.error('host and token are both required in config. Platform disabled.');
      return;
    }
    if (!Array.isArray(this.config.doors) || this.config.doors.length === 0) {
      this.log.error('No doors configured. Platform disabled.');
      return;
    }
    if (this.testMode) {
      this.log.warn('testMode is ON - unlock requests will be logged but NOT sent.');
    }

    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.shutdown());
  }

  // Homebridge replays cached accessories through here on restart.
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  start() {
    for (const doorCfg of this.config.doors) {
      if (!doorCfg.id || !doorCfg.name) {
        this.log.error(`Door entry missing id or name, skipping: ${JSON.stringify(doorCfg)}`);
        continue;
      }
      this.setupDoor(doorCfg);
    }
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollInterval * 1000);
  }

  shutdown() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const door of this.doors.values()) {
      if (door.travelTimer) { clearTimeout(door.travelTimer); door.travelTimer = null; }
      if (door.openTimer) { clearTimeout(door.openTimer); door.openTimer = null; }
    }
  }

  setupDoor(doorCfg) {
    const uuid = UUIDGen.generate(`${PLUGIN_NAME}:${doorCfg.id}`);
    let accessory = this.accessories.find((a) => a.UUID === uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(doorCfg.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Registered new garage door accessory: ${doorCfg.name}`);
    } else {
      this.log.info(`Restored garage door accessory: ${doorCfg.name}`);
    }

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Ubiquiti')
      .setCharacteristic(Characteristic.Model, 'UniFi Access Door')
      .setCharacteristic(Characteristic.SerialNumber, doorCfg.id);

    const service = accessory.getService(Service.GarageDoorOpener)
      || accessory.addService(Service.GarageDoorOpener, doorCfg.name);

    const state = {
      id: doorCfg.id,
      name: doorCfg.name,
      travel: (doorCfg.travelSeconds || this.defaultTravel) * 1000,
      service,
      current: Characteristic.CurrentDoorState.CLOSED,
      target: Characteristic.TargetDoorState.CLOSED,
      travelTimer: null,
      travelSeq: 0,
      // null = never heard from, true = reporting, false = reporting "none".
      // Tracked as a transition rather than a one-way latch, so a sensor that
      // fails after a healthy start is reported rather than swallowed.
      sensorPresent: null,
      lastPos: null,
      lastPosAt: 0,
      openAfter: Math.max(0, doorCfg.openAlertMinutes !== undefined
        ? doorCfg.openAlertMinutes
        : this.defaultOpenAlert) * 60000,
      openTimer: null,
      openAlert: false,
      alertService: null,
    };
    this.doors.set(doorCfg.id, state);

    const existingAlert = accessory.getServiceById
      ? accessory.getServiceById(Service.ContactSensor, ALERT_SUBTYPE)
      : null;

    if (state.openAfter > 0) {
      state.alertService = existingAlert
        || accessory.addService(Service.ContactSensor, `${doorCfg.name} Open Too Long`, ALERT_SUBTYPE);
      state.alertService.getCharacteristic(Characteristic.ContactSensorState)
        .onGet(() => (state.openAlert
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED));
      this.log.info(`${doorCfg.name}: will report open longer than `
        + `${Math.round(state.openAfter / 60000)} minutes`);
    } else if (existingAlert && accessory.removeService) {
      // The option was turned off; do not leave a stale accessory in Home.
      accessory.removeService(existingAlert);
      this.log.info(`${doorCfg.name}: open-too-long sensor removed`);
    }

    service.getCharacteristic(Characteristic.CurrentDoorState)
      .onGet(() => state.current);

    service.getCharacteristic(Characteristic.TargetDoorState)
      .onGet(() => state.target)
      .onSet(async (value) => { await this.setTarget(state, value); });

    service.getCharacteristic(Characteristic.ObstructionDetected)
      .onGet(() => false);
  }

  /**
   * Is this write asking for something the door is already doing or already is?
   *
   * Only ever true on a *fresh* sensor reading. The original bug this plugin
   * exists to fix came from conditioning the pulse on a state the official
   * plugin never updated; conditioning on a position sensor we poll ourselves
   * is a different proposition. When there is no sensor, or the last reading is
   * older than sensorMaxAge, this returns false and the relay pulses as before.
   */
  isRedundant(door, value) {
    if (!this.suppressRedundant) return false;
    if (door.sensorPresent !== true) return false;
    if (door.lastPos !== 'open' && door.lastPos !== 'close') return false;
    if (Date.now() - door.lastPosAt > this.sensorMaxAge) return false;

    // Mid-travel, always pulse. Someone tapping again while the door is moving is
    // usually retrying because it did not move, and swallowing that retry is the
    // exact behaviour this plugin was written to eliminate.
    if (door.current === Characteristic.CurrentDoorState.OPENING
        || door.current === Characteristic.CurrentDoorState.CLOSING) return false;

    const wantOpen = value === Characteristic.TargetDoorState.OPEN;
    return wantOpen === (door.lastPos === 'open');
  }

  /**
   * A single-button garage opener toggles on each pulse, so OPEN and CLOSE both
   * send the same unlock. We pulse on EVERY write rather than comparing against
   * *perceived* state - that is the bug this plugin exists to fix - with one
   * exception: a write the position sensor has just confirmed is already
   * satisfied. See isRedundant().
   */
  async setTarget(door, value) {
    const opening = value === Characteristic.TargetDoorState.OPEN;

    if (this.isRedundant(door, value)) {
      this.log.info(`${door.name}: HomeKit requested ${opening ? 'OPEN' : 'CLOSE'} `
        + `but the sensor reports it already ${door.lastPos === 'open' ? 'OPEN' : 'CLOSED'} `
        + `- no relay pulse sent`);
      door.target = value;
      door.service.updateCharacteristic(Characteristic.TargetDoorState, value);
      return;
    }

    door.target = value;
    this.log.info(`${door.name}: HomeKit requested ${opening ? 'OPEN' : 'CLOSE'} - pulsing relay`);

    try {
      await this.unlock(door.id);
    } catch (err) {
      this.log.error(`${door.name}: unlock request failed - ${err.message}`);
      // Re-sync target to reality so the next tap is not swallowed.
      door.target = door.current === Characteristic.CurrentDoorState.OPEN
        ? Characteristic.TargetDoorState.OPEN
        : Characteristic.TargetDoorState.CLOSED;
      door.service.updateCharacteristic(Characteristic.TargetDoorState, door.target);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.setCurrent(door, opening
      ? Characteristic.CurrentDoorState.OPENING
      : Characteristic.CurrentDoorState.CLOSING);

    // The sensor is authoritative; this timer only rescues us if it never reports.
    if (door.travelTimer) clearTimeout(door.travelTimer);
    const seq = ++door.travelSeq;
    door.travelTimer = setTimeout(() => this.onTravelTimeout(door, opening, seq), door.travel);
  }

  /**
   * The travel window elapsed without the sensor settling. Rather than assume
   * the door arrived - which briefly reports OPEN for a door that never moved,
   * and can fire open-triggered automations - take a fresh reading and report
   * what is actually true. Only fall back to assumption when there is no sensor
   * at all.
   */
  async onTravelTimeout(door, opening, seq) {
    door.travelTimer = null;
    if (door.current !== Characteristic.CurrentDoorState.OPENING
        && door.current !== Characteristic.CurrentDoorState.CLOSING) {
      return; // the sensor already settled us; nothing to rescue
    }

    let pos = door.lastPos;
    try {
      const list = await this.fetchDoors();
      this.notePollSuccess();
      const entry = list.find((e) => e.id === door.id);
      if (entry) pos = entry.door_position_status;
    } catch (err) {
      this.notePollFailure(err);
    }

    // A newer command superseded us while that request was in flight.
    if (seq !== door.travelSeq) return;

    const secs = Math.round(door.travel / 1000);

    if (pos === 'open' || pos === 'close') {
      const isOpen = pos === 'open';
      const settled = isOpen
        ? Characteristic.CurrentDoorState.OPEN
        : Characteristic.CurrentDoorState.CLOSED;

      if (isOpen === opening) {
        this.log.info(`${door.name}: sensor confirms ${isOpen ? 'OPEN' : 'CLOSED'} as the travel window closed`);
      } else {
        this.log.warn(`${door.name}: asked to ${opening ? 'OPEN' : 'CLOSE'} but the sensor still reports `
          + `${isOpen ? 'OPEN' : 'CLOSED'} after ${secs}s - the door does not appear to have moved. `
          + `Reporting actual position. Check the opener and relay wiring, or raise travelSeconds if `
          + `this door is simply slow.`);
      }

      this.setCurrent(door, settled);

      // Realign target so the next HomeKit tap still registers as a change.
      const wantTarget = isOpen
        ? Characteristic.TargetDoorState.OPEN
        : Characteristic.TargetDoorState.CLOSED;
      if (door.target !== wantTarget) {
        door.target = wantTarget;
        door.service.updateCharacteristic(Characteristic.TargetDoorState, wantTarget);
      }
      return;
    }

    // pos is 'none' or unknown: no sensor to trust, so the timer is all we have.
    const assumed = opening
      ? Characteristic.CurrentDoorState.OPEN
      : Characteristic.CurrentDoorState.CLOSED;
    this.log.warn(`${door.name}: travel window elapsed after ${secs}s and no position sensor is `
      + `reporting - assuming ${opening ? 'OPEN' : 'CLOSED'}`);
    this.setCurrent(door, assumed);
  }

  setCurrent(door, value) {
    if (door.current === value) return;
    door.current = value;
    door.service.updateCharacteristic(Characteristic.CurrentDoorState, value);
    this.updateOpenAlert(door);
  }

  /**
   * Arm, clear or trip the optional "open too long" contact sensor. Driven from
   * setCurrent so it follows the door however it moved - HomeKit, wall button,
   * or car remote - rather than only tracking commands we issued.
   */
  updateOpenAlert(door) {
    if (!door.alertService) return;

    if (door.current !== Characteristic.CurrentDoorState.OPEN) {
      if (door.openTimer) { clearTimeout(door.openTimer); door.openTimer = null; }
      if (door.openAlert) {
        door.openAlert = false;
        door.alertService.updateCharacteristic(Characteristic.ContactSensorState,
          Characteristic.ContactSensorState.CONTACT_DETECTED);
        this.log.info(`${door.name}: no longer open - alert cleared`);
      }
      return;
    }

    if (door.openTimer || door.openAlert) return; // already counting, or already tripped

    door.openTimer = setTimeout(() => {
      door.openTimer = null;
      door.openAlert = true;
      door.alertService.updateCharacteristic(Characteristic.ContactSensorState,
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
      this.log.warn(`${door.name}: has been open for `
        + `${Math.round(door.openAfter / 60000)} minutes`);
    }, door.openAfter);
  }

  async fetchDoors() {
    const payload = await this.request('GET', `${this.basePath}/doors`);
    return Array.isArray(payload) ? payload : (payload && payload.data) || [];
  }

  notePollFailure(err) {
    this.pollFailures += 1;
    if (this.pollFailures === 1) {
      this.log.warn(`Lost contact with UniFi Access - ${err.message}. Door state is now stale and will `
        + `not track manual operation until this recovers. Repeat failures are logged at debug level. `
        + `An HTTP 401 here means the API token in config.json is no longer valid.`);
    } else if (this.pollFailures % this.pollWarnEvery === 0) {
      this.log.warn(`Still cannot reach UniFi Access after ${this.pollFailures} attempts - ${err.message}`);
    } else {
      this.log.debug(`poll failed (${this.pollFailures} consecutive): ${err.message}`);
    }
  }

  notePollSuccess() {
    if (this.pollFailures > 0) {
      this.log.info(`Contact with UniFi Access restored after ${this.pollFailures} failed `
        + `attempt${this.pollFailures === 1 ? '' : 's'}.`);
      this.pollFailures = 0;
    }
  }

  /**
   * Poll every door's position. This is what keeps HomeKit honest when someone
   * uses the wall button or a car remote, and it is what stops TargetDoorState
   * getting stuck.
   */
  async poll() {
    if (this.polling) return; // a timeout re-read may already be in flight
    this.polling = true;
    try {
      let list;
      try {
        list = await this.fetchDoors();
      } catch (err) {
        this.notePollFailure(err);
        return;
      }
      this.notePollSuccess();
      this.applyDoorStates(list);
    } finally {
      this.polling = false;
    }
  }

  applyDoorStates(list) {
    for (const entry of list) {
      const door = this.doors.get(entry.id);
      if (!door) continue;

      const pos = entry.door_position_status;
      door.lastPos = pos;

      if (pos !== 'open' && pos !== 'close') {
        if (door.sensorPresent === true) {
          // Was healthy, now is not. This is the failure the one-way flag hid.
          this.log.warn(`${door.name}: position sensor STOPPED reporting `
            + `(door_position_status is "${pos}"). State reverts to timer-based, and commands the `
            + `door has already satisfied will no longer be suppressed - a scheduled CLOSE can now `
            + `open this door. Check the contact and its wiring at the door hub.`);
        } else if (door.sensorPresent === null) {
          this.log.warn(`${door.name}: door_position_status is "${pos}" - no position sensor `
            + `reporting. State will be timer-based only.`);
        }
        door.sensorPresent = false;
        continue;
      }

      if (door.sensorPresent === false) {
        this.log.info(`${door.name}: position sensor is reporting again`);
      }
      door.sensorPresent = true;
      door.lastPosAt = Date.now();

      const isOpen = pos === 'open';
      const settled = isOpen
        ? Characteristic.CurrentDoorState.OPEN
        : Characteristic.CurrentDoorState.CLOSED;

      // Mid-travel: let the timer and the animation run until the sensor settles.
      const moving = door.current === Characteristic.CurrentDoorState.OPENING
        || door.current === Characteristic.CurrentDoorState.CLOSING;

      if (moving) {
        const arrived = (door.current === Characteristic.CurrentDoorState.OPENING && isOpen)
          || (door.current === Characteristic.CurrentDoorState.CLOSING && !isOpen);
        if (!arrived) continue;
        if (door.travelTimer) { clearTimeout(door.travelTimer); door.travelTimer = null; }
        door.travelSeq += 1; // invalidate any in-flight timeout handler
        this.log.info(`${door.name}: sensor confirms ${isOpen ? 'OPEN' : 'CLOSED'}`);
      }

      if (door.current !== settled) {
        if (!moving) {
          this.log.info(`${door.name}: changed to ${isOpen ? 'OPEN' : 'CLOSED'} outside HomeKit`);
        }
        this.setCurrent(door, settled);
      }

      // Keep target aligned so the next HomeKit tap always registers as a change.
      const wantTarget = isOpen
        ? Characteristic.TargetDoorState.OPEN
        : Characteristic.TargetDoorState.CLOSED;
      if (!moving && door.target !== wantTarget) {
        door.target = wantTarget;
        door.service.updateCharacteristic(Characteristic.TargetDoorState, wantTarget);
      }
    }
  }

  async unlock(doorId) {
    const path = `${this.basePath}/doors/${doorId}/unlock`;
    if (this.testMode) {
      this.log.warn(`testMode: would send ${this.unlockMethod} https://${this.host}:${this.port}${path}`);
      return;
    }
    await this.request(this.unlockMethod, path);
  }

  request(method, path, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        host: this.host,
        port: this.port,
        path,
        method,
        rejectUnauthorized: this.rejectUnauthorized,
        headers: Object.assign({
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        timeout: 10000,
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} on ${method} ${path}: ${raw.slice(0, 200)}`));
          }
          if (!raw) return resolve(null);
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Non-JSON response from ${path}: ${raw.slice(0, 120)}`));
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('request timed out')); });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
}
