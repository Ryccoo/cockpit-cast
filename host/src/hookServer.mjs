// WebSocket endpoint /hook for the Community hook running inside the sim's instrument pages.
// See docs/protocol.md section 3.
//
// Every instrument page connects and reports which instruments it holds ('instruments' event, used by the
// display registry and the instrument log). The host answers with the display table (instrument key ->
// display id + marker colours), again whenever it changes. Pages that hold a display in that table paint
// its marker and report where it sits in the page's texture (read point and crop, in texture pixels).

import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { makeLog } from './log.mjs';

const log = makeLog('hook');
const KEY = /^[a-z0-9_.:-]{1,80}(#\d{1,2})?$/;

export class HookServer extends EventEmitter {
  constructor({ registry }) {
    super();
    this.registry = registry;
    this.pages = new Set(); // { ws, name, displays: Map(id -> layout) }
    this.layouts = new Map(); // id -> latest layout from any page (kept after the page goes away)
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
    this.wss.on('connection', (ws, req) => this.onPage(ws, req));
    registry.on('change', () => this.sendTable());
  }

  onPage(ws, req) {
    const addr = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return ws.close(1008, 'local only');
    const page = { ws, displays: new Map(), name: null, version: null };
    this.pages.add(page);
    this.sendTable(page);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        page.name = String(msg.page ?? '').slice(0, 200);
        page.version = msg.version ? String(msg.version).slice(0, 40) : null;
        this.emit('status');
      } else if (msg.type === 'layout') this.onLayout(page, msg);
      else if (msg.type === 'instruments') this.onInstruments(msg);
    });
    ws.on('close', () => {
      this.pages.delete(page);
      if (page.displays.size) log.info(`page closed: ${[...page.displays.keys()].join(', ')}`);
      this.emit('status');
    });
    ws.on('error', () => {});
  }

  sendTable(only) {
    const msg = JSON.stringify({ type: 'displays', table: this.registry.hookTable() });
    for (const p of only ? [only] : this.pages) {
      try {
        p.ws.send(msg);
      } catch {}
    }
  }

  onLayout(page, msg) {
    const ids = new Set(this.registry.ids());
    const seen = new Set();
    let changed = false;
    for (const d of Array.isArray(msg.displays) ? msg.displays : []) {
      if (!ids.has(d?.id)) continue;
      seen.add(d.id);
      const layout = {
        tag: String(d.tag ?? '').slice(0, 84),
        read: { x: int(d.read?.x), y: int(d.read?.y) },
        crop: d.crop ? { w: int(d.crop.w), h: int(d.crop.h) } : null,
        texture: d.texture ? { w: int(d.texture.w), h: int(d.texture.h) } : null,
        at: Date.now(),
      };
      if (layout.crop && (layout.crop.w < 16 || layout.crop.h < 16)) layout.crop = null; // hidden or collapsed
      const prev = this.layouts.get(d.id);
      if (!page.displays.has(d.id)) log.info(`page holds ${d.id} (${layout.tag})`);
      page.displays.set(d.id, layout);
      this.layouts.set(d.id, layout);
      if (!prev || !sameLayout(prev, layout)) {
        log.info(`${d.id} (${layout.tag}): texture ${fmt(layout.texture)}, display ${fmt(layout.crop)} at ${layout.read.x},${layout.read.y}`);
        changed = true;
      }
    }
    // The page's list is complete: displays it no longer reports are gone from it.
    for (const id of [...page.displays.keys()]) if (!seen.has(id)) page.displays.delete(id);
    if (changed) this.emit('layouts', this.layouts);
    this.emit('status');
  }

  onInstruments(msg) {
    const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
    const list = (Array.isArray(msg.instruments) ? msg.instruments : []).slice(0, 64).flatMap((i) => {
      const tag = str(i?.tag, 80);
      const key = str(i?.key, 84) ?? tag;
      if (!tag || !key || !KEY.test(key) || !KEY.test(tag)) return [];
      return [{ key, tag, url: str(i.url, 300), templateID: str(i.templateID, 80), identifier: str(i.identifier, 80), w: int(i.w), h: int(i.h) }];
    });
    const texture = msg.texture ? { w: int(msg.texture.w), h: int(msg.texture.h) } : null;
    this.emit('instruments', { page: str(msg.page, 200), texture, instruments: list });
  }

  /// Displays held by connected pages right now (the cockpit that is loaded).
  present() {
    const live = new Set();
    for (const p of this.pages) for (const id of p.displays.keys()) live.add(id);
    return live;
  }

  status() {
    const versions = [...new Set([...this.pages].map((p) => p.version).filter(Boolean))];
    return { connected: this.pages.size > 0, pages: this.pages.size, displays: [...this.present()].sort(), versions };
  }

  detail() {
    return Object.fromEntries([...this.layouts].map(([id, l]) => [id, { ...l, ageSec: Math.round((Date.now() - l.at) / 1000) }]));
  }

  close() {
    for (const p of this.pages) p.ws.terminate();
    this.wss.close();
  }
}

function int(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n < 65536 ? n : 0;
}

function fmt(s) {
  return s ? `${s.w}x${s.h}` : '?';
}

function sameLayout(a, b) {
  return JSON.stringify([a.read, a.crop, a.texture, a.tag]) === JSON.stringify([b.read, b.crop, b.texture, b.tag]);
}
