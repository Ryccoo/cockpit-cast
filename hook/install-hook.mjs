// Copies the built hook package into the MSFS 2024 Community folder, or removes it.
//
//   node hook/install-hook.mjs [--community <folder>] [--force]   install (sim must be closed)
//   node hook/install-hook.mjs --remove                            uninstall
//   node hook/install-hook.mjs --detect                            print (JSON) which folder it would use
//
// The Community folder, first match wins: --community, the MSFS_COMMUNITY environment variable, the
// folder chosen last time (saved in %LOCALAPPDATA%\CockpitCast\hook.json, so repairs after sim updates
// find it again), the Community folder set in MSFS Addons Linker, the sim's packages folder from
// UserCfg.opt, the default locations. A folder found through --community or MSFS_COMMUNITY is saved.
// Exit code 3: no Community folder found (the installer then asks for it). Nothing is changed when it
// exits with an error: an installed hook stays.
//
// Addons Linker (popular with people who keep add-ons on another drive) keeps the add-ons in its own
// library and puts links to the enabled ones into the sim's real Community folder. The hook goes into
// that Community folder as a normal folder, never into the library (the sim does not read the library).
// installer/host.iss looks for the folder in the same order (DetectCommunity) to fill in its page.
//
// Steam and MS Store versions keep add-ons in different places. When only the MS Store version is
// installed (its package folder exists, the Steam version's UserCfg.opt does not), Steam-style folders,
// including a remembered one, are leftovers: they are skipped, and MS Store folders come first. A folder
// named with --community or MSFS_COMMUNITY is always used as given.
// Folder checks tell "not there" from "not allowed in": an elevated or restricted CockpitCast can be
// refused a Store app's folder that Explorer opens fine.
//
// Only one package can override BaseInstrument.js at a time. If another Community package
// overrides it too, this refuses unless --force is given.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = 'zzz-cockpitcast-hook';
// The same hook under the project's former name (up to 0.1.1); removed when installing or removing.
const LEGACY_PKG = 'zzz-cockpit-link-hook';
const NOT_FOUND = 3;
const SAVED = path.join(process.env.LOCALAPPDATA ?? HERE, 'CockpitCast', 'hook.json');

const argv = process.argv.slice(2);
const args = new Set(argv);
const ci = argv.indexOf('--community');
const given = ci >= 0 ? argv[ci + 1] : null;

// A picked folder may be the packages folder that holds Community, or Community itself.
function asCommunity(dir) {
  if (!dir) return null;
  dir = path.resolve(dir.trim().replace(/^"|"$/g, ''));
  const inner = path.join(dir, 'Community');
  return path.basename(dir).toLowerCase() !== 'community' && fs.existsSync(inner) ? inner : dir;
}

// 'ok' (a folder we can open), 'denied' (there, but we may not open it), 'missing'.
function probe(p) {
  try {
    if (!fs.statSync(p).isDirectory()) return 'missing';
    fs.opendirSync(p).closeSync(); // listing it, as installing does (stat alone can pass where listing is refused)
    return 'ok';
  } catch (e) {
    return e.code === 'EPERM' || e.code === 'EACCES' ? 'denied' : 'missing';
  }
}
const DENIED =
  'CockpitCast is not allowed to open this folder (it exists). Is CockpitCast or setup running as administrator,\n' +
  'or blocked by security software? Start it normally (not "Run as administrator") and try again.';

// Which versions of the sim are installed (see above).
const STEAM_ROOT = path.join(process.env.APPDATA ?? '', 'Microsoft Flight Simulator 2024');
const STORE_ROOT = path.join(process.env.LOCALAPPDATA ?? '', 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe');
const storeOnly = probe(STORE_ROOT) !== 'missing' && !fs.existsSync(path.join(STEAM_ROOT, 'UserCfg.opt'));
const isSteamPath = (p) => !!p && path.resolve(p).toLowerCase().startsWith(STEAM_ROOT.toLowerCase() + path.sep);

function savedCommunity() {
  try {
    return JSON.parse(fs.readFileSync(SAVED, 'utf8')).community || null;
  } catch {
    return null;
  }
}

// MSFS Addons Linker: its settings (an .ini under C:\ProgramData\MSFS Addons Linker*) hold the Community
// folder it links add-ons into. The key names are not documented, so any setting whose value is an
// existing folder named Community (or Community2024) counts.
function fromAddonsLinker() {
  const out = [];
  const base = process.env.ProgramData || 'C:\\ProgramData';
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && /^msfs addons? linker/i.test(d.name));
  } catch {}
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(base, d.name)).filter((f) => /\.ini$/i.test(f));
    } catch {}
    for (const f of files) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(base, d.name, f), 'utf8');
      } catch {}
      for (const line of text.split(/\r?\n/)) {
        const v = /^[^=;#\[]+=\s*"?([^"]+?)"?\s*$/.exec(line)?.[1];
        if (v && /[\\/]community(2024)?[\\/]?$/i.test(v) && fs.existsSync(v) && !out.includes(path.resolve(v))) out.push(path.resolve(v));
      }
    }
  }
  return out;
}

// The Community folder sits in the sim's packages folder (InstalledPackagesPath in UserCfg.opt), which
// the user picks at install time. UserCfg.opt is in a different place for the Steam and MS Store versions.
// [folder, version] for the MS Store version first, then Steam.
function fromUserCfg() {
  const out = [];
  const cfgs = [
    [path.join(STORE_ROOT, 'LocalCache', 'UserCfg.opt'), 'MS Store'],
    [path.join(STEAM_ROOT, 'UserCfg.opt'), 'Steam'],
  ];
  for (const [f, version] of cfgs) {
    try {
      const m = /^\s*InstalledPackagesPath\s+"([^"]+)"/m.exec(fs.readFileSync(f, 'utf8'));
      if (m) out.push([path.join(m[1], 'Community'), version]);
    } catch {}
  }
  return out;
}

// Each candidate with where it came from, in order. Steam-style folders when only the MS Store version is
// installed are listed as skipped.
const named = [
  [asCommunity(given), '--community'],
  [asCommunity(process.env.MSFS_COMMUNITY), 'MSFS_COMMUNITY'],
].filter(([p]) => p);
const found_ = [
  [savedCommunity(), `saved in ${SAVED}`],
  ...fromAddonsLinker().map((p) => [p, 'MSFS Addons Linker setting']),
  ...fromUserCfg().map(([p, v]) => [p, `InstalledPackagesPath in UserCfg.opt (${v})`]),
  [path.join(STORE_ROOT, 'LocalCache', 'Packages', 'Community'), 'default location, MS Store'],
  [path.join(STEAM_ROOT, 'Packages', 'Community'), 'default location, Steam'],
].filter(([p]) => p);
const skipped = storeOnly ? found_.filter(([p]) => isSteamPath(p)) : [];
const candidates = [...named, ...found_.filter((c) => !skipped.includes(c))];
const firstOk = () => candidates.find(([p]) => probe(p) === 'ok');

// --detect: report and change nothing (the editor's Sim add-on tab, setup's folder page).
if (args.has('--detect')) {
  const found = firstOk();
  console.log(JSON.stringify({
    community: found?.[0] ?? null,
    from: found?.[1] ?? null,
    installed: !!found && fs.existsSync(path.join(found[0], PKG)),
    storeOnly,
    tried: [
      ...candidates.map(([p, from]) => ({ path: p, from, access: probe(p), exists: probe(p) !== 'missing' })),
      ...skipped.map(([p, from]) => ({ path: p, from: `${from}; skipped: only the MS Store version is installed`, access: probe(p), exists: probe(p) !== 'missing', skipped: true })),
    ],
  }));
  process.exit(0);
}

// An explicitly named folder must exist: falling back to another one would install where the user did not ask.
const givenAccess = given ? probe(candidates[0][0]) : 'ok';
if (givenAccess !== 'ok') {
  console.error(givenAccess === 'denied' ? `${DENIED}\n  ${candidates[0][0]}` : `That folder does not exist: ${candidates[0][0]}`);
  process.exit(NOT_FOUND);
}
const found = firstOk();
if (!found) {
  const denied = candidates.filter(([p]) => probe(p) === 'denied');
  console.error(
    'MSFS 2024\'s Community folder was not found. Looked in:\n' +
      candidates.map(([p, why]) => `  ${p}  (${why}${probe(p) === 'denied' ? '; exists, but CockpitCast may not open it' : ''})`).join('\n') +
      (denied.length ? `\n${DENIED}` : '') +
      '\nIf you moved your add-ons (for example with Addons Linker), choose the Community folder the sim\n' +
      'reads them from: run "Repair Community hook" from the Start menu, or pass --community <folder>.',
  );
  process.exit(NOT_FOUND);
}
const COMMUNITY = found[0];
// Remember a folder the user named (also through MSFS_COMMUNITY: an update or uninstall may run without
// that variable, e.g. from a tray started before it was set).
if ((found[1] === '--community' || found[1] === 'MSFS_COMMUNITY') && COMMUNITY !== savedCommunity()) {
  try {
    fs.mkdirSync(path.dirname(SAVED), { recursive: true });
    fs.writeFileSync(SAVED, JSON.stringify({ community: COMMUNITY }, null, 2) + '\n');
  } catch {}
}
const target = path.join(COMMUNITY, PKG);

const legacy = path.join(COMMUNITY, LEGACY_PKG);
if (fs.existsSync(legacy)) {
  fs.rmSync(legacy, { recursive: true, force: true });
  console.log(`Removed the old hook package ${legacy}`);
}

if (args.has('--remove')) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
  process.exit(0);
}

// Any other package that replaces the same sim file would fight with ours.
const REL = path.join('html_ui', 'Pages', 'VCockpit', 'Instruments', 'Shared', 'BaseInstrument.js');
const others = fs
  .readdirSync(COMMUNITY)
  .filter((name) => name !== PKG && name !== LEGACY_PKG && fs.existsSync(path.join(COMMUNITY, name, REL)));
if (others.length && !args.has('--force')) {
  console.error(
    `Other Community package(s) also replace BaseInstrument.js: ${others.join(', ')}\n` +
      'Only one can win. Move them out of the Community folder first, or re-run with --force to install anyway.',
  );
  process.exit(1);
}

const dist = path.join(HERE, 'dist', PKG);
if (!fs.existsSync(dist)) {
  console.error('Package not built yet. Run: node hook/build-hook.mjs');
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(dist, target, { recursive: true });
console.log(`Installed ${target} (Community folder: ${found[1]})\nRestart MSFS for it to take effect.`);
