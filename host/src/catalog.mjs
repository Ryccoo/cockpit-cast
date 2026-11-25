// Display catalog for the layout editor's Insert window: every glass display this computer has seen,
// grouped by the aircraft it was seen in (one display can belong to several aircraft), plus the
// displays in the cockpit loaded now.
//
// It also keeps the last picture of each display (<dataDir>/thumbs/<id>.jpg, refreshed at most once a
// minute while the display is captured), so displays of aircraft not loaded now still show a picture
// and their parts can be picked with the sim closed. Served at /thumb/<id>.jpg. While an editor is open
// (setViewers), displays in the loaded cockpit that nobody watches are captured briefly at 1 fps
// (wanted()) when their picture is missing or older than REFRESH_MS. With no editor open nothing extra
// is captured: pictures are then only saved from frames that clients already get.
//
// Emits 'change' (debounced) when the catalog changes, 'wanted' when wanted() changes.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makeLog } from './log.mjs';

const log = makeLog('catalog');
const SAVE_EVERY_MS = 60_000;
const SETTLE_MS = 5_000; // skip the first seconds of a display: often still loading
const REFRESH_MS = 10 * 60_000; // grab a new picture of an unwatched display this often
const GIVE_UP_MS = 15_000; // stop asking for a display that sends nothing (or only blank pictures)
// Grabs at a time: capture.dll has 16 slots, shared with what clients watch; big cockpits (the 737 has
// 26 displays) take their turns.
const MAX_GRABS = 4;

export class DisplayCatalog extends EventEmitter {
  constructor({ registry, instruments, hook, sim, hub, dataDir }) {
    super();
    this.registry = registry;
    this.instruments = instruments;
    this.hook = hook;
    this.sim = sim;
    this.dir = path.join(dataDir, 'thumbs');
    this.thumbAt = new Map(); // id -> ms of the saved picture
    this.liveSince = new Map(); // id -> ms of the first frame in this run of frames
    this.saving = new Set();
    this.timer = null;
    this.grabbing = new Map(); // id -> ms the grab started (wanted at 1 fps until a picture is saved)
    this.lastTry = new Map(); // id -> ms of the last grab
    this.viewers = 0; // editors subscribed to the catalog
    this.sweepTimer = setInterval(() => this.sweep(), 5_000);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^(.+)\.jpg$/.exec(f);
        if (m) this.thumbAt.set(m[1], fs.statSync(path.join(this.dir, f)).mtimeMs);
      }
    } catch (e) {
      log.warn(`cannot read ${this.dir}: ${e.message}`);
    }
    hub.on('frame', (d) => this.onFrame(d));
    hub.on('displays', () => {
      for (const d of hub.list()) if (!d.live) this.liveSince.delete(d.id);
    });
    registry.on('change', () => {
      this.dropForgotten();
      this.changed();
    });
    instruments.on('change', () => this.changed());
    hook.on('status', () => {
      this.changed();
      this.sweep();
    });
    sim.on('status', () => this.changed());
    this.dropForgotten();
  }

  changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const json = JSON.stringify(this.build());
      if (json === this.last) return;
      this.last = json;
      this.emit('change');
    }, 500);
  }

  /// The saved picture of a display, or null.
  thumbFile(id) {
    return this.thumbAt.has(id) ? path.join(this.dir, `${id}.jpg`) : null;
  }

  onFrame(d) {
    const now = Date.now();
    if (!this.liveSince.has(d.id)) this.liveSince.set(d.id, now);
    if (now - this.liveSince.get(d.id) < SETTLE_MS || this.saving.has(d.id)) return;
    if (now - (this.thumbAt.get(d.id) ?? 0) < SAVE_EVERY_MS || !this.registry.get(d.id)) return;
    // The client frame is a CLF1 header (21 bytes + id) followed by the JPEG.
    const jpeg = d.frame.subarray(21 + Buffer.byteLength(d.id, 'ascii'));
    // A tiny JPEG is an (almost) blank picture: a display still booting or switched off. Keep the
    // previous picture and try again later. (A booting G1000 PFD: 13 KB at 1024x768; showing: 100+ KB.)
    if (jpeg.length < (d.width * d.height) / 40) return;
    const file = path.join(this.dir, `${d.id}.jpg`);
    const first = !this.thumbAt.has(d.id);
    this.saving.add(d.id);
    fs.promises
      .writeFile(`${file}.tmp`, jpeg)
      .then(() => fs.promises.rename(`${file}.tmp`, file))
      .then(() => {
        this.thumbAt.set(d.id, now);
        if (first) this.changed();
        this.sweep();
      })
      .catch((e) => log.warn(`cannot save picture of ${d.id}: ${e.message}`))
      .finally(() => this.saving.delete(d.id));
  }

  /// Displays to capture for a picture: id -> fps (merged into the clients' subscriptions).
  wanted() {
    return new Map([...this.grabbing.keys()].map((id) => [id, 1]));
  }

  /// Number of editors open (catalog subscribers). Grabs happen only while there is one.
  setViewers(n) {
    if (n === this.viewers) return;
    this.viewers = n;
    this.sweep();
  }

  sweep() {
    const now = Date.now();
    const present = this.viewers > 0 ? this.hook.present() : new Set();
    let changed = false;
    for (const [id, at] of this.grabbing) {
      const done = now - (this.thumbAt.get(id) ?? 0) < REFRESH_MS;
      if (done || !present.has(id) || now - at > GIVE_UP_MS) {
        this.grabbing.delete(id);
        changed = true;
      }
    }
    for (const id of present) {
      if (this.grabbing.size >= MAX_GRABS) break;
      if (this.grabbing.has(id) || !this.registry.get(id)) continue;
      if (now - (this.thumbAt.get(id) ?? 0) < REFRESH_MS || now - (this.lastTry.get(id) ?? 0) < REFRESH_MS) continue;
      this.grabbing.set(id, now);
      this.lastTry.set(id, now);
      changed = true;
    }
    if (changed) this.emit('wanted');
  }

  close() {
    clearInterval(this.sweepTimer);
    clearTimeout(this.timer);
  }

  dropForgotten() {
    const ids = new Set(this.registry.ids());
    for (const id of [...this.thumbAt.keys()]) {
      if (ids.has(id)) continue;
      this.thumbAt.delete(id);
      fs.promises.rm(path.join(this.dir, `${id}.jpg`), { force: true }).catch(() => {});
    }
  }

  /// {
  ///   simRunning, aircraft (loaded now, or null), present: [ids in the loaded cockpit],
  ///   aircraftList: [{ name, lastSeen, displays: [ids] }] (most recently flown first),
  ///   displays: { id: { name, primary, size, builtIn, thumbAt, aircraft: [names] } }
  /// }
  build() {
    const s = this.sim.status();
    const present = [...this.hook.present()];
    const current = s.connected ? this.instruments.aircraft : null;
    const byAircraft = new Map(); // name -> { lastSeen, ids: Set }
    const note = (name, id, lastSeen) => {
      if (!name || !id) return;
      const a = byAircraft.get(name) ?? { lastSeen: lastSeen ?? '', ids: new Set() };
      if (lastSeen && lastSeen > a.lastSeen) a.lastSeen = lastSeen;
      a.ids.add(id);
      byAircraft.set(name, a);
    };
    // The instrument log knows every instrument of every aircraft flown; map each to its display.
    for (const [name, entry] of Object.entries(this.instruments.byAircraft)) {
      for (const i of Object.values(entry.instruments ?? {})) note(name, this.registry.byKey(i.key)?.id, entry.lastSeen);
    }
    // Learned displays also remember their aircraft (covers logs from before the instrument log existed).
    for (const d of this.registry.all()) for (const name of d.aircraft ?? []) note(name, d.id, null);
    if (current) for (const id of present) note(current, id, new Date().toISOString());

    const displays = {};
    for (const d of this.registry.all()) {
      displays[d.id] = {
        name: d.name ?? d.id.toUpperCase(),
        primary: d.primary !== false,
        size: d.size ?? null,
        builtIn: !!d.builtIn,
        thumbAt: this.thumbAt.get(d.id) ?? null,
        aircraft: [],
      };
    }
    const aircraftList = [...byAircraft]
      .map(([name, a]) => ({ name, lastSeen: a.lastSeen || null, displays: [...a.ids].filter((id) => displays[id]) }))
      .filter((a) => a.displays.length)
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '') || a.name.localeCompare(b.name));
    for (const a of aircraftList) for (const id of a.displays) displays[id].aircraft.push(a.name);
    return { simRunning: !!s.connected, aircraft: current, present: present.filter((id) => displays[id]), aircraftList, displays };
  }
}
