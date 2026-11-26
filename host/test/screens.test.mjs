// What each screen shows (host/src/screens.mjs): glass displays, steam layouts, Automatic, per-aircraft
// choices, waiting. The sim, the hook and the display registry are small fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Screens } from '../src/screens.mjs';

class FakeSim extends EventEmitter {
  constructor(s = {}) {
    super();
    this.s = { connected: true, inFlight: true, aircraft: 'test_c172', title: 'Test 172', liveForSec: 0, ...s };
  }
  status() {
    return this.s;
  }
  set(s) {
    Object.assign(this.s, s);
    this.emit('status');
  }
}
class FakeHook extends EventEmitter {
  constructor(ids = []) {
    super();
    this.ids = new Set(ids);
  }
  present() {
    return this.ids;
  }
}
class FakeRegistry extends EventEmitter {
  constructor(displays) {
    super();
    this.d = displays;
  }
  get(id) {
    return this.d.find((x) => x.id === id) ?? null;
  }
  byKey() {
    return null;
  }
  all() {
    return this.d;
  }
}
const REGISTRY = [
  { id: 'pfd', primary: true, tags: ['PFD'] },
  { id: 'mfd', primary: true, tags: ['MFD'] },
  { id: 'gps', primary: false, tags: ['GPS'] },
];

// A Screens with its own scratch data folder; closed after the test.
function make(t, { screens, sim = new FakeSim(), present = [], saved = null, screenMode = 'auto' }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-screens-'));
  if (saved) fs.writeFileSync(path.join(dataDir, 'screens.json'), JSON.stringify(saved));
  const cfg = { dataDir, screens, steamAfterSec: 30, screenMode };
  const sc = new Screens({ cfg, sim, hook: new FakeHook(present), registry: new FakeRegistry(REGISTRY) });
  t.after(() => {
    sc.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { sc, sim, dataDir };
}
const shows = (sc) => Object.fromEntries(sc.list().map((s) => [s.id, s.show.kind === 'waiting' ? 'waiting' : `${s.show.kind}:${s.show.id}`]));
const TWO = [
  { id: '1', name: 'Left', glass: 'pfd', steam: 'six' },
  { id: '2', name: 'Right', glass: 'mfd', steam: 'engine' },
];

test('glass cockpit: each screen shows its assigned display', (t) => {
  const { sc } = make(t, { screens: TWO, present: ['pfd', 'mfd'] });
  assert.equal(sc.mode, 'glass');
  assert.deepEqual(shows(sc), { 1: 'display:pfd', 2: 'display:mfd' });
});

test('Automatic: screens without a display take the primary ones, PFD first', (t) => {
  const { sc } = make(t, { screens: [{ id: '1', steam: 'six' }, { id: '2', steam: 'engine' }, { id: '3', steam: 'radios' }], present: ['mfd', 'pfd', 'gps'] });
  // GPS is not primary: screen 3 keeps its layout.
  assert.deepEqual(shows(sc), { 1: 'display:pfd', 2: 'display:mfd', 3: 'layout:radios' });
});

test('steam: nothing reported, flight live long enough -> layouts; before that: waiting', (t) => {
  const { sc, sim } = make(t, { screens: TWO, present: [] });
  assert.deepEqual(shows(sc), { 1: 'waiting', 2: 'waiting' });
  sim.set({ liveForSec: 31 });
  assert.equal(sc.mode, 'steam');
  assert.deepEqual(shows(sc), { 1: 'layout:six', 2: 'layout:engine' });
});

test('an assigned display the cockpit has shows in a steam cockpit too', (t) => {
  const { sc } = make(t, { screens: [{ id: '1', glass: 'gps', steam: 'six' }, { id: '2', steam: 'engine' }], present: ['gps'], sim: new FakeSim({ liveForSec: 60 }) });
  assert.deepEqual(shows(sc), { 1: 'display:gps', 2: 'layout:engine' });
});

test('per-aircraft choice wins, and Automatic does not hand its display out again', (t) => {
  const auto = [{ id: '1', steam: 'six' }, { id: '2', steam: 'engine' }];
  const saved = { screens: auto, aircraft: { test_c172: { 1: { kind: 'display', id: 'mfd' } } } };
  const { sc } = make(t, { screens: auto, present: ['pfd', 'mfd'], saved });
  const list = sc.list();
  assert.deepEqual(shows(sc), { 1: 'display:mfd', 2: 'display:pfd' });
  assert.equal(list[0].custom, true);
  assert.equal(list[1].custom, false);
});

test('a display set for all aircraft stays, even if an aircraft choice shows it too', (t) => {
  const saved = { screens: TWO, aircraft: { test_c172: { 1: { kind: 'display', id: 'mfd' } } } };
  const { sc } = make(t, { screens: TWO, present: ['pfd', 'mfd'], saved });
  assert.deepEqual(shows(sc), { 1: 'display:mfd', 2: 'display:mfd' });
});

test('another aircraft: waiting until it is decided again', (t) => {
  const { sc, sim } = make(t, { screens: TWO, present: [], sim: new FakeSim({ liveForSec: 60 }) });
  assert.equal(sc.mode, 'steam');
  sim.set({ aircraft: 'test_other', liveForSec: 2 });
  assert.deepEqual(shows(sc), { 1: 'waiting', 2: 'waiting' });
});

test('setAssignments: checks ids, saves, and is read back', (t) => {
  const { sc, dataDir, sim } = make(t, { screens: TWO });
  assert.throws(() => sc.setAssignments([{ id: '1' }, { id: '1' }]), /unique/);
  assert.throws(() => sc.setAssignments([{ id: 'bad id!' }]), /must be/);
  assert.throws(() => sc.setAssignments([]), /1 to 16/);
  sc.setAssignments([{ id: 'a', name: 'Only', steam: 'six', local: { monitor: 1, area: 'left' } }], { test_c172: { a: { kind: 'layout', id: 'x' }, gone: { kind: 'layout', id: 'y' } } });
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'screens.json'), 'utf8'));
  assert.deepEqual(saved.screens, [{ id: 'a', name: 'Only', glass: null, steam: 'six', local: { monitor: 1, area: 'left', fit: 'contain' } }]);
  assert.deepEqual(saved.aircraft, { test_c172: { a: { kind: 'layout', id: 'x' } } }); // unknown screen dropped
  const again = new Screens({ cfg: { dataDir, screens: TWO, steamAfterSec: 30, screenMode: 'auto' }, sim, hook: new FakeHook(), registry: new FakeRegistry(REGISTRY) });
  t.after(() => again.close());
  assert.deepEqual(again.list().map((s) => s.id), ['a']);
});
