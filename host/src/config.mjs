// Host configuration: defaults, overridden by host/config.json (optional) and then by environment variables.
// The display table comes from config/displays.json (shared with the hook build).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(HOST_DIR, '..');
// Installed copies keep the C++ programs in <root>\bin; a source checkout has them in their build folders.
const BIN = path.join(ROOT, 'bin');
const built = (dir, file) => (fs.existsSync(path.join(BIN, file)) ? path.join(BIN, file) : path.join(ROOT, dir, 'build', 'Release', file));
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CockpitCast');
moveLegacyDataDir();

// Until version 0.1.1 the project was called "Cockpit Link" and kept its data in %LOCALAPPDATA%\CockpitLink.
// Move it (learned displays, layouts, screens, saved pictures, logs) the first time this version runs.
// The new folder may exist already (the installer's hook setup writes its log there), so the old one is
// merged in: whatever the new folder does not have yet is moved, folders (thumbs, logs) file by file.
function moveLegacyDataDir() {
  const old = path.join(path.dirname(DATA_DIR), 'CockpitLink');
  if (!fs.existsSync(old)) return;
  const merge = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isDirectory()) merge(a, b);
      else if (!fs.existsSync(b)) fs.renameSync(a, b);
    }
  };
  try {
    merge(old, DATA_DIR);
    fs.rmSync(old, { recursive: true, force: true }); // what is left was already in the new folder
  } catch {} // in use or not allowed: keep going with what moved
}

const DEFAULTS = {
  port: 8800,
  // JPEG quality capture.dll encodes at (1-100).
  jpegQuality: 80,
  // Upper limit for capture fps per display; the DLL captures at the highest rate any client asks for, up to this.
  maxCaptureFps: 30,
  // Inject capture.dll automatically once a flight has been live (running, unpaused) for injectDelaySec.
  autoInject: true,
  injectDelaySec: 10,
  // Wait for a live flight before injecting. false only for tests with fake-sim.exe (no SimConnect).
  requireFlight: true,
  simExe: 'FlightSimulator2024.exe',
  dllPath: built('capture', 'cockpitcast-capture.dll'),
  injectorPath: built('injector', 'cockpitcast-injector.exe'),
  // Tray icon on Windows (click: layout editor). Off when the program is not built or tray is false.
  tray: true,
  trayPath: fs.existsSync(path.join(ROOT, 'cockpitcast.exe')) ? path.join(ROOT, 'cockpitcast.exe') : built('tray', 'cockpitcast-tray.exe'),
  // The DLL stops capturing (pass-through) when it hears nothing from the host for this long.
  heartbeatMs: 1000,
  heartbeatTimeoutMs: 10000,
  // What each client screen shows (clients started with --screen <id> follow this; see screens.mjs).
  screens: [
    { id: '1', name: 'Screen 1', glass: 'pfd', steam: 'six-pack' },
    { id: '2', name: 'Screen 2', glass: 'mfd', steam: 'engine-radios' },
  ],
  // Fallback when the hook reports no instruments at all: steam layouts once a flight has been live this long.
  // (Normally the screens decide from the instruments the hook reports, within about 10 s.)
  steamAfterSec: 30,
  // 'auto' (detect), 'glass' or 'steam' (force).
  screenMode: 'auto',
  // Gauge data: highest rate sent to a client.
  maxDataHz: 60,
  // Use synthetic flight data instead of SimConnect (testing gauges without the sim).
  fakeData: false,
  // Check GitHub for new releases (installing always needs a click). See updater.mjs.
  updates: true,
  updateRepo: 'Ryccoo/cockpit-cast',
  // Where the latest release is described (GitHub API format); null = the GitHub repo above.
  updateUrl: null,
  // 'beta': also offer beta versions (pre-releases). Normally switched on the monitor page instead.
  updateChannel: 'stable',
  root: ROOT,
  dataDir: DATA_DIR,
  logFile: path.join(DATA_DIR, 'logs', 'host.log'),
};

const ENV = {
  COCKPITCAST_PORT: ['port', Number],
  COCKPITCAST_AUTO_INJECT: ['autoInject', (v) => v !== '0' && v !== 'false'],
  COCKPITCAST_DLL: ['dllPath', String],
  COCKPITCAST_INJECTOR: ['injectorPath', String],
  COCKPITCAST_SIM_EXE: ['simExe', String],
  COCKPITCAST_REQUIRE_FLIGHT: ['requireFlight', (v) => v !== '0' && v !== 'false'],
  COCKPITCAST_SCREEN_MODE: ['screenMode', String],
  COCKPITCAST_FAKE_DATA: ['fakeData', (v) => v === '1' || v === 'true'],
  COCKPITCAST_TRAY: ['tray', (v) => v !== '0' && v !== 'false'],
  COCKPITCAST_UPDATES: ['updates', (v) => v !== '0' && v !== 'false'],
  COCKPITCAST_UPDATE_URL: ['updateUrl', String],
  COCKPITCAST_UPDATE_CHANNEL: ['updateChannel', String],
};

export function loadConfig() {
  const cfg = { ...DEFAULTS };
  const file = path.join(HOST_DIR, 'config.json');
  if (fs.existsSync(file)) Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const [name, [key, conv]] of Object.entries(ENV)) if (process.env[name]) cfg[key] = conv(process.env[name]);
  cfg.displays = loadDisplays();
  return cfg;
}

export function loadDisplays() {
  const file = path.join(ROOT, 'config', 'displays.json');
  const { displays } = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const d of displays) {
    if (!/^[a-z0-9_-]{1,32}$/.test(d.id)) throw new Error(`displays.json: bad id '${d.id}'`);
    if (!Array.isArray(d.marker) || d.marker.length !== 2) throw new Error(`displays.json: '${d.id}' needs two marker colours`);
  }
  return displays;
}
