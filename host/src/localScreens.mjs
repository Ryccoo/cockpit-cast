// Local screens on the sim PC: screens set to "On this PC" are shown by cockpitcast-screens.exe (screens/),
// one borderless window per screen on any part of any monitor (full, a half), so no display app is needed
// on the sim PC. Glass displays reach it as shared GPU textures straight from capture.dll (zero copy; see
// capture/src/localshare.h); this module tells capture.dll which displays are wanted locally.
// Steam-gauge layouts are not drawn by the viewer yet: such a screen stays black on this PC.
//
// The viewer is started with the host (Windows, when built or installed) and reports the monitors; the
// editor's Screens tab offers them. It is restarted if it exits, and ends when the host ends.
//
// On/off for all local screens at once (tray menu "Show local screens", the editor's Screens tab), so the
// screens' monitors and areas stay set: off closes the windows and stops the local copies in capture.dll.
// Remembered in <dataDir>/local-screens.json.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { makeLog } from './log.mjs';

const log = makeLog('local');

export class LocalScreens extends EventEmitter {
  constructor({ cfg, screens, captureConfig }) {
    super();
    this.cfg = cfg;
    this.screens = screens;
    this.captureConfig = captureConfig;
    this.monitors = [];
    this.stats = null;
    this.proc = null;
    this.last = '';
    this.closing = false;
    this.file = path.join(cfg.dataDir, 'local-screens.json');
    this.enabled = true;
    try {
      this.enabled = JSON.parse(fs.readFileSync(this.file, 'utf8')).enabled !== false;
    } catch {}
    this.lastState = '';
    screens.on('change', () => this.update());
  }

  /// 'none' (no screen set to "On this PC"), 'on' or 'off'.
  state() {
    const configured = this.screens.list().some((s) => s.local && Number.isInteger(s.local.monitor));
    return !configured ? 'none' : this.enabled ? 'on' : 'off';
  }

  setEnabled(on) {
    this.enabled = !!on;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ enabled: this.enabled }, null, 2) + '\n');
    } catch (e) {
      log.warn(`cannot save ${this.file}: ${e.message}`);
    }
    log.info(`local screens ${this.enabled ? 'on' : 'off'}`);
    this.update();
  }

  start() {
    if (process.platform !== 'win32') return;
    if (!fs.existsSync(this.cfg.screensPath)) return void log.info(`local screens off: ${this.cfg.screensPath} not found`);
    this.spawn();
  }

  spawn() {
    const p = spawn(this.cfg.screensPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = p;
    this.last = '';
    p.on('error', (e) => log.warn(`local screens: ${e.message}`));
    p.stdin.on('error', () => {});
    readline.createInterface({ input: p.stdout }).on('line', (line) => this.onLine(line));
    p.on('exit', (code) => {
      if (this.proc === p) this.proc = null;
      if (this.closing) return;
      log.warn(`local screen viewer exited (${code}); starting it again in 5 s`);
      setTimeout(() => !this.closing && !this.proc && this.spawn(), 5000);
    });
    this.update();
  }

  onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.type === 'monitors') {
      this.monitors = Array.isArray(m.monitors) ? m.monitors : [];
      log.info(`monitors: ${this.monitors.map((x) => `${x.index + 1}=${x.w}x${x.h}${x.primary ? ' (main)' : ''}`).join(', ')}`);
      this.emit('monitors', this.monitors);
      this.update();
    } else if (m.type === 'stats') this.stats = m;
    else if (m.type === 'log') log.info(`viewer: ${m.message}`);
  }

  /// The viewer's windows: screens set to show on this PC, with what each one shows now.
  windows() {
    const out = [];
    for (const s of this.screens.list()) {
      const l = s.local;
      if (!l || !Number.isInteger(l.monitor)) continue;
      out.push({
        id: s.id,
        monitor: l.monitor,
        area: l.area ?? 'full',
        fit: l.fit ?? 'contain',
        // Glass displays only for now; a steam layout leaves the window black.
        display: s.show?.kind === 'display' ? s.show.id : null,
      });
    }
    return out;
  }

  update() {
    const windows = this.enabled ? this.windows() : [];
    const state = this.state();
    if (state !== this.lastState) {
      this.lastState = state;
      this.emit('state', state);
    }
    const local = new Map();
    for (const w of windows) if (w.display) local.set(w.display, this.cfg.localFps);
    this.captureConfig.setLocal(local);
    if (!this.proc) return;
    const json = JSON.stringify({ type: 'windows', windows });
    if (json === this.last) return;
    this.last = json;
    log.info(windows.length ? `showing ${windows.map((w) => `screen ${w.id} on monitor ${w.monitor + 1} (${w.area}): ${w.display ?? '-'}`).join('; ')}` : 'no local screens');
    this.proc.stdin.write(json + '\n');
  }

  status() {
    return { running: !!this.proc, enabled: this.enabled, state: this.state(), monitors: this.monitors, stats: this.stats };
  }

  close() {
    this.closing = true;
    try {
      this.proc?.stdin.end();
    } catch {}
  }
}
