// Updates: checks GitHub for a newer release (a minute after start, then twice a day) and, on request,
// installs it. Nothing is installed without someone asking (tray menu, or the banner in the editor or
// monitor on this PC).
//
// Installing (installed copies on Windows only; a git checkout just shows that a release exists):
//   1. download CockpitLink-Host-Setup.exe from the release, check it against the release's
//      SHA256SUMS.txt;
//   2. the caller tells the client apps to update too;
//   3. the tray launcher stops the host, starts the installer and exits (tray/src/tray.cpp, "install");
//      without the launcher, the host starts the installer itself and exits.
//   The installer runs silently (a progress window only), waits for Cockpit Link to close, and starts it
//   again when done (/UPDATE=1, see installer/host.iss). Its log: %LOCALAPPDATA%\CockpitLink\logs\update-install.log.
// Turn the check off with "updates": false in host/config.json or COCKPIT_LINK_UPDATES=0.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeLog } from './log.mjs';

const log = makeLog('update');
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 12 * 3600_000;
const ASSET = 'CockpitLink-Host-Setup.exe';
const SUMS = 'SHA256SUMS.txt';

export class Updater extends EventEmitter {
  constructor({ cfg, version }) {
    super();
    this.cfg = cfg;
    this.current = version;
    this.repo = cfg.updateRepo;
    this.dir = path.join(cfg.dataDir, 'updates');
    // Installed by the Setup program (its uninstaller sits next to the tray launcher).
    this.installDir = cfg.root;
    this.canInstall = process.platform === 'win32' && fs.existsSync(path.join(cfg.root, 'unins000.exe')) && fs.existsSync(path.join(cfg.root, 'cockpit-link.exe'));
    this.release = null; // { version, url, assets: { name: download url } }
    this.state = 'idle'; // idle | available | downloading | installing | error
    this.error = null;
    this.timers = [];
  }

  start() {
    if (!this.cfg.updates || !(this.repo || this.cfg.updateUrl)) return void log.info('update check off');
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.check(), CHECK_EVERY_MS));
    this.cleanOld();
  }

  /// For the status message (pages show a banner; client apps ignore it).
  info() {
    return {
      current: this.current,
      latest: this.release?.version ?? null,
      available: !!this.release && newer(this.release.version, this.current),
      url: this.release?.url ?? null,
      state: this.state,
      error: this.error,
      canInstall: this.canInstall,
    };
  }

  async check() {
    try {
      const res = await fetch(this.cfg.updateUrl || `https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'cockpit-link-updater' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) return; // no release yet
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const r = await res.json();
      const version = String(r.tag_name ?? '').replace(/^v/, '');
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unexpected release tag '${r.tag_name}'`);
      const assets = Object.fromEntries((r.assets ?? []).map((a) => [a.name, a.browser_download_url]));
      const was = this.release?.version;
      this.release = { version, url: r.html_url, assets };
      if (newer(version, this.current)) {
        if (was !== version) log.info(`Cockpit Link ${version} is available (this is ${this.current}): ${r.html_url}`);
        if (this.state === 'idle' || this.state === 'error') this.set('available');
      } else if (this.state === 'available') this.set('idle');
    } catch (e) {
      log.warn(`update check failed: ${e.message}`);
    }
  }

  /// Download and check the installer. Returns its path.
  async download() {
    if (!this.canInstall) throw new Error('this copy was not installed with the Setup program; download the new version from the website');
    if (!this.release || !newer(this.release.version, this.current)) throw new Error('no newer version');
    const { version, assets } = this.release;
    if (!assets[ASSET] || !assets[SUMS]) throw new Error(`the release has no ${ASSET} or ${SUMS}`);
    this.set('downloading');
    try {
      const sums = await (await get(assets[SUMS])).text();
      const want = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+\*?/)).find((p) => p[1] === ASSET)?.[0]?.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(want ?? '')) throw new Error(`${SUMS} has no checksum for ${ASSET}`);
      const data = Buffer.from(await (await get(assets[ASSET])).arrayBuffer());
      const have = crypto.createHash('sha256').update(data).digest('hex');
      if (have !== want) throw new Error('the download does not match its checksum');
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `CockpitLink-Host-${version}-Setup.exe`);
      fs.writeFileSync(file, data);
      log.info(`downloaded ${file} (${(data.length / 1e6).toFixed(1)} MB, checksum OK)`);
      return file;
    } catch (e) {
      this.set('error', e.message);
      throw e;
    }
  }

  /// The arguments for a silent update (the tray launcher uses the same ones).
  installerArgs() {
    return ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/UPDATE=1', `/LOG=${path.join(this.cfg.dataDir, 'logs', 'update-install.log')}`];
  }

  /// Start the installer here (no tray launcher). The caller then stops the host.
  runInstaller(file) {
    spawn(file, this.installerArgs(), { detached: true, stdio: 'ignore' }).unref();
    log.info(`started ${path.basename(file)}`);
  }

  installing() {
    this.set('installing');
  }

  set(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('change', this.info());
  }

  /// Installers of versions already installed.
  cleanOld() {
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const v = /^CockpitLink-Host-(\d+\.\d+\.\d+)-Setup\.exe$/.exec(name)?.[1];
        if (v && !newer(v, this.current)) fs.rmSync(path.join(this.dir, name), { force: true });
      }
    } catch {}
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
  }
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'cockpit-link-updater' }, redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  return res;
}

/// a > b, for "x.y.z" versions.
export function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
