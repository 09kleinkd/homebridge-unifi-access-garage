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
 *   - pulsing the relay on every target write, never conditioning it on state
 *   - modelling OPENING/CLOSING with a travel timer that yields to the sensor
 *   - picking up manual operation (wall button, remote) via polling
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
      sensorSeen: false,
      lastPos: null,
    };
    this.doors.set(doorCfg.id, state);

    service.getCharacteristic(Characteristic.CurrentDoorState)
      .onGet(() => state.current);

    service.getCharacteristic(Characteristic.TargetDoorState)
      .onGet(() => state.target)
      .onSet(async (value) => { await this.setTarget(state, value); });

    service.getCharacteristic(Characteristic.ObstructionDetected)
      .onGet(() => false);
  }

  /**
   * A single-button garage opener toggles on each pulse, so OPEN and CLOSE both
   * send the same unlock. Critically, we pulse on EVERY write rather than
   * comparing against perceived state - that is the bug this plugin exists to fix.
   */
  async setTarget(door, value) {
    const opening = value === Characteristic.TargetDoorState.OPEN;
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

      if (pos === 'none') {
        if (!door.sensorSeen) {
          this.log.warn(`${door.name}: door_position_status is "none" - no position sensor reporting. State will be timer-based only.`);
          door.sensorSeen = true;
        }
        continue;
      }
      door.sensorSeen = true;

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
