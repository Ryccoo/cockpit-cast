// The Community hook as the host sees it, for the editor's "Sim add-on" tab: which Community folder it
// goes into, whether it is installed there (and which version), whether the sim runs it now, and
// rebuilding + reinstalling it. Runs the same scripts as setup and the Start menu's "Repair Community
// hook" (hook/setup-hook.mjs, hook/install-hook.mjs --detect), so the folder lookup (Addons Linker,
// UserCfg.opt, ...) and the remembered folder are the same everywhere.
// Local-only HTTP API (index.mjs): GET /api/hook-setup, POST /api/hook-setup/reinstall { community },
// POST /api/hook-setup/save { community } (remember the folder, install nothing), POST /api/hook-setup/build
// and /api/hook-setup/open-built (the monitor's "install it by hand": build the package, show it in Explorer).

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeLog } from './log.mjs';

const log = makeLog('hook-setup');
const PKG = 'zzz-cockpitcast-hook';
const BASE_INSTRUMENT = path.join('html_ui', 'Pages', 'VCockpit', 'Instruments', 'Shared', 'BaseInstrument.js');

/// Is this process running elevated ("as administrator")? An elevated CockpitCast can be refused folders
/// its user can open (a Store app's Community folder), so the monitor and the editor warn about it.
/// Windows only; checked once (the High Mandatory Level group, S-1-16-12288, is in elevated tokens).
let elevated = null;
export function isElevated() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  elevated ??= new Promise((resolve) => {
    execFile('whoami', ['/groups'], { windowsHide: true, encoding: 'utf8' }, (err, out) => resolve(!err && String(out).includes('S-1-16-12288')));
  });
  return elevated;
}

// 'ok', 'denied' (there, but this process may not open it) or 'missing' (as in hook/install-hook.mjs).
function probe(p) {
  try {
    if (!fs.statSync(p).isDirectory()) return 'missing';
    fs.opendirSync(p).closeSync();
    return 'ok';
  } catch (e) {
    return e.code === 'EPERM' || e.code === 'EACCES' ? 'denied' : 'missing';
  }
}

// A pasted folder: Windows' "Copy as path" adds quotes; spaces around it are never part of it.
const clean = (dir) => String(dir ?? '').trim().replace(/^"(.*)"$/, '$1').trim();

export class HookSetup {
  constructor({ cfg, hook, version }) {
    this.dir = path.join(cfg.root, 'hook');
    this.simExe = cfg.simExe;
    this.hook = hook;
    this.version = version;
    this.busy = false;
    this.last = null; // { ok, output, at, community }
  }

  run(script, args, timeoutMs) {
    return new Promise((resolve) => {
      execFile(process.execPath, [path.join(this.dir, script), ...args], { cwd: this.dir, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
      });
    });
  }

  simRunning() {
    if (process.platform !== 'win32') return Promise.resolve(false);
    return new Promise((resolve) => {
      execFile('tasklist', ['/FI', `IMAGENAME eq ${this.simExe}`, '/NH'], { windowsHide: true, encoding: 'utf8' }, (err, out) => {
        resolve(!err && String(out).toLowerCase().includes(this.simExe.toLowerCase()));
      });
    });
  }

  async status() {
    const det = await this.run('install-hook.mjs', ['--detect'], 20_000);
    let d;
    try {
      d = JSON.parse(det.out.split(/\r?\n/).pop());
    } catch {
      d = { community: null, error: det.out || 'the hook tools are missing' };
    }
    // The installed hook's version and build time, from its BaseInstrument.js.
    let installedVersion = null, builtAt = null;
    if (d.community) {
      try {
        const text = fs.readFileSync(path.join(d.community, PKG, BASE_INSTRUMENT), 'utf8');
        installedVersion = /var VERSION = "([^"]+)"/.exec(text)?.[1] ?? null;
        builtAt = /\/\/ Built (\S+) from/.exec(text)?.[1] ?? null;
      } catch {}
    }
    const h = this.hook.status();
    return {
      ...d,
      installedVersion,
      builtAt,
      hostVersion: this.version,
      simRunning: await this.simRunning(),
      elevated: await isElevated(),
      inSim: { connected: h.connected, pages: h.pages, versions: h.versions ?? [] },
      busy: this.busy,
      last: this.last,
    };
  }

  /// Remember this Community folder (the editor's Save), even if it cannot be opened now: the user knows.
  async save(community) {
    const dir = clean(community);
    if (!dir) throw new Error('Enter the Community folder first.');
    const r = await this.run('install-hook.mjs', ['--community', dir, '--save-only'], 20_000);
    if (r.code !== 0) throw new Error(r.out || 'Could not save the folder.');
    let res = {};
    try {
      res = JSON.parse(r.out.split(/\r?\n/).pop());
    } catch {}
    log.info(`Community folder saved: ${res.saved ?? dir} (${res.access ?? '?'})`);
    return { ok: true, saved: res.saved ?? dir, access: res.access ?? null };
  }

  /// Build the hook package without installing it (to copy it by hand). Returns where it is.
  async build() {
    if (this.busy) throw new Error('a reinstall is already running');
    this.busy = true;
    try {
      const r = await this.run('build-hook.mjs', [], 120_000);
      return { ok: r.code === 0, output: r.out, folder: path.join(this.dir, 'dist', PKG) };
    } finally {
      this.busy = false;
    }
  }

  /// Explorer with the built package selected (Windows).
  openBuilt() {
    const folder = path.join(this.dir, 'dist', PKG);
    if (!fs.existsSync(folder)) throw new Error('Not built yet: press Build the hook first.');
    if (process.platform === 'win32') spawn('explorer.exe', [`/select,${folder}`], { detached: true, stdio: 'ignore' }).unref();
    return { ok: process.platform === 'win32', folder };
  }

  /// Rebuild the hook from the sim's current files and copy it into community (or the folder found as
  /// in --detect). The sim must be closed: it reads Community add-ons only when it starts.
  async reinstall(community) {
    if (this.busy) throw new Error('a reinstall is already running');
    if (await this.simRunning()) throw new Error('Close MSFS first: it loads Community add-ons only when it starts.');
    const dir = clean(community);
    const access = dir ? probe(dir) : 'ok';
    if (access === 'missing') throw new Error(`That folder does not exist: ${dir}`);
    if (access === 'denied') {
      throw new Error(`CockpitCast is not allowed to open ${dir} (it exists). ${(await isElevated()) ? 'CockpitCast is running as administrator: quit it from the tray icon and start it normally from the Start menu.' : 'Security software may be blocking CockpitCast.'}`);
    }
    this.busy = true;
    try {
      log.info(`reinstalling the hook${dir ? ` into ${dir}` : ''}`);
      const r = await this.run('setup-hook.mjs', dir ? ['--community', dir] : [], 180_000);
      this.last = { ok: r.code === 0, output: r.out, at: new Date().toISOString(), community: dir || null };
      log.info(this.last.ok ? 'hook reinstalled' : `hook reinstall failed (exit ${r.code})`);
      return this.last;
    } finally {
      this.busy = false;
    }
  }
}
