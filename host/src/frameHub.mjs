// Holds the latest frame per display and tracks which displays are live.
// Every display in the registry is listed (not live until frames arrive); sync() follows the registry as
// displays are learned, renamed or forgotten. Unknown ids that a capture source sends are added on first frame.

import { EventEmitter } from 'node:events';
import { encodeClientFrame } from './protocol.mjs';

const LIVE_TIMEOUT_MS = 2000;

export class FrameHub extends EventEmitter {
  constructor(configured = []) {
    super();
    this.displays = new Map(); // id -> state
    for (const c of configured) this.displays.set(c.id, this.blank(c.id, c.name));
    this.liveTimer = setInterval(() => this.checkLive(), 500);
  }

  /// Match the registry: add new displays, update names, drop forgotten ones that are not live.
  sync(configured) {
    const ids = new Set(configured.map((c) => c.id));
    let changed = false;
    for (const c of configured) {
      const d = this.displays.get(c.id);
      if (!d) {
        this.displays.set(c.id, this.blank(c.id, c.name));
        changed = true;
      } else if (c.name && d.name !== c.name) {
        d.name = c.name;
        changed = true;
      }
    }
    for (const [id, d] of this.displays) {
      if (!ids.has(id) && !d.live) {
        this.displays.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('displays');
  }

  blank(id, name) {
    return { id, name: name ?? id.toUpperCase(), width: 0, height: 0, live: false, fps: 0, times: [], seq: -1, frame: null, lastAt: 0, unchanged: 0 };
  }

  // Called for every frame from the capture link.
  put({ id, width, height, seq, jpeg }) {
    const now = Date.now();
    let d = this.displays.get(id);
    const isNew = !d;
    if (!d) this.displays.set(id, (d = this.blank(id)));
    const sizeChanged = d.width !== width || d.height !== height;
    d.width = width;
    d.height = height;
    d.seq = seq;
    d.lastAt = now;
    d.arrivedPerf = performance.now(); // precise in-process clock, for send-delay stats
    d.frame = encodeClientFrame(id, width, height, seq, now, jpeg);
    d.jpegBytes = jpeg.length;
    d.times.push(now);
    while (d.times.length && now - d.times[0] > 2000) d.times.shift();
    d.fps = d.times.length > 1 ? ((d.times.length - 1) * 1000) / (now - d.times[0]) : 0;
    const becameLive = !d.live;
    d.live = true;
    if (isNew || sizeChanged || becameLive) this.emit('displays');
    this.emit('frame', d);
  }

  // The capture source re-checked a display and the picture had not changed: still live, nothing to send.
  touch(id) {
    const d = this.displays.get(id);
    if (!d || !d.frame) return; // nothing to show yet: wait for a real frame
    d.lastAt = Date.now();
    d.unchanged++;
    if (!d.live) {
      d.live = true;
      this.emit('displays');
    }
  }

  checkLive() {
    const now = Date.now();
    let changed = false;
    for (const d of this.displays.values()) {
      if (d.live && now - d.lastAt > LIVE_TIMEOUT_MS) {
        d.live = false;
        d.fps = 0;
        changed = true;
      }
      // fps decays when a display stops changing (unchanged keep-alives only)
      while (d.times.length && now - d.times[0] > 2000) d.times.shift();
      if (d.live && d.times.length < 2 && d.fps) d.fps = 0;
    }
    if (changed) this.emit('displays');
  }

  get(id) {
    return this.displays.get(id);
  }

  list() {
    return [...this.displays.values()].map((d) => ({
      id: d.id,
      name: d.name,
      width: d.width,
      height: d.height,
      live: d.live,
      fps: Math.round(d.fps * 10) / 10,
    }));
  }

  close() {
    clearInterval(this.liveTimer);
  }
}
