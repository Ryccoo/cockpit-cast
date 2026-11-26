'use strict';
// The CockpitCast window around the layout editor (editor.html): the side menu's Status, Help and
// Settings sections, the "install the hook by hand" part of Sim add-on, and the status bar at the bottom
// (version, host, sim, hook, capture, display apps), shown in every section.
// Uses editor.html's globals ($, esc, send, connected, screens, displayInfo, localState, setTab, ...);
// editor.html calls shellMsg(m) for host messages and renderShell() when the connection or tab changes.

const shell = { welcome: null, status: null, apps: null, startup: null, checking: false };
const isLocalPage = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function shellMsg(m) {
  if (m.type === 'welcome') shell.welcome = m;
  else if (m.type === 'status') shell.status = m;
  else if (m.type === 'apps') shell.apps = m;
  else return;
  renderShell();
}

// ---- what the parts are doing, in words: [state ('ok' | 'warn' | 'bad' | 'idle'), short, long] ----
function simState() {
  const s = shell.status?.sim;
  if (!connected) return ['idle', '\u2014', 'Not known: CockpitCast (the host) is not connected.'];
  if (!s?.connected) return ['idle', 'not running', 'MSFS is not running (or not ready yet).'];
  if (!s.inFlight) return ['idle', 'in the menu', 'MSFS is running, no flight loaded.'];
  const ac = s.aircraft ? ` \u00b7 ${s.aircraft}` : '';
  return ['ok', (s.paused ? 'paused' : 'in flight') + ac, `In a flight${s.paused ? ' (paused)' : ''}${s.aircraft ? `: ${s.aircraft}` : ''}.`];
}
function hookVersionOk() {
  const v = shell.status?.hook?.versions ?? [], mine = shell.welcome?.version;
  return !v.length || !mine || v.includes(mine);
}
function hookState() {
  const h = shell.status?.hook, s = shell.status?.sim;
  if (!connected || !s?.connected) return ['idle', '\u2014', 'Reports when MSFS runs a flight.'];
  if (h?.connected && !hookVersionOk()) return ['warn', 'outdated', `Active, but version ${(h.versions ?? []).join(', ')} (CockpitCast is ${shell.welcome?.version}). Reinstall it in Sim add-on.`];
  if (h?.connected) return ['ok', 'active', `Active: ${h.pages ?? 0} instrument page${h.pages === 1 ? '' : 's'} reported.`];
  if (s.inFlight && (s.liveForSec ?? 0) > 30) return ['bad', 'not detected', 'In a flight, but the hook has not reported. Is it installed in the Community folder MSFS reads? See Sim add-on.'];
  return ['idle', 'waiting', 'Waiting for a flight to load.'];
}
function liveDisplays() {
  return Object.values(displayInfo || {}).filter((d) => d.live).map((d) => d.name || d.id);
}
function captureState() {
  const c = shell.status?.capture, s = shell.status?.sim;
  if (!connected || !s?.connected) return ['idle', '\u2014', 'Starts with a flight.'];
  if (!c?.connected) return s.inFlight ? ['warn', 'starting', `Not loaded yet (injector: ${c?.injector ?? '?'}). It loads about 10 s after a flight is live.`] : ['idle', 'waiting', 'Loads when a flight is live.'];
  const live = liveDisplays();
  return ['ok', live.length ? live.join(', ') : 'ready', live.length ? `Capturing ${live.join(', ')}.` : 'Loaded in the sim; nothing is captured until a screen shows a glass display.'];
}
function appsState() {
  const a = shell.apps;
  if (!connected || !a) return ['idle', '\u2014', ''];
  if (!a.apps) return ['idle', 'none', 'No display app connected. Start the CockpitCast display app on a display PC: it finds this PC by itself.'];
  return ['ok', `${a.apps}${a.paused ? ` (${a.paused} paused)` : ''}`, `${a.apps} display app${a.apps === 1 ? '' : 's'} connected${a.paused ? `, ${a.paused} paused` : ''}.`];
}
function updateInfo() {
  return shell.status?.update ?? null;
}

// ---- status bar (every section) ----
function renderStatusBar() {
  const item = (id, label, [state, short]) => {
    const el = $(id);
    el.className = 'sbi ' + state;
    el.querySelector('b').textContent = short;
    el.title = label;
  };
  const u = updateInfo();
  $('sbVer').textContent = `CockpitCast ${u?.current || shell.welcome?.version || ''}`;
  const upd = $('sbUpd');
  upd.style.display = u && (u.available || u.state === 'downloading' || u.state === 'installing' || u.state === 'error') ? '' : 'none';
  upd.textContent = !u ? '' : u.state === 'installing' ? `installing ${u.latest}\u2026` : u.state === 'downloading' ? `downloading ${u.latest}\u2026` : u.state === 'error' ? 'update failed' : `update ${u.latest} available`;
  upd.className = 'sbu' + (u?.state === 'error' ? ' bad' : '');
  const host = $('sbHost');
  host.className = 'sbi ' + (connected ? 'ok' : 'bad');
  host.querySelector('b').textContent = connected ? 'connected' : 'not connected';
  host.title = connected ? `This window is connected to CockpitCast on ${shell.welcome?.host ?? location.host}` : 'CockpitCast (the host) is not running or not reachable: retrying';
  item('sbSim', 'MSFS', simState());
  item('sbHook', 'The Community hook in the sim', hookState());
  item('sbCap', 'Capture of the glass displays', captureState());
  item('sbApps', 'Display apps connected', appsState());
  $('sbAdmin').style.display = shell.status?.elevated ? '' : 'none';
}

function renderSide() {
  const u = updateInfo();
  $('sideVer').textContent = u?.current || shell.welcome?.version || '';
  $('sideUpd').style.display = u?.available ? '' : 'none';
  if (u?.available) $('sideUpd').textContent = `Update ${u.latest} available`;
  const [hs] = hookState();
  $('navAddonDot').className = 'navdot ' + (hs === 'bad' || hs === 'warn' ? hs : '');
  $('navSettingsDot').className = 'navdot ' + (u?.available ? 'ok' : '');
}

// ---- Status section ----
function renderStatusPage() {
  const card = (title, [state, short, long], tab, extra = '') => `<div class="stcard ${state}">
    <div class="h">${esc(title)}</div><div class="v">${esc(short)}</div><div class="d">${esc(long)}${extra}</div>
    ${tab ? `<a href="#${tab}" data-go="${tab}">${{ addon: 'Sim add-on', help: 'Help', screens: 'Screens', settings: 'Settings' }[tab]} \u203a</a>` : ''}</div>`;
  const local = localState === 'none' ? ['idle', 'not used', 'Screens can also show on monitors of this PC: "On this PC" in Screens.']
    : localState === 'on' ? ['ok', 'on', 'Screens set to "On this PC" are shown here.'] : ['idle', 'off', 'Turned off. Switch them on in Screens or the tray menu.'];
  const hostCard = connected ? ['ok', 'running', `CockpitCast ${shell.welcome?.version ?? ''} on ${shell.welcome?.host ?? location.host}.`] : ['bad', 'not connected', 'CockpitCast is not running (start it from the Start menu) or not reachable. Retrying.'];
  $('stCards').innerHTML = card('CockpitCast', hostCard, '') + card('MSFS', simState(), '') + card('Sim add-on (hook)', hookState(), 'addon')
    + card('Glass capture', captureState(), 'help') + card('Display apps', appsState(), 'help') + card('Screens on this PC', local, 'screens');
  // Things to fix, with where.
  const w = [];
  const u = updateInfo();
  if (shell.status?.elevated) w.push(['bad', '<b>CockpitCast is running as administrator.</b> It can then be refused folders you can open (such as the MS Store sim\'s Community folder). Quit it from the tray icon and start it normally from the Start menu.', '']);
  const [hs, , hl] = hookState();
  if (hs === 'bad' || hs === 'warn') w.push([hs, esc(hl), 'addon']);
  if (u?.available) w.push(['ok', `<b>CockpitCast ${esc(u.latest)}</b>${String(u.latest).includes('-') ? ' (beta)' : ''} is available.`, 'settings']);
  if (u?.state === 'error') w.push(['bad', `Update failed: ${esc(u.error)}`, 'settings']);
  $('stWarn').innerHTML = w.map(([k, t, tab]) => `<div class="stwarn ${k}">${t}${tab ? ` <a href="#${tab}" data-go="${tab}">${{ addon: 'Sim add-on', settings: 'Settings' }[tab]} \u203a</a>` : ''}</div>`).join('');
}

// ---- Help section: troubleshooting commands (this PC's paths), logs, diagnostics ----
const trouble = { node: null, setupHook: null, logs: null, loaded: false };
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`; // a PowerShell string that takes the text as it is
const tNode = () => (trouble.node ? psq(trouble.node) : '"$env:LOCALAPPDATA\\Programs\\CockpitCast\\node\\node.exe"');
function renderTrouble() {
  const folder = $('tFolder').value.trim().replace(/^"(.*)"$/, '$1').trim() || 'C:\\path\\to\\your\\Community';
  const setupHook = trouble.setupHook ? psq(trouble.setupHook) : '"$env:LOCALAPPDATA\\Programs\\CockpitCast\\hook\\setup-hook.mjs"';
  $('cmdInstall').textContent = `& ${tNode()} ${setupHook} --community ${psq(folder)}`;
  $('cmdCheck').textContent = `& ${tNode()} -e "try{console.log('found, folder:', require('fs').statSync(process.argv[1]).isDirectory())}catch(e){console.log(e.code, e.message)}" ${psq(folder)}`;
  $('cmdWhere').textContent =
    'Select-String -Path "$env:APPDATA\\Microsoft Flight Simulator 2024\\UserCfg.opt", "$env:LOCALAPPDATA\\Packages\\Microsoft.Limitless_8wekyb3d8bbwe\\LocalCache\\UserCfg.opt" -Pattern InstalledPackagesPath -ErrorAction SilentlyContinue';
  const logs = trouble.logs ? psq(trouble.logs + '\\*') : '"$env:LOCALAPPDATA\\CockpitCast\\logs\\*"';
  $('cmdLogs').textContent = [
    `$out = Join-Path $env:TEMP ('cockpitcast-report-' + (Get-Date -Format yyyyMMdd-HHmmss)); New-Item -ItemType Directory $out | Out-Null`,
    `Copy-Item ${logs} $out; Copy-Item "$env:LOCALAPPDATA\\CockpitCast\\client-update.log" $out -ErrorAction SilentlyContinue`,
    `Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddHours(-3); Id=1000,1001,1002} -ErrorAction SilentlyContinue | Format-List TimeCreated, Id, ProviderName, Message | Out-File "$out\\windows-app-errors.txt" -Width 300`,
    `Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddHours(-3); Level=1,2,3} -ErrorAction SilentlyContinue | Format-List TimeCreated, Id, ProviderName, Message | Out-File "$out\\windows-system-errors.txt" -Width 300`,
    `Compress-Archive -Path "$out\\*" -DestinationPath "$([Environment]::GetFolderPath('Desktop'))\\CockpitCast-logs.zip" -Force; 'Saved: CockpitCast-logs.zip on the desktop'`,
  ].join('\n');
}
async function loadTrouble() {
  if (trouble.loaded) return;
  trouble.loaded = true;
  try {
    const r = await fetch('/api/troubleshoot', { cache: 'no-store' });
    if (r.ok) {
      Object.assign(trouble, await r.json());
      if (trouble.community && !$('tFolder').value) $('tFolder').value = trouble.community;
    }
  } catch {}
  renderTrouble();
}
$('tFolder').oninput = renderTrouble;
for (const b of document.querySelectorAll('[data-copy]')) {
  b.onclick = async () => {
    const pre = $(b.dataset.copy);
    try {
      await navigator.clipboard.writeText(pre.textContent); // pages on this PC (localhost)
    } catch {
      const sel = getSelection(); // elsewhere: select it for Ctrl+C
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(pre);
      sel.addRange(range);
      b.textContent = 'Ctrl+C';
      setTimeout(() => (b.textContent = 'Copy'), 2000);
      return;
    }
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  };
}
// POST to a local-only API; the answer in msgId.
async function localPost(url, msgId, busyText, doneText) {
  const msg = $(msgId);
  msg.textContent = busyText || '';
  try {
    const r = await fetch(url, { method: 'POST' });
    if (r.status === 403) return void (msg.textContent = 'Only on the sim PC itself (this window is open on another computer).');
    const j = await r.json().catch(() => ({}));
    msg.textContent = j.error ? j.error : j.ok === false ? `Failed: ${j.output || 'see the logs'}` : doneText || '';
  } catch (e) {
    msg.textContent = e.message;
  }
}
$('btnBuildHook').onclick = () => localPost('/api/hook-setup/build', 'buildHookMsg', 'Building\u2026', 'Built.');
$('btnOpenBuilt').onclick = () => localPost('/api/hook-setup/open-built', 'buildHookMsg');
for (const id of ['btnOpenLogs', 'btnOpenLogs2']) $(id).onclick = () => localPost('/api/open-logs', id === 'btnOpenLogs' ? 'openLogsMsg' : 'openLogsMsg2');

// Diagnostics: display apps (identify, pause) and the instruments in this cockpit.
function renderAppsTable() {
  const box = $('diagApps'), m = shell.apps;
  if (!m) return void (box.innerHTML = '<p class="hint">Loading\u2026</p>');
  if (!m.list.length) return void (box.innerHTML = '<p class="hint">No display apps connected. Start the CockpitCast display app on a display PC; it finds this PC by itself.</p>');
  const ago = (s) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
  box.innerHTML = `<div class="scwrap"><table class="dtable"><thead><tr><th>Device</th><th>Window</th><th>Shows</th><th>Receiving</th><th>Address</th><th>Version</th><th></th></tr></thead><tbody>${
    m.list.map((a) => {
      const recv = a.paused ? '<span class="bad">paused</span>'
        : [a.displays.length ? `${esc(a.displays.join(', '))} \u00b7 ${a.fps} fps` : '', a.gauges ? 'gauge data' : ''].filter(Boolean).join(' + ') || '<span class="sub">nothing</span>';
      const kind = a.kind === 'settings' ? ' <span class="sub">(settings page)</span>' : '';
      const actions = a.canPause
        ? `<button class="icon" data-app="${a.id}" data-a="identify" title="Show this app's name on its screen for a few seconds">Identify</button> <button class="icon" data-app="${a.id}" data-a="${a.paused ? 'resume' : 'pause'}" title="${a.paused ? 'Start sending to it again' : 'Send it nothing (no capture for it), until resumed'}">${a.paused ? 'Resume' : 'Pause'}</button>`
        : '';
      return `<tr><td>${esc(a.name)}${kind}</td><td>${esc(a.window ?? '')}</td><td>${esc(a.shows ?? '')}</td><td>${recv}</td><td>${esc(a.address)}</td><td>${esc(a.version ?? 'old')}${a.platform ? ' \u00b7 ' + esc(a.platform) : ''} \u00b7 ${ago(a.connectedSec)}</td><td class="nowrap">${actions}</td></tr>`;
    }).join('')
  }</tbody></table></div>
  <p class="hint"><b>Identify</b> shows the app's name on its screen. <b>Pause</b> sends it nothing, so nothing is captured just for it; it shows "Paused" and stays paused (also after restarts) until resumed here.</p>`;
}
$('diagApps').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-app]');
  if (!b || !connected) return;
  b.disabled = true;
  send({ type: 'appAction', id: Number(b.dataset.app), action: b.dataset.a });
});
async function loadInstruments() {
  const box = $('diagInst');
  try {
    const [ri, rd] = await Promise.all([fetch('/api/instruments', { cache: 'no-store' }), fetch('/api/displays', { cache: 'no-store' })]);
    if (ri.status === 403) return void (box.innerHTML = '<p class="hint">Only on the sim PC itself.</p>');
    const d = await ri.json();
    const reg = new Map((await rd.json()).displays.map((x) => [x.id, x]));
    $('diagInstAc').textContent = d.aircraft ? `\u00b7 ${d.aircraft}` : '';
    if (!d.current.length) return void (box.innerHTML = '<p class="hint">No instrument pages reported yet. Load a flight (the hook must be installed).</p>' + learnedList(reg));
    box.innerHTML = `<div class="scwrap"><table class="dtable"><thead><tr><th>Instrument</th><th>Size</th><th>Display</th><th></th><th>Details</th></tr></thead><tbody>${
      d.current.map((i) => {
        const disp = i.capturedAs ? reg.get(i.capturedAs) : null;
        const status = disp ? `<span class="on">${esc(disp.name)}</span> <span class="sub">${esc(disp.id)}${disp.primary ? ' \u00b7 primary' : ''}${disp.builtIn ? ' \u00b7 built in' : ''}</span>` : '<span class="sub">not a display</span>';
        const actions = !disp ? `<button class="icon" data-act="add" data-key="${esc(i.key)}">Add as display</button>`
          : disp.learned ? `<button class="icon" data-act="primary" data-id="${esc(disp.id)}" data-v="${!disp.primary}">${disp.primary ? 'Not primary' : 'Make primary'}</button> <button class="icon danger" data-act="forget" data-id="${esc(disp.id)}">Forget</button>` : '';
        return `<tr><td><code>${esc(i.key)}</code></td><td>${i.w}\u00d7${i.h}</td><td>${status}</td><td class="nowrap">${actions}</td><td class="sub">${esc(i.templateID || i.url || '')}</td></tr>`;
      }).join('')
    }</tbody></table></div>
    <p class="hint">Instruments the sim draws on their own page, largest first. They become displays by themselves and are remembered on this PC. <b>Primary</b> displays (PFD, MFD, EICAS...) make a cockpit a glass cockpit for the screens.</p>` + learnedList(reg, d.current);
  } catch {
    box.innerHTML = '<p class="hint">CockpitCast is not reachable.</p>';
  }
}
function learnedList(reg, current = []) {
  const here = new Set(current.map((i) => i.capturedAs));
  const rest = [...reg.values()].filter((x) => x.learned && !here.has(x.id));
  if (!rest.length) return '';
  return `<h2>Other displays learned on this PC</h2><div class="scwrap"><table class="dtable"><tbody>${rest.map((x) => `<tr><td>${esc(x.name)} <span class="sub">${esc(x.id)}${x.primary ? ' \u00b7 primary' : ''}</span></td><td class="sub">${esc((x.aircraft ?? []).join(', '))}</td><td><button class="icon danger" data-act="forget" data-id="${esc(x.id)}">Forget</button></td></tr>`).join('')}</tbody></table></div>`;
}
$('diagInst').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  const body = b.dataset.act === 'add' ? { key: b.dataset.key } : b.dataset.act === 'forget' ? { id: b.dataset.id, forget: true } : { id: b.dataset.id, primary: b.dataset.v === 'true' };
  if (b.dataset.act === 'forget' && b.textContent !== 'Sure?') return void (b.textContent = 'Sure?');
  b.disabled = true;
  await fetch('/api/displays', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  loadInstruments();
});
$('diagInstRefresh').onclick = loadInstruments;

// ---- Settings section ----
function renderSettings() {
  const u = updateInfo();
  const notes = u?.url ? ` <a href="${esc(u.url)}" target="_blank" rel="noopener">What's new</a>` : '';
  $('setVersion').innerHTML = !u ? '\u2014'
    : `<b>${esc(u.current)}</b>${u.state === 'installing' ? ` \u00b7 installing ${esc(u.latest)}\u2026` : u.state === 'downloading' ? ` \u00b7 downloading ${esc(u.latest)}\u2026`
      : u.available ? ` \u00b7 <span class="on">${esc(u.latest)} is available</span>${notes}` : u.latest ? ' \u00b7 up to date' : ''}`
      + (u.state === 'error' ? `<div class="sub bad">Update failed: ${esc(u.error)}</div>` : '');
  const canInstall = u?.available && u.canInstall && isLocalPage && u.state !== 'installing' && u.state !== 'downloading';
  $('btnInstallUpdate').style.display = u?.available ? '' : 'none';
  $('btnInstallUpdate').disabled = !canInstall;
  $('btnInstallUpdate').textContent = u?.state === 'error' ? 'Try again' : `Install ${u?.latest ?? ''} and restart`;
  $('setInstallHint').textContent = u?.available && !u.canInstall ? 'This copy cannot update itself: download the new version from the website.' : u?.available && !isLocalPage ? 'Install it on the sim PC.' : '';
  $('btnCheckUpdate').disabled = shell.checking || !connected || !isLocalPage;
  $('setBeta').checked = !!u?.beta;
  $('setBeta').disabled = !isLocalPage || !connected;
  $('setStartup').disabled = !isLocalPage || shell.startup === null;
  $('setStartup').checked = !!shell.startup;
  $('setLocalOnly').style.display = isLocalPage ? 'none' : '';
}
$('btnCheckUpdate').onclick = () => {
  shell.checking = true;
  send({ type: 'checkUpdate' });
  $('setCheckMsg').textContent = 'Checking\u2026';
  setTimeout(() => { shell.checking = false; $('setCheckMsg').textContent = ''; renderSettings(); }, 4000);
  renderSettings();
};
$('btnInstallUpdate').onclick = () => { $('btnInstallUpdate').disabled = true; send({ type: 'installUpdate' }); };
$('setBeta').onchange = (e) => send({ type: 'setUpdateBeta', on: e.target.checked });
async function loadStartup() {
  if (!isLocalPage) return;
  try {
    const r = await fetch('/api/startup', { cache: 'no-store' });
    if (r.ok) shell.startup = (await r.json()).on;
  } catch {}
  renderSettings();
}
$('setStartup').onchange = async (e) => {
  $('setStartupMsg').textContent = '';
  try {
    const r = await fetch('/api/startup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: e.target.checked }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) $('setStartupMsg').textContent = j.error || `Not changed (${r.status}).`;
    shell.startup = j.on ?? shell.startup;
  } catch (err) {
    $('setStartupMsg').textContent = err.message;
  }
  renderSettings();
};

// ---- glue: called by editor.html ----
function renderShell() {
  renderStatusBar();
  renderSide();
  const tab = document.body.dataset.tab;
  if (tab === 'status') renderStatusPage();
  else if (tab === 'help') renderAppsTable();
  else if (tab === 'settings') renderSettings();
}
let instTimer = null;
function shellTab(tab) {
  clearInterval(instTimer);
  if (tab === 'help') { loadTrouble(); loadInstruments(); instTimer = setInterval(() => !document.hidden && loadInstruments(), 10000); }
  if (tab === 'addon') loadTrouble();
  if (tab === 'settings') loadStartup();
  renderShell();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-go]');
  if (!a) return;
  e.preventDefault();
  setTab(a.dataset.go);
});
renderTrouble();
shellTab(document.body.dataset.tab);
setInterval(renderStatusBar, 2000); // the "not detected after 30 s" and capture states change with time
