// Instrument log: which instruments each aircraft's cockpit holds, as reported by the Community hook
// (one list per instrument page). Used to find out what else can be captured as a glass display: every
// instrument the sim draws on a page is a candidate, captured or not.
//
// New instruments are written to the host log; the full record per aircraft is kept in
// <dataDir>/instruments.json and shown on the monitor page (GET /api/instruments).

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makeLog } from './log.mjs';

const log = makeLog('instruments');

export class InstrumentLog extends EventEmitter {
  constructor({ dataDir, sim, hook, registry }) {
    super();
    this.file = path.join(dataDir, 'instruments.json');
    this.sim = sim;
    this.registry = registry; // learns the big instruments as displays
    // Instruments in the cockpit now: key -> { at, page, texture, instrument }. Keyed by instrument,
    // not page: every instrument view in the sim has the same page path.
    this.live = new Map();
    this.byAircraft = {};
    try {
      if (fs.existsSync(this.file)) this.byAircraft = JSON.parse(fs.readFileSync(this.file, 'utf8')).aircraft ?? {};
    } catch (e) {
      log.warn(`cannot read ${this.file}: ${e.message}`);
    }
    this.aircraft = null;
    this.changedAt = 0; // last time an instrument was added to the loaded cockpit
    this.saveTimer = null;
    hook.on('instruments', (r) => this.onReport(r));
    sim.on('status', () => this.syncAircraft());
  }

  /// Follow the sim's aircraft. On a change, pages reported more than a few seconds earlier belonged to
  /// the previous cockpit and are dropped; pages that reported before the name was known are filed now.
  syncAircraft() {
    const a = this.sim.status().aircraft;
    if (!a || a === this.aircraft) return;
    if (this.aircraft !== null) {
      for (const [k, r] of this.live) if (Date.now() - r.at > 5000) this.live.delete(k);
    }
    this.aircraft = a;
    for (const r of this.live.values()) this.record(r.page, { texture: r.texture, instruments: [r.instrument] });
    this.emit('change');
  }

  onReport({ page, texture, instruments }) {
    this.syncAircraft();
    const at = Date.now();
    for (const i of instruments) {
      if (!this.live.has(i.key)) this.changedAt = at;
      this.live.set(i.key, { at, page, texture, instrument: i });
      try {
        this.registry.consider(i, this.aircraft);
      } catch (e) {
        log.warn(`cannot add <${i.key}> as a display: ${e.message}`);
      }
    }
    this.record(page, { texture, instruments });
    this.emit('change');
  }

  record(page, { texture, instruments }) {
    const name = this.aircraft;
    if (!name) return; // filed once the aircraft is known (syncAircraft)
    const now = new Date().toISOString();
    const entry = (this.byAircraft[name] ??= { firstSeen: now, instruments: {} });
    entry.lastSeen = now;
    for (const i of instruments) {
      const prev = entry.instruments[i.key];
      const next = {
        key: i.key,
        tag: i.tag,
        url: i.url,
        templateID: i.templateID,
        identifier: i.identifier,
        size: i.w && i.h ? `${i.w}x${i.h}` : (prev?.size ?? null),
        page,
        pageSize: texture ? `${texture.w}x${texture.h}` : null,
        capturedAs: this.capturedAs(i.key),
        firstSeen: prev?.firstSeen ?? now,
      };
      if (!prev) {
        log.info(
          `${name}: <${i.key}> ${next.size ?? '?'} ` +
            (next.capturedAs ? `(display ${next.capturedAs})` : '(not a display)') +
            (i.url ? ` ${i.url}` : ''),
        );
      }
      entry.instruments[i.key] = { ...next, lastSeen: now };
    }
    this.scheduleSave();
  }

  /// The loaded cockpit's instruments as reported so far, and when that list last grew.
  cockpit() {
    return { aircraft: this.aircraft, instruments: [...this.live.values()].map((r) => r.instrument), changedAt: this.changedAt };
  }

  capturedAs(key) {
    return this.registry.byKey(key)?.id ?? null;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 5000);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ aircraft: this.byAircraft }, null, 2));
    } catch (e) {
      log.warn(`cannot save ${this.file}: ${e.message}`);
    }
  }

  /// For the API and the monitor page: the cockpit loaded now (largest first), plus everything seen before.
  report() {
    const current = [];
    for (const r of this.live.values()) {
      current.push({
        ...r.instrument,
        page: r.page,
        pageSize: r.texture ? `${r.texture.w}x${r.texture.h}` : null,
        capturedAs: this.capturedAs(r.instrument.key),
        ageSec: Math.round((Date.now() - r.at) / 1000),
      });
    }
    current.sort((a, b) => b.w * b.h - a.w * a.h);
    return { aircraft: this.aircraft, current, byAircraft: this.byAircraft };
  }

  close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }
}
