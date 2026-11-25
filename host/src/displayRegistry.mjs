// Display registry: every glass display the host knows, growing on this computer as cockpits are flown.
//
//   built-in   config/displays.json (shipped): fixed ids such as pfd / mfd for the default G1000.
//   learned    <dataDir>/displays.json: added by themselves when the Community hook reports an instrument
//              that is big enough to be a display (MIN_W x MIN_H texture pixels), or by hand from the
//              monitor page. Each gets a unique pair of marker colours.
//
// A display is keyed by its instrument: the element tag, plus "#<n>" when the instrument's url carries
// Index=<n> (cockpits with two of the same, e.g. captain and first-officer PFDs). The hook gets the table
// (key -> id + marker) from the host at runtime, so new displays need no hook rebuild.
//
// Primary displays (PFD, MFD, EICAS and the like; guessed from the name, changeable on the monitor page)
// make a cockpit a glass cockpit for the screens; others (radios, GPS units) show only where assigned.
//
// Emits 'change' when displays are added, changed or removed.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makeLog } from './log.mjs';

const log = makeLog('displays');

export const MIN_W = 32; // every real instrument: radios (512x90), hour meters (230x45), ...
export const MIN_H = 16; // capture.dll ignores textures under 32x16
const MAX_DISPLAYS = 200;

export class DisplayRegistry extends EventEmitter {
  constructor({ builtIn, dataDir }) {
    super();
    this.file = path.join(dataDir, 'displays.json');
    this.builtIn = builtIn.map((d) => ({ primary: true, ...d, tags: d.tags.map((t) => t.toLowerCase()), builtIn: true }));
    this.learned = [];
    try {
      if (fs.existsSync(this.file)) {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')).displays;
        if (Array.isArray(saved)) this.learned = saved.filter(validLearned);
      }
    } catch (e) {
      log.warn(`cannot read ${this.file}: ${e.message}`);
    }
    log.info(`${this.builtIn.length} built-in and ${this.learned.length} learned displays`);
  }

  all() {
    return [...this.builtIn, ...this.learned];
  }

  get(id) {
    return this.all().find((d) => d.id === id) ?? null;
  }

  ids() {
    return this.all().map((d) => d.id);
  }

  /// The display for an instrument key ("tag" or "tag#n"), trying the exact key, then the bare tag.
  byKey(key) {
    const tag = key.split('#')[0];
    const all = this.all();
    return all.find((d) => d.tags.includes(key)) ?? all.find((d) => d.tags.includes(tag)) ?? null;
  }

  /// For the hook: instrument key -> { id, px: [[r,g,b],[r,g,b]] }.
  hookTable() {
    const table = {};
    for (const d of this.all()) for (const t of d.tags) table[t] = { id: d.id, px: d.marker };
    return table;
  }

  /// An instrument reported by the hook. Learns it as a display when it is big enough and new.
  /// Returns the display (existing or new), or null.
  consider(instrument, aircraft) {
    const known = this.byKey(instrument.key);
    if (known) {
      let dirty = false;
      if (known.learned && aircraft && !known.aircraft.includes(aircraft)) {
        known.aircraft = [...known.aircraft, aircraft].slice(-20);
        dirty = true;
      }
      if (known.learned && !known.size && instrument.w && instrument.h) {
        known.size = `${instrument.w}x${instrument.h}`;
        dirty = true;
      }
      if (dirty) this.save();
      return known;
    }
    // A WASM gauge reported without its gauge name (older hook): many different gauges would share it.
    if (instrument.key === 'wasm-instrument') return null;
    // Pages report their instruments before they are laid out (size 0). PFD/MFD-like ones are learned
    // right away, so a glass cockpit is recognised within seconds; the rest once their size is known.
    const sized = instrument.w > 0 && instrument.h > 0;
    if (!sized && !guessPrimary(instrument.key, instrument.url)) return null;
    if (sized && (instrument.w < MIN_W || instrument.h < MIN_H)) return null;
    return this.add(instrument, aircraft, 'detected');
  }

  /// Add an instrument as a display (detected, or by hand from the monitor page).
  add({ key, w, h, url }, aircraft, how = 'added') {
    if (!/^[a-z0-9_.:-]+(#\d{1,2})?$/.test(key ?? '')) throw new Error(`bad instrument key '${key}'`);
    if (this.byKey(key)?.tags.includes(key)) throw new Error(`'${key}' is already a display`);
    if (this.learned.length >= MAX_DISPLAYS) throw new Error('too many displays; forget some first');
    const d = {
      id: this.freeId(key),
      name: prettyName(key),
      tags: [key],
      marker: pickMarker(key, this.all().flatMap((x) => x.marker)),
      learned: true,
      primary: guessPrimary(key, url),
      size: w && h ? `${w}x${h}` : null,
      aircraft: aircraft ? [aircraft] : [],
      firstSeen: new Date().toISOString(),
    };
    this.learned.push(d);
    this.save();
    log.info(`new ${d.primary ? 'primary ' : ''}display '${d.id}' (${d.name}) ${how}: <${key}> ${d.size ?? ''}${aircraft ? ` in ${aircraft}` : ''}`);
    this.emit('change');
    return d;
  }

  /// Change a learned display: { name, primary }.
  update(id, { name, primary } = {}) {
    const d = this.learned.find((x) => x.id === id);
    if (!d) throw new Error(`no learned display '${id}'`);
    if (name !== undefined) d.name = String(name ?? '').trim().slice(0, 40) || d.name;
    if (primary !== undefined) d.primary = primary === true;
    this.save();
    this.emit('change');
    return d;
  }

  forget(id) {
    const before = this.learned.length;
    this.learned = this.learned.filter((x) => x.id !== id);
    if (this.learned.length === before) throw new Error(`no learned display '${id}'`);
    this.save();
    log.info(`display '${id}' forgotten`);
    this.emit('change');
  }

  freeId(key) {
    const base = key.replace('#', '-').replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'display';
    const taken = new Set(this.ids());
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ displays: this.learned }, null, 2));
    } catch (e) {
      log.warn(`cannot save ${this.file}: ${e.message}`);
    }
  }
}

/// PFD/MFD-like instruments: what makes a cockpit a glass cockpit.
export function guessPrimary(key, url) {
  // Controllers, keypads and backup instruments of a glass suite are not screens of their own
  // (e.g. the G3000's GTC touch controllers, whose names contain "g3000").
  if (/gtc|cdu|fmc|fms|keypad|kbd|controller|backup|standby|isis/i.test(key)) return false;
  return /pfd|mfd|eicas|efis|ecam|g3x|g3000|g5000|g1000|(^|[-_/:\s])(nd|ead|sd)([-_#./\s]|$)/i.test(`${key} ${url ?? ''}`);
}

function validLearned(d) {
  return d && typeof d.id === 'string' && Array.isArray(d.tags) && d.tags.length && Array.isArray(d.marker) && d.marker.length === 2
    ? Object.assign(d, { learned: true, primary: d.primary ?? guessPrimary(d.tags[0], ''), aircraft: Array.isArray(d.aircraft) ? d.aircraft : [] })
    : false;
}

const ACRONYMS = new Set(['eicas', 'efis', 'ecam', 'ahrs', 'fadec', 'tcas', 'egpws', 'cdu', 'fmc', 'mcdu', 'xpdr']);
// Developer codes at the start of a tag that say nothing to a pilot: "wt-737-max-mfd", "as05b-xpdr",
// "wtb38m-cdu". Product names such as wtg1000 or wt21 are kept.
const PREFIX = /^(wt|asobo|ini|as\d+[a-z]|wtb\d+[a-z])$/;

/// "wtg1000-pfd" -> "WTG1000 PFD", "wt21-pfd#2" -> "WT21 PFD 2", "hour-meter-element" -> "Hour Meter",
/// "wt-737-max-mfd#2" -> "737 MAX MFD 2", "as05b-xpdr-element" -> "XPDR".
export function prettyName(key) {
  const [full, n] = key.split('#');
  const tag = full.replace(/^wasm-instrument:/, ''); // WASM gauges: the gauge name only ("PFD")
  // "-element" is a common tag suffix that says nothing (kx155a-element -> KX155A).
  let parts = tag.split(/[-_.:]+/).filter((w) => w && w !== 'element');
  if (parts.length > 1 && PREFIX.test(parts[0])) parts = parts.slice(1);
  const words = parts.map((w) => (w.length <= 3 || /\d/.test(w) || ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  return (words.join(' ') + (n ? ` ${n}` : '')).slice(0, 40);
}

/// Two strongly coloured pixels (one channel low, one high, one in between), each at least 16 away in some
/// channel from every pixel in `taken` (capture.dll matches within 3): colours a cockpit display rarely
/// draws exactly at the marker point. Room for several hundred displays.
export function pickMarker(seedText, taken) {
  // Grid: low channel 5..53, high 185..249, middle 70..166, in steps of 16, for each order of channels:
  // 6 x 4 x 5 x 7 = 840 colours, all at least 16 apart. Tried in an order seeded by the instrument key.
  const lows = [5, 21, 37, 53], highs = [185, 201, 217, 233, 249], mids = [70, 86, 102, 118, 134, 150, 166];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const grid = [];
  for (const [lo, hi, mi] of perms)
    for (const a of lows) for (const b of highs) for (const m of mids) {
      const c = [0, 0, 0];
      c[lo] = a; c[hi] = b; c[mi] = m;
      grid.push(c);
    }
  let seed = [...seedText].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 0x1000000;
  for (let k = grid.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [grid[k], grid[j]] = [grid[j], grid[k]];
  }
  const far = (a, b) => a.some((v, n) => Math.abs(v - b[n]) >= 16);
  const free = grid.filter((c) => taken.every((t) => far(c, t)));
  if (free.length < 2) throw new Error('no free marker colours left');
  // The two pixels of one marker use different channel orders, so they never look alike.
  const second = free.find((c) => c.indexOf(Math.max(...c)) !== free[0].indexOf(Math.max(...free[0]))) ?? free[1];
  return [free[0], second];
}
