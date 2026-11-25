// Decides when to load capture.dll into the sim, and does it through cockpit-link-injector.exe.
//
// Rules:
//   - only once a flight has been live (running, unpaused) for injectDelaySec; never in menus or loading
//     (set requireFlight=false to skip this, e.g. for tests with fake-sim.exe);
//   - at most one automatic attempt per sim process; a loaded DLL is never loaded again (it reconnects
//     to the host by itself), so a host restart never double-injects;
//   - each injection loads a freshly staged copy of the DLL, so rebuilding the DLL never fights a
//     loaded file.

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makeLog } from './log.mjs';

const log = makeLog('inject');
const POLL_MS = 3000;
const HELLO_TIMEOUT_MS = 20000;

export class Injector extends EventEmitter {
  constructor({ cfg, sim, capture }) {
    super();
    this.cfg = cfg;
    this.sim = sim;
    this.capture = capture;
    this.requireFlight = cfg.requireFlight !== false;
    this.state = 'starting';
    this.detailText = '';
    this.proc = null; // { pid, ours } from the last status poll
    this.attempts = new Map(); // pid -> { at, ok, error }
    this.busy = false;
    this.instancesDir = path.join(cfg.dataDir, 'instances');
    capture.on('hello', (hello) => this.onHello(hello));
    capture.on('disconnected', () => this.tick());
  }

  start() {
    this.cleanupInstances();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.tick();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.step();
    } catch (e) {
      this.set('error', e.message);
    } finally {
      this.busy = false;
    }
  }

  async step() {
    if (!fs.existsSync(this.cfg.injectorPath)) return this.set('no-injector', `not built: ${this.cfg.injectorPath}`);
    const st = await this.run(['status', '--exe', this.cfg.simExe]);
    const proc = st.processes?.[0] ?? null;
    if (proc && proc.pid !== this.proc?.pid) log.info(`${this.cfg.simExe} found, pid ${proc.pid}`);
    if (!proc && this.proc) log.info(`${this.cfg.simExe} (pid ${this.proc.pid}) has exited`);
    this.proc = proc;
    if (!proc) return this.set('waiting-sim', `${this.cfg.simExe} not running`);
    if (proc.error) {
      // Normal for a moment while the sim starts up or shuts down; only report it if it persists.
      this.inspectErrors = (this.inspectErrors ?? 0) + 1;
      if (this.inspectErrors < 3) return;
      return this.set('error', `cannot inspect pid ${proc.pid}: ${proc.error}`);
    }
    this.inspectErrors = 0;

    const connected = this.capture.hasPid(proc.pid);
    if (proc.ours) return this.set(connected ? 'connected' : 'loaded', connected ? `capture.dll running in pid ${proc.pid}` : `capture.dll loaded in pid ${proc.pid}, not connected to the host`);

    const tried = this.attempts.get(proc.pid);
    if (tried && !tried.ok) return this.set('failed', `${tried.error} (POST /api/inject to retry)`);
    if (!this.cfg.autoInject) return this.set('manual', 'automatic injection is off (POST /api/inject to inject)');
    if (!fs.existsSync(this.cfg.dllPath)) return this.set('no-dll', `capture.dll not built: ${this.cfg.dllPath}`);

    if (this.requireFlight) {
      const s = this.sim.status();
      if (!s.connected) return this.set('waiting-simconnect', 'sim process found; waiting for SimConnect');
      if (!s.inFlight) return this.set('waiting-flight', 'waiting for a flight (not in menus or loading)');
      if (s.paused) return this.set('waiting-flight', 'flight paused');
      if (s.liveForSec < this.cfg.injectDelaySec) return this.set('stabilizing', `flight live for ${s.liveForSec}s of ${this.cfg.injectDelaySec}s`);
    }
    await this.inject(proc.pid);
  }

  // Inject now (from the API). Ignores the flight-state wait and earlier failures.
  async injectNow() {
    if (this.busy) throw new Error('busy, try again in a moment');
    this.busy = true;
    try {
      const st = await this.run(['status', '--exe', this.cfg.simExe]);
      const proc = st.processes?.[0];
      if (!proc) throw new Error(`${this.cfg.simExe} not running`);
      if (!fs.existsSync(this.cfg.dllPath)) throw new Error(`capture.dll not built: ${this.cfg.dllPath}`);
      return await this.inject(proc.pid);
    } finally {
      this.busy = false;
    }
  }

  async inject(pid) {
    const staged = this.stage(pid);
    this.set('injecting', `loading ${path.basename(staged)} into pid ${pid}`);
    log.info(`injecting ${staged} into pid ${pid}`);
    const r = await this.run(['inject', '--pid', String(pid), '--dll', staged]);
    if (!r.ok) {
      this.attempts.set(pid, { at: Date.now(), ok: false, error: r.error });
      log.error(`injection failed: ${r.error}`);
      this.set('failed', r.error);
      return r;
    }
    this.attempts.set(pid, { at: Date.now(), ok: true });
    log.info(r.already ? `already loaded in pid ${pid}` : `loaded into pid ${pid}`);
    // The DLL often says hello before the injector has even returned.
    if (this.capture.hasPid(pid)) return this.set('connected', `capture.dll running in pid ${pid}`), r;
    this.set('loaded', `waiting for capture.dll in pid ${pid} to connect`);
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      if (!this.capture.hasPid(pid)) log.warn(`capture.dll in pid ${pid} has not connected after ${HELLO_TIMEOUT_MS / 1000}s; check its log`);
    }, HELLO_TIMEOUT_MS);
    return r;
  }

  onHello(hello) {
    if (this.proc && hello?.pid === this.proc.pid) {
      clearTimeout(this.helloTimer);
      this.set('connected', `capture.dll running in pid ${hello.pid}`);
    }
  }

  // Copy the DLL to instances/<pid>-<time>/cockpit-link-capture.dll (the file name must stay the same:
  // the injector recognises our module by it).
  stage(pid) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dir = path.join(this.instancesDir, `${pid}-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'cockpit-link-capture.dll');
    fs.copyFileSync(this.cfg.dllPath, target);
    const pdb = this.cfg.dllPath.replace(/\.dll$/i, '.pdb');
    if (fs.existsSync(pdb)) fs.copyFileSync(pdb, target.replace(/\.dll$/i, '.pdb'));
    return target;
  }

  // Remove staged copies no process holds any more (a loaded DLL can't be deleted; those just stay).
  cleanupInstances() {
    if (!fs.existsSync(this.instancesDir)) return;
    for (const name of fs.readdirSync(this.instancesDir)) {
      try {
        fs.rmSync(path.join(this.instancesDir, name), { recursive: true });
      } catch {}
    }
  }

  run(args) {
    return new Promise((resolve) => {
      execFile(this.cfg.injectorPath, args, { timeout: 30000, windowsHide: true }, (err, stdout) => {
        const line = String(stdout).trim().split('\n').at(-1);
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, error: err?.message ?? `bad injector output: ${line}` });
        }
      });
    });
  }

  set(state, detail) {
    if (state === this.state && detail === this.detailText) return;
    const changedState = state !== this.state;
    this.state = state;
    this.detailText = detail;
    if (changedState) log.info(`${state}: ${detail}`);
    this.emit('status');
  }

  status() {
    return { state: this.state, detail: this.detailText, pid: this.proc?.pid ?? null };
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.helloTimer);
  }
}
