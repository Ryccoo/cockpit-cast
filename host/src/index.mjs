// CockpitCast host: entry point.
//   capture.dll <--(named pipe, two-way)--> CaptureLink --> FrameHub --> ClientServer --(WebSocket)--> client apps
//   Community hook --(WebSocket /hook)--> HookServer --> layouts --+
//   client subscriptions ------------------------------------------+--> CaptureConfig --> CONFIG to capture.dll
//   SimConnect --> SimMonitor --> Injector (loads capture.dll once the flight is live)
//   Community hook (every instrument page) --> InstrumentLog (what else the cockpit could stream)
//   Tray icon (Windows): shows the host is running; click opens the layout editor

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { FrameHub } from './frameHub.mjs';
import { CaptureConfig } from './captureConfig.mjs';
import { CaptureLink } from './captureLink.mjs';
import { HookServer } from './hookServer.mjs';
import { Injector } from './injector.mjs';
import { ClientServer } from './clientServer.mjs';
import { SimMonitor } from './sim.mjs';
import { FakeData } from './fakeData.mjs';
import { LayoutStore } from './layouts.mjs';
import { Screens } from './screens.mjs';
import { InstrumentLog } from './instruments.mjs';
import { DisplayRegistry } from './displayRegistry.mjs';
import { DisplayCatalog } from './catalog.mjs';
import { SIMVARS } from './simvars.mjs';
import { advertise } from './discovery.mjs';
import { Tray } from './tray.mjs';
import { Updater } from './updater.mjs';
import { HookSetup, isElevated } from './hookSetup.mjs';
import { logToConsole, logToFile, makeLog } from './log.mjs';

const cfg = loadConfig();
if (Tray.parented) logToConsole(false); // stdout is the tray launcher's channel
logToFile(cfg.logFile);
const log = makeLog('host');
const { version, funding } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Glass displays: built in (config/displays.json) plus those learned on this computer as cockpits are flown.
const registry = new DisplayRegistry({ builtIn: cfg.displays, dataDir: cfg.dataDir });
const hub = new FrameHub(registry.all());
const hook = new HookServer({ registry });
const captureConfig = new CaptureConfig(cfg, { registry, present: () => hook.present() });
const capture = new CaptureLink({ hub, captureConfig, heartbeatMs: cfg.heartbeatMs });
const sim = new SimMonitor();
const injector = new Injector({ cfg, sim, capture });
const layouts = new LayoutStore(cfg.dataDir);
const instruments = new InstrumentLog({ dataDir: cfg.dataDir, sim, hook, registry });
const screens = new Screens({ cfg, sim, hook, registry, instruments });
// For the editor's Insert window: displays by aircraft, with a saved picture of each.
const catalog = new DisplayCatalog({ registry, instruments, hook, sim, hub, dataDir: cfg.dataDir });
registry.on('change', () => {
  hub.sync(registry.all());
  captureConfig.update();
});
hook.on('status', () => captureConfig.update());
// What capture.dll captures: what clients watch, plus short grabs for the catalog's saved pictures.
let clientWanted = new Map();
function pushWanted() {
  const w = new Map(clientWanted);
  for (const [id, fps] of catalog.wanted()) if (!w.has(id)) w.set(id, fps);
  captureConfig.setWanted(w);
}
catalog.on('wanted', pushWanted);
const dataSource = cfg.fakeData ? new FakeData() : sim;

// Sent to client apps (keep small: it is broadcast on every change).
const updater = new Updater({ cfg, version });
// Running as administrator: some folders (a Store app's Community folder) can then be refused. Warned
// about in the log, the monitor and the editor's Sim add-on tab.
let elevated = false;
isElevated().then((e) => {
  elevated = e;
  if (e) log.warn('running as administrator: start CockpitCast normally (not "Run as administrator"); an elevated copy can be refused the sim\'s Community folder');
});
const getStatus = () => ({ sim: sim.status(), capture: { ...capture.status(), injector: injector.status().state }, hook: hook.status(), update: updater.info(), elevated });
// Extra detail for /api/status only.
const getDetail = () => ({
  injector: injector.status(),
  sources: capture.detail(),
  hookLayouts: hook.detail(),
  captureConfig: captureConfig.current,
  screens: screens.list(),
  gaugeData: {
    source: cfg.fakeData ? 'fake' : 'simconnect',
    frames: sim.dataCount,
    // Latest values by key (only while some client shows gauges), for checking against the cockpit.
    latest: latestGauge ? Object.fromEntries(SIMVARS.map((v, i) => [v.key, Math.round(latestGauge[i] * 1000) / 1000])) : null,
  },
});

const clients = new ClientServer({
  port: cfg.port,
  hub,
  getStatus,
  getDetail,
  version,
  layouts,
  screens,
  catalog,
  maxDataHz: cfg.maxDataHz,
  dataDir: cfg.dataDir,
  onWanted: (w) => {
    clientWanted = w;
    pushWanted();
  },
  onDataWanted: (w) => dataSource.setDataWanted(w),
  onInstallUpdate: () => installUpdate(),
  onSetUpdateBeta: (on) => updater.setBeta(on),
});
let latestGauge = null;
dataSource.on('data', (values) => {
  latestGauge = values;
  clients.pushData(values);
});
layouts.on('change', (l) => clients.broadcastLayouts(l));
screens.on('change', (s) => clients.broadcastScreens(s));
clients.addUpgrade('/hook', hook.wss);
clients.addApi('GET', '/api/instruments', () => instruments.report());
clients.addApi('GET', '/api/displays', () => ({ displays: registry.all(), present: [...hook.present()] }));
// Body: { key } adds an instrument by hand; { id, name?, primary? } changes a learned display; { id, forget: true }.
clients.addApi('POST', '/api/displays', async (req) => {
  const body = await readJson(req);
  if (body.key) {
    const i = instruments.report().current.find((x) => x.key === body.key) ?? { key: body.key };
    return registry.add(i, instruments.aircraft, 'added by hand');
  }
  if (body.forget) return registry.forget(body.id) ?? { ok: true };
  return registry.update(body.id, { name: body.name, primary: body.primary });
});
clients.addApi('POST', '/api/inject', () => injector.injectNow());
// The editor's Sim add-on tab: where the Community hook is, and reinstalling it (see hookSetup.mjs).
const hookSetup = new HookSetup({ cfg, hook, version });
clients.addApi('GET', '/api/hook-setup', () => hookSetup.status());
clients.addApi('POST', '/api/hook-setup/reinstall', async (req) => hookSetup.reinstall((await readJson(req)).community));
// The monitor's Troubleshooting section: this PC's paths, for commands people can paste into PowerShell.
clients.addApi('GET', '/api/troubleshoot', async () => {
  const h = await hookSetup.status();
  return {
    node: process.execPath,
    setupHook: path.join(cfg.root, 'hook', 'setup-hook.mjs'),
    logs: path.dirname(cfg.logFile),
    community: h.community,
    from: h.from,
    elevated: h.elevated,
  };
});
clients.addApi('POST', '/api/capture/shutdown', () => {
  capture.shutdownSources();
  return { ok: true };
});
hook.on('layouts', (l) => captureConfig.setLayouts(l));

function readJson(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (c) => {
      text += c;
      if (text.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

let lastStatus = '';
function statusChanged() {
  const s = getStatus();
  delete s.sim.liveForSec; // changes every second; not worth a broadcast
  const json = JSON.stringify(s);
  if (json === lastStatus) return;
  lastStatus = json;
  clients.broadcastStatus();
}
for (const src of [sim, capture, hook, injector]) src.on('status', statusChanged);
updater.on('change', (u) => {
  statusChanged();
  tray.setUpdate(u.available && u.canInstall ? u.latest : null);
});
// The injector waits on liveForSec, which changes without an event.
sim.on('status', () => injector.tick());

log.info(`CockpitCast host ${version} starting (log: ${cfg.logFile})`);
try {
  await clients.start();
} catch (err) {
  log.error(`cannot listen on port ${cfg.port}: ${err.message}`);
  process.exit(1);
}
capture.start();
sim.start();
injector.start();
const mdns = advertise(cfg.port);
const tray = new Tray({
  exe: cfg.trayPath,
  port: cfg.port,
  supportUrl: funding?.url ?? null,
  getState: () => {
    const s = sim.status();
    const live = hub.list().filter((d) => d.live);
    const { editors, monitors } = clients.setupInfo();
    const pages = [editors && 'editor', monitors && 'monitor'].filter(Boolean).join(' and ');
    return {
      level: live.length ? 'live' : s.connected ? 'sim' : 'idle',
      lines: [
        'CockpitCast host',
        s.connected ? `Sim: ${s.aircraft ?? 'running'}` : 'Sim: not running',
        // Streaming: only what client screens show is captured. Setup: an editor or monitor page is
        // open and visible, and previews are captured too.
        pages ? `Setup: ${pages} open, previews on` : `Streaming: ${live.length ? live.map((d) => d.name).join(', ') : 'nothing captured'}`,
        appsLine(clients.appsInfo()),
      ],
    };
  },
});
tray.on('quit', shutdown);
tray.on('update', () => installUpdate().catch((e) => log.warn(`update failed: ${e.message}`)));
if (cfg.tray || Tray.parented) tray.start();
updater.start();

// Install the newer version: download and check it, tell the client apps to update themselves too,
// then hand over to the installer, which restarts CockpitCast when done (see updater.mjs).
let installing = false;
async function installUpdate() {
  if (installing) return;
  installing = true;
  try {
    const file = await updater.download();
    clients.broadcast({ type: 'update' });
    updater.installing();
    setTimeout(() => {
      // The tray launcher stops the host, starts the installer and exits; otherwise the host does it.
      if (tray.parent) tray.install(file);
      else {
        updater.runInstaller(file);
        shutdown();
      }
    }, 1500); // let the pages and clients get the news
  } catch (e) {
    installing = false;
    throw e;
  }
}
log.info(`ready. Debug monitor: http://localhost:${cfg.port}/`);

// "Display apps: 2 (1 paused)": the client apps only, not the editor or monitor pages.
function appsLine({ apps, paused }) {
  return `Display apps: ${apps}${paused ? ` (${paused} paused)` : ''}`;
}

async function shutdown() {
  log.info('shutting down');
  updater.close();
  tray.close();
  injector.close();
  screens.close();
  instruments.close();
  catalog.close();
  if (dataSource !== sim) dataSource.close();
  sim.close();
  capture.close();
  hook.close();
  clients.close();
  hub.close();
  await Promise.race([mdns.close(), new Promise((r) => setTimeout(r, 1000))]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
