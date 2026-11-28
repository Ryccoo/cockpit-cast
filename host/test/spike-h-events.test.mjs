// SPIKE (branch spike-h-events): the H-event relay. A real host, started isolated with COCKPITCAST_SPIKE=1,
// and a fake hook page on /hook: an event posted to the spike API reaches the page, the page's report is
// kept, bad names are refused. The smoke test checks the API is off without COCKPITCAST_SPIKE.
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spike-'));
  const env = { ...process.env, COCKPITCAST_ISOLATED: '1', COCKPITCAST_SPIKE: '1', COCKPITCAST_PORT: String(port), LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming'), ProgramData: path.join(root, 'programdata') };
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

const post = (name) => fetch(`${base}/api/spike/h-event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });

test('an H-event reaches the hook page and its report is kept', async (t) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/hook`);
  t.after(() => ws.close());
  const got = new Promise((resolve) => ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'hEvent') resolve(m); }));
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'hello', page: 'test', version: 'test' }));
  await new Promise((r) => setTimeout(r, 100));

  const res = await post('AS1000_PFD_SOFTKEYS_3');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).pages, 1);
  assert.deepEqual(await got, { type: 'hEvent', name: 'AS1000_PFD_SOFTKEYS_3' });

  ws.send(JSON.stringify({ type: 'hEventDone', name: 'AS1000_PFD_SOFTKEYS_3', page: '/pfd', called: ['AS1000_PFD'], failed: [] }));
  let results = [];
  for (let i = 0; i < 20 && !results.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
    results = (await (await fetch(`${base}/api/spike/h-events`)).json()).results;
  }
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].called, ['AS1000_PFD']);
});

test('bad event names are refused', async () => {
  for (const name of ['', 'A B', '(>K:TOGGLE_MASTER_BATTERY)', 'x'.repeat(81), 42]) {
    assert.equal((await post(name)).status, 500, String(name));
  }
});
