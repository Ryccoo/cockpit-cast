// HTTP + WebSocket server for client apps. See docs/protocol.md section 2.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from './protocol.mjs';
import { SIMVARS, SIMVAR_KEYS } from './simvars.mjs';
import { makeLog } from './log.mjs';

const log = makeLog('clients');
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BUFFERED = 1024 * 1024;
const PAGES = { '/': 'monitor.html', '/monitor.html': 'monitor.html', '/editor': 'editor.html', '/editor.html': 'editor.html', '/update-banner.js': 'update-banner.js' }; // skip frames for a client with more than this unsent

export class ClientServer {
  constructor({ port, hub, getStatus, getDetail = () => ({}), onWanted = () => {}, onDataWanted = () => {}, onInstallUpdate = null, layouts = null, screens = null, catalog = null, maxDataHz = 60, version, dataDir = null }) {
    // Paused apps (by device and window): they get nothing, so nothing is captured for them. Kept on disk.
    this.pausedFile = dataDir ? path.join(dataDir, 'paused-apps.json') : null;
    this.paused = new Set();
    try {
      if (this.pausedFile && fs.existsSync(this.pausedFile)) this.paused = new Set(JSON.parse(fs.readFileSync(this.pausedFile, 'utf8')).paused ?? []);
    } catch {}
    this.appsTimer = setInterval(() => this.sendApps(), 2000);
    this.onInstallUpdate = onInstallUpdate;
    this.layouts = layouts;
    this.catalog = catalog;
    this.screens = screens;
    this.onDataWanted = onDataWanted;
    this.maxDataHz = maxDataHz;
    this.dataWanted = false;
    this.port = port;
    this.hub = hub;
    this.getStatus = getStatus;
    this.getDetail = getDetail;
    this.onWanted = onWanted;
    this.version = version;
    this.clients = new Set();
    this.nextId = 1;
    this.upgrades = new Map(); // path -> WebSocketServer (noServer)
    this.api = new Map(); // 'METHOD /path' -> async (req, body) => json; loopback callers only
  }

  /// Extra WebSocket endpoint on the same port (e.g. /hook for the Community hook).
  addUpgrade(path, wss) {
    this.upgrades.set(path, wss);
  }

  /// Local-only HTTP API endpoint. The handler returns a JSON-able value.
  addApi(method, path, fn) {
    this.api.set(`${method} ${path}`, fn);
  }

  start() {
    this.http = http.createServer((req, res) => this.onHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.onClient(ws, req));
    this.upgrades.set('/ws', this.wss);
    this.http.on('upgrade', (req, socket, head) => {
      const wss = this.upgrades.get(new URL(req.url, 'http://x').pathname);
      if (!wss) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    this.hub.on('frame', (d) => {
      for (const c of this.clients) if (c.subs.has(d.id)) this.trySend(c, d.id);
    });
    this.hub.on('displays', () => this.broadcast({ type: 'displays', displays: this.hub.list() }));
    this.catalog?.on('change', () => {
      const msg = { type: 'catalog', ...this.catalog.build() };
      for (const c of this.clients) if (c.catalog) this.send(c, msg);
    });
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, () => {
        log.info(`listening on port ${this.port}`);
        resolve();
      });
    });
  }

  onHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    const api = this.api.get(`${req.method} ${url.pathname}`);
    if (api) {
      if (!isLoopback(req.socket.remoteAddress)) return void res.writeHead(403).end('local only');
      Promise.resolve()
        .then(() => api(req))
        .then((out) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(out ?? { ok: true }, null, 2));
        })
        .catch((e) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        });
      return;
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(this.fullStatus(), null, 2));
      return;
    }
    // Saved picture of a display (editor: displays not in the loaded cockpit).
    const thumb = /^\/thumb\/([a-z0-9_-]+)\.jpg$/.exec(url.pathname);
    if (thumb) {
      const file = this.catalog?.thumbFile(thumb[1]);
      if (!file) return void res.writeHead(404).end('not found');
      fs.readFile(file, (err, data) => {
        if (err) return void res.writeHead(404).end('not found');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' });
        res.end(data);
      });
      return;
    }
    // Static scripts for the pages (e.g. /gauges.js).
    const asset = /^\/([a-z0-9-]+\.js)$/.exec(url.pathname);
    if (asset) {
      fs.readFile(path.join(PUBLIC_DIR, asset[1]), (err, data) => {
        if (err) return void res.writeHead(404).end('not found');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(data);
      });
      return;
    }
    const page = PAGES[url.pathname];
    if (page) {
      fs.readFile(path.join(PUBLIC_DIR, page), (err, data) => {
        if (err) {
          res.writeHead(500).end(`${page} missing`);
          return;
        }
        const type = page.endsWith('.js') ? 'text/javascript' : 'text/html';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(data);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }

  onClient(ws, req) {
    const c = { id: this.nextId++, ws, name: null, addr: String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), subs: new Map(), sent: 0, skipped: 0, delaySum: 0, delayMax: 0, kind: 'app', paused: false, since: Date.now(), fps: 0, lastCount: 0 };
    this.clients.add(c);
    log.info(`client #${c.id} connected from ${c.addr}`);
    this.send(c, { type: 'welcome', protocol: PROTOCOL_VERSION, host: os.hostname(), version: this.version });
    this.send(c, { type: 'displays', displays: this.hub.list() });
    this.send(c, { type: 'status', ...this.getStatus() });
    if (this.layouts) this.send(c, { type: 'layouts', layouts: this.layouts.list() });
    if (this.screens) this.send(c, { type: 'screens', screens: this.screens.list(), ...this.screens.extra() });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.send(c, { type: 'error', message: 'invalid JSON' });
      }
      this.onMessage(c, msg);
    });
    ws.on('close', () => {
      for (const s of c.subs.values()) clearTimeout(s.timer);
      this.clients.delete(c);
      this.appsChanged();
      if (c.catalog) this.catalogViewersChanged();
      this.wantedChanged();
      this.dataWantedChanged();
      log.info(`client #${c.id}${c.name ? ` "${c.name}"` : ''} disconnected (sent ${c.sent}, skipped ${c.skipped})`);
    });
    ws.on('error', () => {});
  }

  onMessage(c, msg) {
    switch (msg.type) {
      case 'hello': {
        const str = (v, n = 64) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));
        c.name = str(msg.client);
        // Apps say which device and window they are, and what they show (older apps only send a name).
        c.device = str(msg.device);
        c.window = str(msg.window, 32);
        c.shows = str(msg.shows, 80);
        c.appVersion = str(msg.version, 16);
        c.platform = str(msg.platform, 16);
        c.kind = c.name === 'Layout editor' ? 'editor' : c.name === 'Debug monitor' ? 'monitor' : msg.role === 'settings' ? 'settings' : 'app';
        c.key = c.device ? `${c.device}|${c.window ?? ''}` : `${c.addr}|${c.name ?? ''}`;
        log.info(`client #${c.id} is "${c.name}"${c.window ? ` ${c.window}` : ''}${c.shows ? ` (${c.shows})` : ''} (protocol ${msg.protocol}${c.appVersion ? `, app ${c.appVersion}` : ''})`);
        if (c.kind === 'app' && this.paused.has(c.key)) this.setPaused(c, true, false);
        this.appsChanged();
        break;
      }
      case 'shows': // an app's content changed (e.g. another screen chosen)
        c.shows = String(msg.shows ?? '').slice(0, 80) || null;
        this.appsChanged();
        break;
      case 'subscribeApps': // the monitor page: the list of connected apps, now and every 2 s
        c.watchApps = true;
        this.sendApps(c);
        break;
      case 'unsubscribeApps':
        c.watchApps = false;
        break;
      case 'appAction': { // from the monitor page: { id, action: 'pause' | 'resume' | 'identify' }
        const t = [...this.clients].find((x) => x.id === Number(msg.id));
        if (!t) return this.send(c, { type: 'error', message: 'that app is no longer connected' });
        if (msg.action === 'pause' || msg.action === 'resume') this.setPaused(t, msg.action === 'pause', true);
        else if (msg.action === 'identify') this.send(t, { type: 'identify', seconds: 8 });
        this.sendApps();
        break;
      }
      case 'subscribe': {
        const id = String(msg.display ?? '');
        if (!id) return this.send(c, { type: 'error', message: 'subscribe needs "display"' });
        // Down to 0.2 fps: the editor's insert window previews every display slowly.
        const maxFps = clamp(Number(msg.maxFps) || 30, 0.2, 60);
        const prev = c.subs.get(id);
        if (prev) clearTimeout(prev.timer);
        c.subs.set(id, { maxFps, lastSentAt: 0, lastSeq: -1, timer: null });
        log.info(`client #${c.id} subscribed to ${id} @ ${maxFps} fps`);
        this.wantedChanged();
        this.trySend(c, id);
        break;
      }
      case 'unsubscribe': {
        const s = c.subs.get(String(msg.display ?? ''));
        if (s) clearTimeout(s.timer);
        c.subs.delete(String(msg.display ?? ''));
        this.wantedChanged();
        break;
      }
      case 'subscribeData': {
        const maxHz = clamp(Number(msg.maxHz) || 30, 1, this.maxDataHz);
        c.data = { maxHz, lastAt: 0 };
        this.send(c, { type: 'dataVars', vars: SIMVAR_KEYS, info: SIMVARS.map(({ key, name, unit }) => ({ key, name, unit })) });
        log.info(`client #${c.id} subscribed to gauge data @ ${maxHz} Hz`);
        this.dataWantedChanged();
        break;
      }
      case 'subscribeCatalog':
        // The editor: every display seen, by aircraft. Sent now and on every change.
        if (!this.catalog) return this.send(c, { type: 'error', message: 'catalog not available' });
        c.catalog = true;
        this.catalogViewersChanged();
        this.send(c, { type: 'catalog', ...this.catalog.build() });
        break;
      case 'unsubscribeCatalog':
        c.catalog = false;
        this.catalogViewersChanged();
        break;
      case 'unsubscribeData':
        c.data = null;
        this.dataWantedChanged();
        break;
      case 'saveLayout':
        if (!this.layouts) return this.send(c, { type: 'error', message: 'layouts not available' });
        try {
          const saved = this.layouts.save(msg.layout);
          this.send(c, { type: 'layoutSaved', id: saved.id });
        } catch (e) {
          this.send(c, { type: 'error', message: `layout not saved: ${e.message}` });
        }
        break;
      case 'deleteLayout':
        try {
          this.layouts?.delete(String(msg.id ?? ''));
        } catch (e) {
          this.send(c, { type: 'error', message: e.message });
        }
        break;
      case 'resetLayouts':
        this.layouts?.resetDefaults();
        break;
      case 'installUpdate': // the update banner in the editor or monitor; pages on this PC only
        if (!isLoopback(c.addr)) this.send(c, { type: 'error', message: 'updates can be installed only from the sim PC' });
        else if (this.onInstallUpdate) this.onInstallUpdate().catch((e) => this.send(c, { type: 'error', message: `update failed: ${e.message}` }));
        break;
      case 'setScreens':
        try {
          this.screens?.setAssignments(msg.screens, msg.aircraft);
        } catch (e) {
          this.send(c, { type: 'error', message: `screens not saved: ${e.message}` });
        }
        break;
      default:
        this.send(c, { type: 'error', message: `unknown message type '${msg.type}'` });
    }
  }

  /// Pause or resume an app: a paused app gets no frames and no gauge data, so nothing is captured or
  /// read from the sim for it alone. The app shows "Paused". Remembered (device and window) on this PC.
  setPaused(c, on, remember) {
    if (c.paused === on) return;
    c.paused = on;
    if (remember && c.key) {
      if (on) this.paused.add(c.key);
      else this.paused.delete(c.key);
      this.savePaused();
    }
    log.info(`client #${c.id}${c.name ? ` "${c.name}"` : ''}${c.window ? ` ${c.window}` : ''} ${on ? 'paused' : 'resumed'}`);
    this.send(c, { type: 'paused', paused: on });
    this.wantedChanged();
    this.dataWantedChanged();
    if (!on) for (const id of c.subs.keys()) this.trySend(c, id);
  }

  savePaused() {
    if (!this.pausedFile) return;
    try {
      fs.mkdirSync(path.dirname(this.pausedFile), { recursive: true });
      fs.writeFileSync(this.pausedFile, JSON.stringify({ paused: [...this.paused] }, null, 2));
    } catch (e) {
      log.warn(`cannot save ${this.pausedFile}: ${e.message}`);
    }
  }

  /// Connected apps (not the editor or monitor pages), for the monitor page and the tray.
  apps() {
    return [...this.clients].filter((c) => c.kind === 'app' || c.kind === 'settings').map((c) => ({
      id: c.id,
      name: c.device ?? c.name ?? `client #${c.id}`,
      window: c.window ?? null,
      kind: c.kind,
      shows: c.shows ?? null,
      address: c.addr,
      version: c.appVersion ?? null,
      platform: c.platform ?? null,
      paused: c.paused,
      displays: [...c.subs.keys()],
      gauges: !!c.data,
      fps: Math.round(c.fps * 10) / 10,
      connectedSec: Math.round((Date.now() - c.since) / 1000),
      canPause: c.kind === 'app',
    }));
  }

  appsInfo() {
    let apps = 0, paused = 0, pages = 0;
    for (const c of this.clients) {
      if (c.kind === 'app') {
        apps++;
        if (c.paused) paused++;
      } else if (c.kind !== 'settings') pages++;
    }
    return { apps, paused, pages };
  }

  appsChanged() {
    clearTimeout(this.appsSoon);
    this.appsSoon = setTimeout(() => this.sendApps(), 100);
  }

  /// To the monitor pages that watch the list (all of them, or one).
  sendApps(only = null) {
    const now = Date.now();
    for (const c of this.clients) {
      const dt = (now - (c.countAt ?? c.since)) / 1000;
      if (dt >= 1.5) {
        c.fps = (c.sent - c.lastCount) / dt;
        c.lastCount = c.sent;
        c.countAt = now;
      }
    }
    const watchers = only ? [only] : [...this.clients].filter((c) => c.watchApps);
    if (!watchers.length) return;
    const text = JSON.stringify({ type: 'apps', apps: this.apps(), ...this.appsInfo() });
    for (const w of watchers) if (w.ws.readyState === 1) w.ws.send(text);
  }

  /// Setup mode: an editor or monitor page is open and visible (it watches the catalog or displays).
  /// Otherwise only client screens are served (streaming).
  setupInfo() {
    let editors = 0, monitors = 0;
    for (const c of this.clients) {
      if (c.name === 'Layout editor' && c.catalog) editors++;
      if (c.name === 'Debug monitor' && c.subs.size) monitors++;
    }
    return { editors, monitors };
  }

  catalogViewersChanged() {
    let n = 0;
    for (const c of this.clients) if (c.catalog) n++;
    this.catalog?.setViewers(n);
  }

  // Send the latest frame of a display to a client, respecting its fps cap and socket backlog.
  trySend(c, id) {
    if (c.paused) return;
    const s = c.subs.get(id);
    const d = this.hub.get(id);
    if (!s || !d?.frame || d.seq === s.lastSeq || s.timer) return;
    // 0.8 tolerance: frames from the sim arrive unevenly; only hold back frames that are clearly
    // early, otherwise a source running below the cap gets extra delay for nothing.
    const wait = s.lastSentAt + (0.8 * 1000) / s.maxFps - Date.now();
    if (wait > 0) {
      s.timer = setTimeout(() => {
        s.timer = null;
        this.trySend(c, id);
      }, wait);
      return;
    }
    if (c.ws.readyState !== 1) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED) {
      c.skipped++;
      s.timer = setTimeout(() => {
        s.timer = null;
        this.trySend(c, id);
      }, 10);
      return;
    }
    c.ws.send(d.frame, { binary: true });
    s.lastSentAt = Date.now();
    s.lastSeq = d.seq;
    c.sent++;
    const delay = performance.now() - d.arrivedPerf; // time the frame waited in the host
    c.delaySum += delay;
    if (delay > c.delayMax) c.delayMax = delay;
  }

  // Gauge data: is any client subscribed? Drives the SimConnect data request.
  dataWantedChanged() {
    const wanted = [...this.clients].some((c) => c.data && !c.paused);
    if (wanted === this.dataWanted) return;
    this.dataWanted = wanted;
    this.onDataWanted(wanted);
  }

  /// New gauge values (array in SIMVARS order): send to each subscribed client at its rate.
  pushData(values) {
    let text = null;
    const now = Date.now();
    for (const c of this.clients) {
      if (!c.data || c.paused || c.ws.readyState !== 1) continue;
      if (now - c.data.lastAt < (0.8 * 1000) / c.data.maxHz) continue;
      if (c.ws.bufferedAmount > 256 * 1024) continue; // backed up: skip, the next sample replaces it
      text ??= JSON.stringify({ type: 'data', t: now, v: values.map(round3) });
      c.ws.send(text);
      c.data.lastAt = now;
    }
  }

  broadcastLayouts(layouts) {
    this.broadcast({ type: 'layouts', layouts });
  }

  broadcastScreens(screens) {
    this.broadcast({ type: 'screens', screens, ...(this.screens?.extra() ?? {}) });
  }

  // Which displays anyone is watching, with the highest fps asked for. Drives capture on demand.
  wanted() {
    const m = new Map();
    for (const c of this.clients) if (!c.paused) for (const [id, s] of c.subs) m.set(id, Math.max(m.get(id) ?? 0, s.maxFps));
    return m;
  }

  wantedChanged() {
    this.onWanted(this.wanted());
  }

  send(c, obj) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
  }

  broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(text);
  }

  broadcastStatus() {
    this.broadcast({ type: 'status', ...this.getStatus() });
  }

  fullStatus() {
    return {
      host: os.hostname(),
      version: this.version,
      protocol: PROTOCOL_VERSION,
      port: this.port,
      ...this.getStatus(),
      ...this.getDetail(),
      displays: this.hub.list(),
      clients: [...this.clients].map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        device: c.device ?? null,
        window: c.window ?? null,
        paused: c.paused,
        address: c.addr,
        subscriptions: [...c.subs.entries()].map(([id, s]) => ({ display: id, maxFps: s.maxFps })),
        gaugeData: c.data ? { maxHz: c.data.maxHz } : null,
        framesSent: c.sent,
        framesSkipped: c.skipped,
        hostDelayMs: { avg: c.sent ? round1(c.delaySum / c.sent) : 0, max: round1(c.delayMax) },
      })),
    };
  }

  close() {
    clearInterval(this.appsTimer);
    clearTimeout(this.appsSoon);
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
    this.http?.close();
  }
}

function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
