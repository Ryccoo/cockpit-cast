// Command-line test client: connects like a client app, subscribes, and reports what arrives.
//
//   node tools/test-client.mjs [--host localhost] [--port 8800] [--seconds 5] [--fps 30] [--displays pfd,mfd]

import WebSocket from 'ws';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const host = args.host || 'localhost';
const port = Number(args.port) || 8800;
const seconds = Number(args.seconds) || 5;
const fps = Number(args.fps) || 30;
const wanted = args.displays ? args.displays.split(',') : null;

const stats = new Map();
const ws = new WebSocket(`ws://${host}:${port}/ws`);

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', client: 'test-client', protocol: 1 })));
ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const m = JSON.parse(data.toString());
    console.log('<', JSON.stringify(m));
    if (m.type === 'displays') {
      for (const d of m.displays) {
        if (stats.has(d.id) || (wanted && !wanted.includes(d.id))) continue;
        stats.set(d.id, { frames: 0, bytes: 0, ages: [], firstSeq: null, lastSeq: null, size: null });
        ws.send(JSON.stringify({ type: 'subscribe', display: d.id, maxFps: fps }));
      }
    }
    return;
  }
  const b = data;
  if (b.toString('ascii', 0, 4) !== 'CLF1') return console.log('bad magic');
  const seq = b.readUInt32LE(4);
  const hostTime = b.readDoubleLE(8);
  const w = b.readUInt16LE(16);
  const h = b.readUInt16LE(18);
  const idLen = b.readUInt8(20);
  const id = b.toString('ascii', 21, 21 + idLen);
  const jpeg = b.subarray(21 + idLen);
  const s = stats.get(id);
  if (!s) return;
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) console.log(`${id}: payload is not a JPEG`);
  s.frames++;
  s.bytes += b.length;
  s.ages.push(Date.now() - hostTime);
  s.firstSeq ??= seq;
  s.lastSeq = seq;
  s.size = `${w}x${h}`;
});
ws.on('error', (e) => {
  console.error(`cannot connect to ws://${host}:${port}/ws: ${e.message}`);
  process.exit(1);
});

setTimeout(() => {
  for (const [id, s] of stats) {
    const ages = s.ages.sort((a, b) => a - b);
    const p = (q) => (ages.length ? ages[Math.floor(q * (ages.length - 1))].toFixed(1) : '-');
    console.log(
      `${id}: ${s.size} ${(s.frames / seconds).toFixed(1)} fps, ${((s.bytes * 8) / seconds / 1e6).toFixed(1)} Mbit/s, ` +
        `seq ${s.firstSeq}..${s.lastSeq}, age after host p50 ${p(0.5)} ms p95 ${p(0.95)} ms`,
    );
  }
  ws.close();
  process.exit(0);
}, seconds * 1000);
