// A real host, started isolated (COCKPITCAST_ISOLATED: no sim, capture, injector, mDNS, tray, updates or
// local screens) on a free port with a scratch data folder, so it can run next to a running MSFS and
// CockpitCast. Checks the window's pages, the APIs, the client protocol and the display apps list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HOST = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
let proc, port, root, base, output = '';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-smoke-'));
  const env = { ...process.env, COCKPITCAST_ISOLATED: '1', COCKPITCAST_PORT: String(port), LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming'), ProgramData: path.join(root, 'programdata') };
  delete env.COCKPITCAST_TRAY_PARENT;
  proc = spawn(process.execPath, [HOST], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) return;
    } catch {}
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`host did not start:\n${output}`);
});

after(async () => {
  proc?.kill();
  await new Promise((r) => (proc?.exitCode !== null ? r() : proc.once('exit', r)));
  fs.rmSync(root, { recursive: true, force: true });
});

// A WebSocket client that collects messages; next(type) waits for one of that type.
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (data, binary) => {
    if (binary) return;
    const m = JSON.parse(String(data));
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const next = (pred, ms = 5000) => {
    const p = typeof pred === 'string' ? (m) => m.type === pred : pred;
    const hit = msgs.find(p);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred: p, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('no such message within ' + ms + ' ms')), ms);
    });
  };
  const open = new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  return { ws, msgs, next, open, send: (o) => ws.send(JSON.stringify(o)), closed: new Promise((r) => ws.once('close', r)) };
}

test('isolated: the log says so, and nothing touched the sim', () => {
  assert.match(output, /isolated \(tests\)/);
  assert.doesNotMatch(output, /SimConnect: connected|injecting/i);
});

test('the CockpitCast window and its old addresses', async () => {
  const screen = await fetch(`${base}/screen?screen=1`);
  assert.equal(screen.status, 200);
  assert.match(await screen.text(), /src="\/gauges.js"/);
  for (const p of ['/', '/editor', '/monitor.html']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /<title>CockpitCast<\/title>/, p);
    assert.match(html, /src="\/shell.js"/, p);
  }
  const js = await fetch(`${base}/shell.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/gauges.js`)).status, 200);
  assert.equal((await fetch(`${base}/nothing-here`)).status, 404);
});

test('APIs answer on this PC', async () => {
  const st = await (await fetch(`${base}/api/status`)).json();
  assert.ok(st && typeof st === 'object');
  const tr = await (await fetch(`${base}/api/troubleshoot`)).json();
  assert.ok(tr.setupHook.endsWith('setup-hook.mjs'));
  const st2 = await (await fetch(`${base}/api/startup`)).json();
  assert.ok('on' in st2);
  const hs = await (await fetch(`${base}/api/hook-setup`)).json();
  assert.equal(hs.community, null); // a scratch PC: no Community folder anywhere
});

test('a client gets welcome, status, displays, layouts and screens', async (t) => {
  const c = client();
  t.after(() => c.ws.close());
  await c.open;
  c.send({ type: 'hello', client: 'smoke test', protocol: 1 });
  const welcome = await c.next('welcome');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(welcome.version, pkg.version);
  for (const type of ['status', 'displays', 'layouts', 'screens']) await c.next(type);
  const screens = await c.next('screens');
  assert.ok(Array.isArray(screens.screens) && screens.screens.length >= 1);
});

test('display apps: one row per app window, the settings page as a mark', async (t) => {
  const app = client(), settings = client(), page = client();
  t.after(() => [app, settings, page].forEach((c) => c.ws.close()));
  await Promise.all([app.open, settings.open, page.open]);
  const local = client();
  t.after(() => local.ws.close());
  await local.open;
  local.send({ type: 'hello', client: 'Local screen 1', role: 'local', protocol: 1 }); // a local screen's page: not an app
  app.send({ type: 'hello', client: 'phone', device: 'phone-1', window: 'Window 1', shows: 'screen 2: MFD', protocol: 1, version: '9.9.9' });
  settings.send({ type: 'hello', client: 'phone', device: 'phone-1', window: 'Settings', role: 'settings', protocol: 1 });
  page.send({ type: 'hello', client: 'Layout editor', protocol: 1 });
  page.send({ type: 'subscribeApps' });
  const m = await page.next((x) => x.type === 'apps' && x.apps === 1 && x.list.length === 1 && x.list[0].settingsOpen);
  assert.equal(m.list[0].name, 'phone-1');
  assert.equal(m.list[0].window, 'Window 1');
});

test('a connection that never says hello is closed after 10 s and never listed', async (t) => {
  const silent = client(), page = client();
  t.after(() => [silent, page].forEach((c) => c.ws.close()));
  await Promise.all([silent.open, page.open]);
  page.send({ type: 'hello', client: 'Layout editor', protocol: 1 });
  page.send({ type: 'subscribeApps' });
  const m = await page.next('apps');
  assert.ok(m.list.every((a) => a.name), 'no unnamed rows');
  const t0 = Date.now();
  await Promise.race([silent.closed, new Promise((_, j) => setTimeout(() => j(new Error('not closed')), 13000))]);
  assert.ok(Date.now() - t0 > 8000);
});

test('update actions are refused for pages on other computers only (this one is loopback)', async (t) => {
  const c = client();
  t.after(() => c.ws.close());
  await c.open;
  c.send({ type: 'hello', client: 'Layout editor', protocol: 1 });
  c.send({ type: 'checkUpdate' }); // updates are off when isolated: must just do nothing
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!c.msgs.some((m) => m.type === 'error'), JSON.stringify(c.msgs.filter((m) => m.type === 'error')));
});
