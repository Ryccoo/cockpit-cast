// Builds the CONFIG message for capture.dll from three inputs:
//   - the display registry (built-in and learned displays): ids and marker colours. Only displays in the
//     loaded cockpit or watched by a client are sent, at most MAX (capture.dll's limit).
//   - layouts reported by the Community hook: where each display sits in its texture (read point, crop)
//   - client subscriptions: which displays anyone is watching, and the fps they want
//   - local screens (localScreens.mjs): displays shown on this PC, from shared GPU textures instead of JPEGs
// Emits 'change' with the new config whenever the result changes.

import { EventEmitter } from 'node:events';
import { CAPTURE_PROTOCOL_VERSION } from './protocol.mjs';

const MAX = 16;

export class CaptureConfig extends EventEmitter {
  constructor(cfg, { registry, present }) {
    super();
    this.cfg = cfg;
    this.registry = registry;
    this.present = present; // () => Set of display ids held by the loaded cockpit
    this.layouts = new Map(); // id -> { read:{x,y}, crop:{w,h}, texture:{w,h} }
    this.wanted = new Map(); // id -> maxFps
    this.local = new Map(); // id -> fps, shown by the local screen viewer
    this.last = '';
    this.current = this.build();
    this.last = JSON.stringify(this.current);
  }

  setLayouts(layouts) {
    this.layouts = layouts;
    this.update();
  }

  setWanted(wanted) {
    this.wanted = wanted;
    this.update();
  }

  setLocal(local) {
    this.local = local;
    this.update();
  }

  build() {
    const { cfg } = this;
    return {
      version: CAPTURE_PROTOCOL_VERSION,
      jpegQuality: cfg.jpegQuality,
      heartbeatTimeoutMs: cfg.heartbeatTimeoutMs,
      displays: this.pick().map((d) => {
        const l = this.layouts.get(d.id);
        const fps = this.wanted.get(d.id);
        return {
          id: d.id,
          marker: d.marker,
          // Where the marker pixels are, in texture pixels. (0,0) unless the instrument overflows its view.
          read: l?.read ?? { x: 0, y: 0 },
          // Size of the display inside the texture, from the read point. null = use the whole texture.
          crop: l?.crop ?? null,
          // Expected texture size, if the hook reported it: lets the DLL prefer the right candidate.
          texture: l?.texture ?? null,
          enabled: fps !== undefined,
          // May be below 1: editor previews ask for one picture every 5 s (0.2).
          maxFps: fps === undefined ? 0 : Math.max(0.1, Math.round(Math.min(fps, cfg.maxCaptureFps) * 10) / 10),
          local: this.local.has(d.id),
          localFps: this.local.get(d.id) ?? 0,
        };
      }),
    };
  }

  /// Watched displays first, then the rest of the loaded cockpit.
  pick() {
    const present = this.present();
    const all = this.registry.all();
    const watched = all.filter((d) => this.wanted.has(d.id) || this.local.has(d.id));
    const others = all.filter((d) => !this.wanted.has(d.id) && !this.local.has(d.id) && present.has(d.id));
    return [...watched, ...others].slice(0, MAX);
  }

  update() {
    const next = this.build();
    const json = JSON.stringify(next);
    if (json === this.last) return;
    this.last = json;
    this.current = next;
    this.emit('change', next);
  }
}
