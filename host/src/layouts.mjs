// Gauge layouts, shared by all clients. Stored in %LOCALAPPDATA%\CockpitCast\layouts.json; the
// defaults in host/defaults/layouts.json are used until the user saves their own.
//
// Layout: { id, name, width, height, gauges: [ { id, type, x, y, w, h, options } ] }
// Items are steam gauges (drawn by the client from sim data) or 'glass': a captured display, or part of
// one, with options { display, crop?: { x, y, w, h } as fractions of the picture, fit?: contain|cover|fill }.
// Coordinates are in the layout's own units (e.g. 1200 x 800); clients scale the whole layout to fit
// their screen, keeping its shape.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLog } from './log.mjs';

const log = makeLog('layouts');
const DEFAULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults', 'layouts.json');
const GAUGE_TYPES = new Set(['asi', 'attitude', 'altimeter', 'turn', 'heading', 'vsi', 'dial', 'cdi', 'adf', 'clock', 'glass']);

export class LayoutStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.file = path.join(dataDir, 'layouts.json');
    this.layouts = this.load();
  }

  defaults() {
    return JSON.parse(fs.readFileSync(DEFAULTS, 'utf8')).layouts;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const list = JSON.parse(fs.readFileSync(this.file, 'utf8')).layouts;
        if (Array.isArray(list)) return list;
      }
    } catch (e) {
      log.warn(`cannot read ${this.file} (${e.message}); using the default layouts`);
    }
    return this.defaults();
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ layouts: this.layouts }, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit('change', this.layouts);
  }

  list() {
    return this.layouts;
  }

  /// Add or replace a layout (by id). Throws with a readable message if it is not valid.
  save(layout) {
    const clean = validate(layout);
    const i = this.layouts.findIndex((l) => l.id === clean.id);
    if (i >= 0) this.layouts[i] = clean;
    else this.layouts.push(clean);
    this.persist();
    log.info(`saved layout "${clean.name}" (${clean.gauges.length} gauges)`);
    return clean;
  }

  delete(id) {
    const before = this.layouts.length;
    this.layouts = this.layouts.filter((l) => l.id !== id);
    if (this.layouts.length === before) throw new Error(`no layout '${id}'`);
    this.persist();
    log.info(`deleted layout ${id}`);
  }

  resetDefaults() {
    this.layouts = this.defaults();
    this.persist();
    log.info('layouts reset to defaults');
  }
}

function glassOptions(o, i) {
  const display = String(o?.display ?? '').slice(0, 64);
  if (!display) throw new Error(`item ${i + 1}: glass item needs a display`);
  const out = { display, fit: ['contain', 'cover', 'fill'].includes(o.fit) ? o.fit : 'contain' };
  const c = o.crop;
  if (c && typeof c === 'object') {
    const f = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    const x = f(c.x), y = f(c.y), w = Math.min(f(c.w), 1 - x), h = Math.min(f(c.h), 1 - y);
    if (w >= 0.01 && h >= 0.01 && !(x === 0 && y === 0 && w === 1 && h === 1)) out.crop = { x, y, w, h };
  }
  return out;
}

function validate(l) {
  if (!l || typeof l !== 'object') throw new Error('layout must be an object');
  const id = String(l.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error('layout id must be 1-64 chars: a-z, 0-9, - or _');
  const num = (v, name, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be a number from ${lo} to ${hi}`);
    return n;
  };
  const width = num(l.width, 'width', 100, 10000);
  const height = num(l.height, 'height', 100, 10000);
  if (!Array.isArray(l.gauges) || l.gauges.length > 64) throw new Error('gauges must be a list of at most 64');
  const gauges = l.gauges.map((g, i) => {
    if (!GAUGE_TYPES.has(g?.type)) throw new Error(`gauge ${i + 1}: unknown type '${g?.type}'`);
    return {
      id: String(g.id ?? `g${i + 1}`).slice(0, 64),
      type: g.type,
      x: num(g.x, `gauge ${i + 1} x`, -width, width * 2),
      y: num(g.y, `gauge ${i + 1} y`, -height, height * 2),
      w: num(g.w, `gauge ${i + 1} w`, 10, width * 2),
      h: num(g.h, `gauge ${i + 1} h`, 10, height * 2),
      options: g.type === 'glass' ? glassOptions(g.options, i) : g.options && typeof g.options === 'object' ? g.options : {},
    };
  });
  return { id, name: String(l.name ?? id).slice(0, 80), width, height, gauges };
}
