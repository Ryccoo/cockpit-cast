// Shared protocol constants and codecs. See docs/protocol.md.

export const PROTOCOL_VERSION = 1; // client link (WebSocket)
export const CAPTURE_PROTOCOL_VERSION = 2; // capture link (pipe)
export const DEFAULT_PORT = 8800;
export const PIPE_PATH = '\\\\.\\pipe\\cockpit-link-capture';
export const MDNS_TYPE = 'cockpit-link';

// Pipe message types. 1-15: capture source -> host. 16+: host -> capture source.
export const MSG = {
  HELLO: 1, // JSON
  FRAME: 2, // binary, see encodePipeFrame
  LOG: 3, // UTF-8 line
  STATS: 4, // JSON
  UNCHANGED: 5, // u8 idLen, id, u32 seq: display re-checked, picture identical, nothing to send
  CONFIG: 16, // JSON: what to capture
  HEARTBEAT: 17, // empty
  SHUTDOWN: 18, // empty: stop capturing, release everything, disconnect
};
export const MAX_PIPE_MESSAGE = 8 * 1024 * 1024;

// ---- capture link (pipe) ----

export function encodePipeMessage(type, payload = Buffer.alloc(0)) {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt32LE(1 + payload.length, 0);
  out.writeUInt8(type, 4);
  payload.copy(out, 5);
  return out;
}

export function encodePipeJson(type, obj) {
  return encodePipeMessage(type, Buffer.from(JSON.stringify(obj), 'utf8'));
}

export function encodePipeFrame(id, width, height, seq, jpeg) {
  const idBuf = Buffer.from(id, 'ascii');
  const head = Buffer.allocUnsafe(1 + idBuf.length + 8);
  let o = head.writeUInt8(idBuf.length, 0);
  o += idBuf.copy(head, o);
  o = head.writeUInt16LE(width, o);
  o = head.writeUInt16LE(height, o);
  head.writeUInt32LE(seq >>> 0, o);
  return encodePipeMessage(MSG.FRAME, Buffer.concat([head, jpeg]));
}

export function decodePipeFrame(payload) {
  const idLen = payload.readUInt8(0);
  let o = 1;
  const id = payload.toString('ascii', o, o + idLen);
  o += idLen;
  const width = payload.readUInt16LE(o);
  const height = payload.readUInt16LE(o + 2);
  const seq = payload.readUInt32LE(o + 4);
  const jpeg = payload.subarray(o + 8);
  return { id, width, height, seq, jpeg };
}

export function encodePipeUnchanged(id, seq) {
  const idBuf = Buffer.from(id, 'ascii');
  const p = Buffer.allocUnsafe(1 + idBuf.length + 4);
  p.writeUInt8(idBuf.length, 0);
  idBuf.copy(p, 1);
  p.writeUInt32LE(seq >>> 0, 1 + idBuf.length);
  return encodePipeMessage(MSG.UNCHANGED, p);
}

export function decodePipeUnchanged(payload) {
  const idLen = payload.readUInt8(0);
  return { id: payload.toString('ascii', 1, 1 + idLen), seq: payload.readUInt32LE(1 + idLen) };
}

// Splits a byte stream into pipe messages.
export class PipeMessageReader {
  constructor(onMessage, onError) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onError = onError;
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len < 1 || len > MAX_PIPE_MESSAGE) {
        this.onError(new Error(`bad message length ${len}`));
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < 4 + len) return;
      const type = this.buf.readUInt8(4);
      const payload = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.onMessage(type, payload);
    }
  }
}

// ---- client link (WebSocket binary frame) ----

export function encodeClientFrame(id, width, height, seq, hostTimeMs, jpeg) {
  const idBuf = Buffer.from(id, 'ascii');
  const head = Buffer.allocUnsafe(4 + 4 + 8 + 2 + 2 + 1 + idBuf.length);
  head.write('CLF1', 0, 'ascii');
  let o = head.writeUInt32LE(seq >>> 0, 4);
  o = head.writeDoubleLE(hostTimeMs, o);
  o = head.writeUInt16LE(width, o);
  o = head.writeUInt16LE(height, o);
  o = head.writeUInt8(idBuf.length, o);
  idBuf.copy(head, o);
  return Buffer.concat([head, jpeg]);
}
