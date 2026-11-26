// Decides what each client screen shows, so client boxes need no keyboard: they start as
// "screen 1" / "screen 2" and follow the host.
//
//   glass: the loaded cockpit holds a primary display (PFD, MFD, EICAS...; see displayRegistry.mjs),
//          or the hook has reported such an instrument (a few seconds after loading). Once glass, the
//          aircraft stays glass until the next aircraft.
//          Each screen shows its assigned glass display if the cockpit has it; screens whose display is
//          missing take the cockpit's other primary displays in order (PFD first, then MFD, then the
//          rest), so aircraft with other avionics work without setup. A screen left without one shows
//          its steam layout.
//   steam: the hook has reported the cockpit's instruments, none of them glass, and the list has not
//          grown for SETTLE_MS (radios and such only); or, when the hook reports nothing at all, the
//          flight has been live for steamAfterSec. Each screen shows its steam-gauge layout
//          (e.g. 1 = six-pack, 2 = engine-radios).
//   In both modes, a screen whose assigned glass display is in the cockpit shows it (e.g. a GPS unit
//   on screen 3 of a steam-gauge aircraft).
//   In menus and loading the last mode is kept; after an aircraft change, and before any decision,
//   screens show "waiting".
//   cfg.screenMode 'glass' or 'steam' forces a mode (testing, or aircraft the detection gets wrong).
//
// Per-aircraft choices: for any aircraft (by its folder name, e.g. asobo_tbm930), a screen can be set
// to always show one layout or one glass display. That screen then skips the glass/steam detection
// while that aircraft is loaded; the other screens keep the defaults. Glass displays chosen this way
// are not handed out again to the screens that fill themselves in automatically.
//
// Emits 'change' with the list whenever any screen's content changes.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makeLog } from './log.mjs';
import { guessPrimary } from './displayRegistry.mjs';

const log = makeLog('screens');
const SETTLE_MS = 10_000;

export class Screens extends EventEmitter {
  constructor({ cfg, sim, hook, registry, instruments = null }) {
    super();
    this.cfg = cfg;
    // Assignments (which glass display / steam layout per screen): host config, overridden by what the
    // user saved in the editor (dataDir/screens.json).
    this.file = path.join(cfg.dataDir, 'screens.json');
    this.assignments = cfg.screens.map((s) => ({ ...s }));
    // aircraft -> { screen id -> { kind: 'layout' | 'display', id } }
    this.perAircraft = {};
    try {
      if (fs.existsSync(this.file)) {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(saved.screens) && saved.screens.length) this.assignments = saved.screens.map(cleanScreen);
        this.perAircraft = cleanPerAircraft(saved.aircraft, this.assignments);
      }
    } catch (e) {
      log.warn(`cannot read ${this.file}: ${e.message}`);
    }
    // Readable aircraft names for the editor (folder name -> the sim's TITLE), remembered so aircraft
    // that are not loaded show them too.
    this.namesFile = path.join(cfg.dataDir, 'aircraft-names.json');
    this.names = {};
    try {
      if (fs.existsSync(this.namesFile)) this.names = JSON.parse(fs.readFileSync(this.namesFile, 'utf8')) || {};
    } catch (e) {
      log.warn(`cannot read ${this.namesFile}: ${e.message}`);
    }
    this.sim = sim;
    this.hook = hook;
    this.registry = registry;
    this.instruments = instruments;
    this.aircraft = null;
    registry.on('change', () => this.update());
    instruments?.on('change', () => this.update());
    this.mode = cfg.screenMode === 'glass' || cfg.screenMode === 'steam' ? cfg.screenMode : 'waiting';
    this.last = '';
    this.timer = setInterval(() => this.update(), 1000);
    sim.on('status', () => this.update());
    hook.on('status', () => this.update());
    this.update();
  }

  decideMode() {
    if (this.cfg.screenMode === 'glass' || this.cfg.screenMode === 'steam') return this.cfg.screenMode;
    const s = this.sim.status();
    // Another aircraft: decide again (its instruments arrive within seconds).
    if (s.aircraft && s.aircraft !== this.aircraft) {
      const first = this.aircraft === null;
      this.aircraft = s.aircraft;
      if (!first) this.mode = 'waiting';
    }
    if ([...this.hook.present()].some((id) => this.registry.get(id)?.primary)) return 'glass';
    const cockpit = this.instruments?.cockpit();
    const reported = cockpit && cockpit.aircraft === s.aircraft ? cockpit.instruments : [];
    const isGlass = (i) => {
      const d = this.registry.byKey(i.key);
      return d ? d.primary : guessPrimary(i.key, i.url);
    };
    if (reported.some(isGlass)) return 'glass';
    // Once glass, an aircraft stays glass until the next aircraft (pages may close and reopen).
    if (this.mode === 'glass') return 'glass';
    if (!s.inFlight) return this.mode; // menus, loading: keep what we have
    if (reported.length && Date.now() - cockpit.changedAt >= SETTLE_MS && s.liveForSec >= SETTLE_MS / 1000) return 'steam';
    if (!reported.length && s.liveForSec >= this.cfg.steamAfterSec) return 'steam'; // the hook reports nothing
    return this.mode;
  }

  update() {
    const mode = this.decideMode();
    if (mode !== this.mode) {
      log.info(`mode: ${this.mode} -> ${mode}${this.sim.status().aircraft ? ` (${this.sim.status().aircraft})` : ''}`);
      this.mode = mode;
    }
    const { aircraft, title } = this.sim.status();
    if (aircraft && title && this.names[aircraft] !== title) {
      this.names[aircraft] = title;
      try {
        fs.mkdirSync(path.dirname(this.namesFile), { recursive: true });
        fs.writeFileSync(this.namesFile, JSON.stringify(this.names, null, 2));
      } catch (e) {
        log.warn(`cannot write ${this.namesFile}: ${e.message}`);
      }
    }
    const list = this.list();
    const json = JSON.stringify([list, aircraft ?? null, title ?? null]);
    if (json === this.last) return;
    this.last = json;
    this.emit('change', list);
  }

  list() {
    const present = this.hook.present();
    const aircraft = this.sim.status().aircraft ?? null;
    const own = (aircraft && this.perAircraft[aircraft]) || {};
    // Assigned displays the cockpit has (screens with a per-aircraft choice take no part).
    const pick = this.assignments.map((s) => (!own[s.id] && s.glass && present.has(s.glass) ? s.glass : null));
    // Glass mode: screens without one take the cockpit's remaining primary displays.
    if (this.mode === 'glass') {
      const used = new Set([...pick.filter(Boolean), ...Object.values(own).filter((o) => o.kind === 'display').map((o) => o.id)]);
      const pool = [...present].filter((id) => !used.has(id) && this.registry.get(id)?.primary).sort((a, b) => rank(this.registry.get(a)) - rank(this.registry.get(b)) || a.localeCompare(b));
      for (let i = 0; i < pick.length; i++) if (!pick[i] && !own[this.assignments[i].id]) pick[i] = pool.shift() ?? null;
    }
    return this.assignments.map((s, i) => {
      let show = { kind: 'waiting' };
      if (own[s.id]) show = { ...own[s.id] };
      else if (pick[i]) show = { kind: 'display', id: pick[i] };
      else if (this.mode !== 'waiting' && s.steam) show = { kind: 'layout', id: s.steam };
      return { id: s.id, name: s.name, mode: this.mode, show, custom: !!own[s.id], glass: s.glass ?? null, steam: s.steam ?? null, local: s.local ?? null };
    });
  }

  /// Extra fields for the 'screens' message (the editor uses them; clients only read 'screens'):
  /// the loaded aircraft, the per-aircraft choices, every aircraft the host knows of, and readable names
  /// (aircraftNames: folder name -> the sim's title) for those it has seen loaded.
  extra() {
    const aircraft = this.sim.status().aircraft ?? null;
    const known = new Set(Object.keys(this.perAircraft));
    for (const name of Object.keys(this.instruments?.byAircraft ?? {})) known.add(name);
    for (const d of this.registry.all()) for (const name of d.aircraft ?? []) known.add(name);
    if (aircraft) known.add(aircraft);
    return { aircraft, perAircraft: this.perAircraft, knownAircraft: [...known].sort(), aircraftNames: this.names, localMonitors: this.localMonitors?.() ?? [], localState: this.localState?.() ?? 'none', localOnTop: this.localOnTop?.() ?? true };
  }

  /// Replace the screen list (from the editor): any number of screens, each with an id (what a client
  /// is started with: --screen <id>), a name, a glass display and a steam layout. Saved to disk.
  /// perAircraft (optional; left out = keep): { aircraft: { screen id: { kind: 'layout' | 'display', id } } }.
  setAssignments(list, perAircraft) {
    if (!Array.isArray(list) || list.length < 1 || list.length > 16) throw new Error('need 1 to 16 screens');
    const next = list.map(cleanScreen);
    const ids = new Set(next.map((s) => s.id));
    if (ids.size !== next.length) throw new Error('screen ids must be unique');
    this.assignments = next;
    this.perAircraft = cleanPerAircraft(perAircraft === undefined ? this.perAircraft : perAircraft, next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const saved = { screens: this.assignments.map(({ id, name, glass, steam, local }) => ({ id, name, glass, steam, local })), aircraft: this.perAircraft };
    fs.writeFileSync(this.file, JSON.stringify(saved, null, 2));
    log.info(`screens: ${this.assignments.map((a) => `${a.id}=${a.glass ?? '-'}/${a.steam ?? '-'}`).join(' ')}`);
    for (const [a, m] of Object.entries(this.perAircraft)) log.info(`  ${a}: ${Object.entries(m).map(([sid, o]) => `${sid}=${o.kind} ${o.id}`).join(' ')}`);
    this.last = ''; // the editor needs the new choices even if no screen changes now
    this.update();
  }

  close() {
    clearInterval(this.timer);
  }
}

// Order for filling screens: PFD-like first, then MFD-like, then other primary displays; #1 before #2.
function rank(d) {
  const key = `${d?.id ?? ''} ${d?.tags?.[0] ?? ''}`;
  const n = Number(/#(\d+)/.exec(key)?.[1] ?? 0);
  const kind = /pfd/.test(key) ? 0 : /mfd|nd\b/.test(key) ? 1 : /eicas|ecam|ead/.test(key) ? 2 : 3;
  return kind * 100 + n;
}

function cleanScreen(s) {
  const id = String(s?.id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`screen id '${id}' must be 1-32 chars: letters, digits, - or _`);
  const str = (v) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, 64));
  // Shown on this PC by the local screen viewer (localScreens.mjs): a monitor and an area of it.
  const l = s.local;
  const local = l && Number.isInteger(l.monitor) && l.monitor >= 0 && l.monitor < 16
    ? { monitor: l.monitor, area: ['full', 'left', 'right', 'top', 'bottom'].includes(l.area) ? l.area : 'full', fit: ['contain', 'fill', 'cover'].includes(l.fit) ? l.fit : 'contain' }
    : null;
  return { id, name: String(s.name ?? `Screen ${id}`).slice(0, 60), glass: str(s.glass), steam: str(s.steam), local };
}

// Per-aircraft choices, keeping only screens that exist and well-formed entries.
function cleanPerAircraft(v, screens) {
  const ids = new Set(screens.map((s) => s.id));
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [aircraft, m] of Object.entries(v).slice(0, 500)) {
    const name = String(aircraft).trim().slice(0, 128);
    if (!name || !m || typeof m !== 'object') continue;
    const entry = {};
    for (const [sid, o] of Object.entries(m)) {
      if (!ids.has(sid) || !o || (o.kind !== 'layout' && o.kind !== 'display')) continue;
      const id = String(o.id ?? '').slice(0, 64);
      if (id) entry[sid] = { kind: o.kind, id };
    }
    if (Object.keys(entry).length) out[name] = entry;
  }
  return out;
}
