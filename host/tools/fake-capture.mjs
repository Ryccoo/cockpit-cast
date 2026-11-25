// Fake capture source: talks to the host's pipe exactly like capture.dll does (capture protocol 2) and
// sends moving test cards. Use it to test the host and clients without the sim.
//
//   node tools/fake-capture.mjs [--static]
//
// Like capture.dll it only sends displays the host's CONFIG enables, at the fps and JPEG quality the
// host asks for, cropped as configured. --static keeps the picture still, so it sends UNCHANGED
// keep-alives instead of frames (as capture.dll does for a display that is not changing).
// It stops sending when heartbeats stop, and exits on SHUTDOWN.

import net from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import { PIPE_PATH, MSG, CAPTURE_PROTOCOL_VERSION, PipeMessageReader, encodePipeMessage, encodePipeJson, encodePipeFrame, encodePipeUnchanged } from '../src/protocol.mjs';

const STATIC = process.argv.includes('--static');
const TEX_W = 1024;
const TEX_H = 768;
let W = TEX_W;
let H = TEX_H;
let quality = 80;

let sock = null;
let busy = false;
let turn = 0;
let config = null;
let lastBeat = Date.now();
let quiet = false;
const displays = new Map(); // id -> { id, canvas, seq, fps, nextAt, sent, unchanged, drawnOnce }

function log(line) {
  console.log(line);
  if (sock && !sock.connecting) sock.write(encodePipeMessage(MSG.LOG, Buffer.from(line)));
}

function connect() {
  sock = net.connect(PIPE_PATH);
  const reader = new PipeMessageReader(onMessage, (e) => {
    console.log(`protocol error: ${e.message}`);
    sock.destroy();
  });
  sock.on('connect', () => {
    console.log(`connected to ${PIPE_PATH}`);
    lastBeat = Date.now();
    quiet = false;
    sock.write(encodePipeJson(MSG.HELLO, { source: 'fake-capture', version: '0.2.0', pid: process.pid, protocol: CAPTURE_PROTOCOL_VERSION }));
  });
  sock.on('data', (c) => reader.push(c));
  sock.on('drain', () => (busy = false));
  sock.on('error', () => {});
  sock.on('close', () => {
    if (sock) console.log('host not reachable; retrying in 2 s');
    sock = null;
    config = null;
    setTimeout(connect, 2000);
  });
}

function onMessage(type, payload) {
  if (type === MSG.HEARTBEAT) {
    lastBeat = Date.now();
    if (quiet) {
      quiet = false;
      log('heartbeat back: capturing again');
    }
  } else if (type === MSG.CONFIG) {
    config = JSON.parse(payload.toString('utf8'));
    quality = config.jpegQuality ?? 80;
    for (const c of config.displays) {
      let d = displays.get(c.id);
      if (!d) displays.set(c.id, (d = { id: c.id, canvas: null, seq: 0, fps: 0, nextAt: 0, sent: 0, unchanged: 0, drawnOnce: false }));
      const w = c.crop?.w || TEX_W;
      const h = c.crop?.h || TEX_H;
      if (!d.canvas || d.canvas.width !== w || d.canvas.height !== h) {
        d.canvas = createCanvas(w, h);
        d.drawnOnce = false;
      }
      d.fps = c.enabled ? c.maxFps : 0;
    }
    log(`config: ${config.displays.map((c) => `${c.id}=${c.enabled ? `${c.maxFps}fps` : 'off'}${c.crop ? ` crop ${c.crop.w}x${c.crop.h}` : ''}`).join(' ')} Q${quality}`);
  } else if (type === MSG.SHUTDOWN) {
    log('shutdown requested: exiting');
    setTimeout(() => process.exit(0), 100);
  }
}

function draw(d, t) {
  const ctx = d.canvas.getContext('2d');
  const roll = Math.sin(t / 2100) * 0.5; // radians
  const pitch = Math.sin(t / 3300) * 90; // px

  // horizon
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(roll);
  ctx.translate(0, pitch);
  ctx.fillStyle = '#1f6fd1';
  ctx.fillRect(-W * 2, -H * 2, W * 4, H * 2);
  ctx.fillStyle = '#8a5a2b';
  ctx.fillRect(-W * 2, 0, W * 4, H * 2);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-W * 2, 0);
  ctx.lineTo(W * 2, 0);
  ctx.stroke();
  ctx.lineWidth = 2;
  for (let p = -60; p <= 60; p += 20) {
    if (!p) continue;
    ctx.beginPath();
    ctx.moveTo(-60, p * 3);
    ctx.lineTo(60, p * 3);
    ctx.stroke();
  }
  ctx.restore();

  // grid every 128 px, to check scaling and cropping
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  for (let x = 128; x < W; x += 128) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
  }
  for (let y = 128; y < H; y += 128) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    ctx.stroke();
  }

  // circle: must look round on every client, or the aspect ratio is wrong
  ctx.strokeStyle = '#ffd400';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 200, 0, Math.PI * 2);
  ctx.stroke();

  // fixed aircraft symbol
  ctx.fillStyle = '#ffd400';
  ctx.fillRect(W / 2 - 120, H / 2 - 4, 80, 8);
  ctx.fillRect(W / 2 + 40, H / 2 - 4, 80, 8);
  ctx.fillRect(W / 2 - 6, H / 2 - 6, 12, 12);

  // border + corner labels
  ctx.strokeStyle = '#ff2fd0';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, W - 4, H - 4);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('TL', 12, 10);
  ctx.fillText('TR', W - 44, 10);
  ctx.textBaseline = 'bottom';
  ctx.fillText('BL', 12, H - 8);
  ctx.fillText('BR', W - 46, H - 8);

  // labels
  ctx.textBaseline = 'top';
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText(`${d.id.toUpperCase()} TEST`, 60, 50);
  ctx.font = '28px monospace';
  ctx.fillText(`frame ${d.seq}`, 60, 130);
  const now = new Date();
  ctx.fillText(`${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`, 60, 168);
  ctx.fillText(`${W}x${H}  ${d.fps} fps  Q${quality}`, 60, 206);
}

function tick() {
  if (!sock || sock.connecting || !config) return;
  if (!quiet && Date.now() - lastBeat > (config.heartbeatTimeoutMs ?? 10000)) {
    quiet = true;
    log('no heartbeat: stopped capturing (pass-through)');
  }
  if (quiet) return;
  if (busy) return; // never queue frames, like capture.dll
  const now = Date.now();
  // Take turns: start each tick with the next display, so one display can't starve the others.
  const list = [...displays.values()];
  turn = (turn + 1) % Math.max(1, list.length);
  for (const d of [...list.slice(turn), ...list.slice(0, turn)]) {
    if (!d.fps || now < d.nextAt) continue;
    d.nextAt = Math.max(d.nextAt + 1000 / d.fps, now);
    if (STATIC && d.drawnOnce) {
      sock.write(encodePipeUnchanged(d.id, d.seq));
      d.unchanged++;
      continue;
    }
    W = d.canvas.width;
    H = d.canvas.height;
    draw(d, now);
    d.drawnOnce = true;
    const jpeg = d.canvas.encodeSync('jpeg', quality);
    d.seq++;
    d.sent++;
    if (!sock.write(encodePipeFrame(d.id, W, H, d.seq, jpeg))) busy = true;
  }
}

function stats() {
  if (!sock || sock.connecting) return;
  const per = Object.fromEntries([...displays.values()].map((d) => [d.id, { fps: d.fps, sent: d.sent, unchanged: d.unchanged }]));
  sock.write(encodePipeJson(MSG.STATS, { source: 'fake-capture', quiet, displays: per }));
}

connect();
setInterval(tick, 5);
setInterval(stats, 2000);
