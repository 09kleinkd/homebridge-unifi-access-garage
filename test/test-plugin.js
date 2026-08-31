'use strict';
/*
 * Harness for homebridge-unifi-access-garage v1.2.0.
 * Stubs HAP and the Access API so the state machine can be driven directly.
 */

const assert = require('assert');

const CurrentDoorState = { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3, STOPPED: 4 };
const TargetDoorState = { OPEN: 0, CLOSED: 1 };
const NAMES = { 0: 'OPEN', 1: 'CLOSED', 2: 'OPENING', 3: 'CLOSING', 4: 'STOPPED' };

function makeChar() {
  const c = { onGet: () => c, onSet: () => c };
  return c;
}
function makeService() {
  return {
    updates: [],
    setCharacteristic() { return this; },
    getCharacteristic() { return makeChar(); },
    updateCharacteristic(ch, v) { this.updates.push([ch, v]); },
  };
}

const Service = { AccessoryInformation: 'AccessoryInformation', GarageDoorOpener: 'GarageDoorOpener' };
const Characteristic = {
  CurrentDoorState, TargetDoorState,
  ObstructionDetected: 'ObstructionDetected',
  Manufacturer: 'Manufacturer', Model: 'Model', SerialNumber: 'SerialNumber',
};

const logLines = [];
const log = {
  info: (m) => logLines.push(['info', m]),
  warn: (m) => logLines.push(['warn', m]),
  error: (m) => logLines.push(['error', m]),
  debug: (m) => logLines.push(['debug', m]),
};

const handlers = {};
const api = {
  hap: { Service, Characteristic, uuid: { generate: (s) => 'uuid:' + s }, HapStatusError: class {}, HAPStatus: {} },
  on: (evt, fn) => { handlers[evt] = fn; },
  registerPlatform: () => {},
  registerPlatformAccessories: () => {},
  platformAccessory: class {
    constructor(name) { this.displayName = name; this._svc = makeService(); }
    getService() { return this._svc; }
    addService() { return this._svc; }
  },
};

let PlatformCtor;
require('../index.js')({
  ...api,
  registerPlatform: (_p, _n, ctor) => { PlatformCtor = ctor; },
});

const DOOR_ID = 'door-1';

function newPlatform(travelSeconds) {
  logLines.length = 0;
  const cfg = {
    host: '10.0.0.1', token: 'x', pollInterval: 2,
    travelSeconds, doors: [{ name: 'Test Garage', id: DOOR_ID }],
  };
  const p = new PlatformCtor(log, cfg, api);
  p.sensor = 'close';
  p.failNext = null;
  p.request = async () => {
    if (p.failNext) throw new Error(p.failNext);
    return { data: [{ id: DOOR_ID, door_position_status: p.sensor }] };
  };
  p.unlock = async () => {};
  // start() without the interval, so nothing races the assertions
  for (const d of cfg.doors) p.setupDoor(d);
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, fn) { return fn().then(() => results.push(['PASS', name]), (e) => results.push(['FAIL', name, e.message])); }

(async () => {

  // 1. The refinement: door told to open, sensor says it never moved.
  await check('stuck door reports CLOSED, not OPEN', async () => {
    const p = newPlatform(0.3);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'close';
    await p.setTarget(door, TargetDoorState.OPEN);
    assert.strictEqual(door.current, CurrentDoorState.OPENING, 'should animate first');
    await sleep(450);
    assert.strictEqual(door.current, CurrentDoorState.CLOSED,
      `expected CLOSED, got ${NAMES[door.current]}`);
    assert.strictEqual(door.target, TargetDoorState.CLOSED, 'target must realign for the next tap');
    assert.ok(logLines.some(([l, m]) => l === 'warn' && /does not appear to have moved/.test(m)),
      'should warn that the door did not move');
  });

  // 2. Normal operation: sensor confirms arrival before the window elapses.
  await check('door that opens settles to OPEN via sensor', async () => {
    const p = newPlatform(0.5);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'close';
    await p.setTarget(door, TargetDoorState.OPEN);
    p.sensor = 'open';
    await p.poll();
    assert.strictEqual(door.current, CurrentDoorState.OPEN, `expected OPEN, got ${NAMES[door.current]}`);
    assert.strictEqual(door.travelTimer, null, 'travel timer should be cleared on arrival');
    await sleep(600); // the elapsed window must not undo anything
    assert.strictEqual(door.current, CurrentDoorState.OPEN, 'state must survive the stale timer');
  });

  // 3. Slow door: arrives after the window. Timeout reads truth, not assumption.
  await check('late arrival is reported correctly', async () => {
    const p = newPlatform(0.3);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'close';
    await p.setTarget(door, TargetDoorState.OPEN);
    p.sensor = 'open'; // moved, just slower than the window
    await sleep(450);
    assert.strictEqual(door.current, CurrentDoorState.OPEN, `expected OPEN, got ${NAMES[door.current]}`);
    assert.ok(logLines.some(([l, m]) => l === 'info' && /sensor confirms OPEN/.test(m)));
  });

  // 4. No position sensor at all: fall back to assuming the command worked.
  await check('sensorless door falls back to assumption', async () => {
    const p = newPlatform(0.3);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'none';
    await p.poll();
    await p.setTarget(door, TargetDoorState.OPEN);
    await sleep(450);
    assert.strictEqual(door.current, CurrentDoorState.OPEN, `expected OPEN, got ${NAMES[door.current]}`);
    assert.ok(logLines.some(([l, m]) => l === 'warn' && /no position sensor is reporting/.test(m)));
  });

  // 5. Manual operation outside HomeKit is picked up by polling.
  await check('manual open detected by poll', async () => {
    const p = newPlatform(1);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'close';
    await p.poll();
    p.sensor = 'open';
    await p.poll();
    assert.strictEqual(door.current, CurrentDoorState.OPEN);
    assert.strictEqual(door.target, TargetDoorState.OPEN, 'target follows so the next tap registers');
    assert.ok(logLines.some(([l, m]) => l === 'info' && /outside HomeKit/.test(m)));
  });

  // 6. Poll failures are visible, quiet while persistent, and announce recovery.
  await check('poll failure warns once then recovers loudly', async () => {
    const p = newPlatform(1);
    p.failNext = 'HTTP 401 on GET /doors: CODE_UNAUTHORIZED';
    await p.poll();
    await p.poll();
    await p.poll();
    const warns = logLines.filter(([l, m]) => l === 'warn' && /Lost contact/.test(m));
    assert.strictEqual(warns.length, 1, `expected exactly one warn, got ${warns.length}`);
    assert.ok(warns[0][1].includes('401'), 'the 401 must appear in the warning');
    assert.strictEqual(logLines.filter(([l]) => l === 'debug').length, 2, 'repeats demoted to debug');
    p.failNext = null;
    await p.poll();
    assert.ok(logLines.some(([l, m]) => l === 'info' && /restored after 3 failed attempts/.test(m)));
  });

  // 7. A second command mid-flight must not be clobbered by the older timeout.
  await check('superseded command is not clobbered', async () => {
    const p = newPlatform(0.3);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'close';
    await p.setTarget(door, TargetDoorState.OPEN);
    await sleep(150);
    await p.setTarget(door, TargetDoorState.OPEN); // tapped again mid-travel
    await sleep(250); // first window would have elapsed by now
    assert.strictEqual(door.current, CurrentDoorState.OPENING,
      `still travelling on the newer command, got ${NAMES[door.current]}`);
    await sleep(250);
    assert.strictEqual(door.current, CurrentDoorState.CLOSED, 'then resolves against the sensor');
  });

  // --- v1.2.0: redundant-command suppression ---------------------------------
  //
  // A single-button opener toggles, so a CLOSE aimed at a door that is already
  // closed would open it. Suppression must be narrow: fresh sensor, settled
  // door, matching state. Everything else must still pulse.

  function countingPlatform(travelSeconds) {
    const p = newPlatform(travelSeconds);
    p.pulses = 0;
    p.unlock = async () => { p.pulses += 1; };
    return p;
  }

  // 8. The reason this exists: a bedtime "close the garage" automation.
  await check('redundant CLOSE on a closed door sends no pulse', async () => {
    const p = countingPlatform(1);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'close';
    await p.poll();
    await p.setTarget(door, TargetDoorState.CLOSED);
    assert.strictEqual(p.pulses, 0, 'the relay must not fire');
    assert.strictEqual(door.current, CurrentDoorState.CLOSED, 'door stays closed');
    assert.strictEqual(door.target, TargetDoorState.CLOSED, 'target still acknowledged to HomeKit');
    assert.strictEqual(door.travelTimer, null, 'no travel timer should be armed');
    assert.ok(logLines.some(([l, m]) => l === 'info' && /no relay pulse sent/.test(m)));
  });

  // 9. Same guard, other direction.
  await check('redundant OPEN on an open door sends no pulse', async () => {
    const p = countingPlatform(1);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'open';
    await p.poll();
    await p.setTarget(door, TargetDoorState.OPEN);
    assert.strictEqual(p.pulses, 0, 'the relay must not fire');
    assert.strictEqual(door.current, CurrentDoorState.OPEN);
  });

  // 10. A real command must still work.
  await check('genuine CLOSE on an open door still pulses', async () => {
    const p = countingPlatform(1);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'open';
    await p.poll();
    await p.setTarget(door, TargetDoorState.CLOSED);
    assert.strictEqual(p.pulses, 1, 'the relay must fire');
    assert.strictEqual(door.current, CurrentDoorState.CLOSING);
  });

  // 11. The marginal-RF case. A sensor that has stopped reporting must never
  //     cause a command to be swallowed - fall back to always pulsing.
  await check('stale sensor reading still pulses', async () => {
    const p = countingPlatform(1);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'close';
    await p.poll();
    door.lastPosAt = Date.now() - (p.sensorMaxAge + 1000); // sensor went quiet
    await p.setTarget(door, TargetDoorState.CLOSED);
    assert.strictEqual(p.pulses, 1, 'a stale reading must not suppress');
  });

  // 12. No sensor at all: unchanged from v1.1.0.
  await check('sensorless door still pulses', async () => {
    const p = countingPlatform(1);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'none';
    await p.poll();
    await p.setTarget(door, TargetDoorState.CLOSED);
    assert.strictEqual(p.pulses, 1, 'no sensor means no suppression');
  });

  // 13. Retrying mid-travel must never be swallowed - that is the original bug.
  await check('retry mid-travel still pulses', async () => {
    const p = countingPlatform(2);
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'close';
    await p.poll();
    await p.setTarget(door, TargetDoorState.OPEN);
    assert.strictEqual(door.current, CurrentDoorState.OPENING);
    await p.setTarget(door, TargetDoorState.OPEN); // impatient second tap
    assert.strictEqual(p.pulses, 2, 'the retry must reach the relay');
    if (door.travelTimer) clearTimeout(door.travelTimer);
  });

  // 14. The escape hatch.
  await check('suppressRedundantCommands: false restores v1.1.0 behaviour', async () => {
    const p = countingPlatform(1);
    p.suppressRedundant = false;
    const door = p.doors.get(DOOR_ID);
    p.sensor = 'close';
    await p.poll();
    await p.setTarget(door, TargetDoorState.CLOSED);
    assert.strictEqual(p.pulses, 1, 'opt-out must pulse on every write');
    if (door.travelTimer) clearTimeout(door.travelTimer);
  });

  for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `\n      ${r[2]}` : '');
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
