// Named-pipe server for capture.dll (or the fake capture tool). Two-way, see docs/protocol.md section 1:
//   source -> host: HELLO, FRAME, LOG, STATS, UNCHANGED
//   host -> source: CONFIG (what to capture), HEARTBEAT (every second), SHUTDOWN

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PIPE_PATH, MSG, PipeMessageReader, decodePipeFrame, decodePipeUnchanged, encodePipeJson, encodePipeMessage } from './protocol.mjs';
import { makeLog } from './log.mjs';

const log = makeLog('capture');

export class CaptureLink extends EventEmitter {
  constructor({ hub, captureConfig, heartbeatMs = 1000 }) {
    super();
    this.hub = hub;
    this.captureConfig = captureConfig;
    this.heartbeatMs = heartbeatMs;
    this.sources = new Set(); // { sock, hello, stats, connectedAt, frames, unchanged }
    captureConfig.on('change', (cfg) => {
      const summary = cfg.displays
        .map((d) => `${d.id}:${d.enabled ? `${d.maxFps}fps` : d.local ? 'local only' : 'off'}${d.enabled && d.local ? '+local' : ''}${d.crop ? ` crop ${d.crop.w}x${d.crop.h}@${d.read.x},${d.read.y}` : ''}`)
        .join(' ');
      if (this.sources.size) log.info(`config -> source: ${summary}`);
      for (const s of this.sources) this.write(s, encodePipeJson(MSG.CONFIG, cfg));
    });
  }

  start() {
    this.server = net.createServer((sock) => this.onConnection(sock));
    this.server.on('error', (err) => {
      log.error(`pipe server error: ${err.message}`);
      if (err.code === 'EADDRINUSE') log.error('Another host is already running on this PC.');
    });
    this.server.listen(PIPE_PATH, () => log.info(`listening on ${PIPE_PATH}`));
    const beat = encodePipeMessage(MSG.HEARTBEAT);
    this.beatTimer = setInterval(() => {
      for (const s of this.sources) this.write(s, beat);
    }, this.heartbeatMs);
  }

  onConnection(sock) {
    const s = { sock, hello: null, stats: null, connectedAt: Date.now(), frames: 0, unchanged: 0 };
    this.sources.add(s);
    log.info('capture source connected');
    const reader = new PipeMessageReader(
      (type, payload) => this.onMessage(s, type, payload),
      (err) => {
        log.warn(`protocol error, dropping connection: ${err.message}`);
        sock.destroy();
      },
    );
    sock.on('data', (chunk) => reader.push(chunk));
    sock.on('error', () => {});
    sock.on('close', () => {
      this.sources.delete(s);
      log.info(`capture source disconnected (${s.hello?.source ?? 'unknown'} pid=${s.hello?.pid ?? '?'}, ${s.frames} frames)`);
      this.emit('status');
      this.emit('disconnected', s.hello);
    });
    // Config goes out straight away; a source must not capture anything before it has one.
    this.write(s, encodePipeJson(MSG.CONFIG, this.captureConfig.current));
    this.emit('status');
  }

  onMessage(s, type, payload) {
    switch (type) {
      case MSG.FRAME:
        try {
          this.hub.put(decodePipeFrame(payload));
          s.frames++;
        } catch (e) {
          log.warn(`bad frame: ${e.message}`);
        }
        break;
      case MSG.UNCHANGED:
        try {
          this.hub.touch(decodePipeUnchanged(payload).id);
          s.unchanged++;
        } catch {}
        break;
      case MSG.HELLO:
        s.hello = parseJson(payload) ?? { source: 'unknown' };
        log.info(`source: ${s.hello.source} ${s.hello.version ?? ''} pid=${s.hello.pid ?? '?'} protocol=${s.hello.protocol ?? '?'}`);
        this.emit('status');
        this.emit('hello', s.hello);
        break;
      case MSG.LOG:
        log.info(`[${s.hello?.source ?? 'source'}] ${payload.toString('utf8').trimEnd()}`);
        break;
      case MSG.STATS:
        s.stats = parseJson(payload);
        break;
      default:
        log.warn(`unknown message type ${type} from source`);
    }
  }

  write(s, buf) {
    // Control messages are tiny; if the pipe is that backed up the source is stuck anyway.
    if (!s.sock.destroyed && s.sock.writableLength < 1024 * 1024) s.sock.write(buf);
  }

  // Ask every connected source to stop capturing and disconnect.
  shutdownSources() {
    for (const s of this.sources) this.write(s, encodePipeMessage(MSG.SHUTDOWN));
  }

  // Is a source from this process connected (and said hello)?
  hasPid(pid) {
    for (const s of this.sources) if (s.hello?.pid === pid) return true;
    return false;
  }

  status() {
    const s = [...this.sources].at(-1);
    return { connected: this.sources.size > 0, source: s?.hello?.source ?? null, pid: s?.hello?.pid ?? null };
  }

  detail() {
    return [...this.sources].map((s) => ({
      ...s.hello,
      connectedForSec: Math.round((Date.now() - s.connectedAt) / 1000),
      frames: s.frames,
      unchanged: s.unchanged,
      stats: s.stats,
    }));
  }

  close() {
    clearInterval(this.beatTimer);
    this.server?.close();
  }
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}
