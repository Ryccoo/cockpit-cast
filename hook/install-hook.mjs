// Copies the built hook package into the MSFS 2024 Community folder, or removes it.
//
//   node hook/install-hook.mjs [--community <folder>] [--force]   install (sim must be closed)
//   node hook/install-hook.mjs --remove                            uninstall
//
// The Community folder, first match wins: --community, the MSFS_COMMUNITY environment variable, the
// folder chosen last time (saved in %LOCALAPPDATA%\CockpitCast\hook.json, so repairs after sim updates
// find it again), the sim's packages folder from UserCfg.opt, the default location. A folder found
// through --community or MSFS_COMMUNITY is saved. Exit code 3: no Community folder found (the installer
// then asks for it). Nothing is changed when it exits with an error: an installed hook stays.
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

function savedCommunity() {
  try {
    return JSON.parse(fs.readFileSync(SAVED, 'utf8')).community || null;
  } catch {
    return null;
  }
}

// The Community folder sits in the sim's packages folder (InstalledPackagesPath in UserCfg.opt), which
// the user picks at install time. UserCfg.opt is in a different place for the Steam and MS Store versions.
function fromUserCfg() {
  const out = [];
  const cfgs = [
    path.join(process.env.APPDATA ?? '', 'Microsoft Flight Simulator 2024', 'UserCfg.opt'), // Steam
    path.join(process.env.LOCALAPPDATA ?? '', 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt'), // MS Store
  ];
  for (const f of cfgs) {
    try {
      const m = /^\s*InstalledPackagesPath\s+"([^"]+)"/m.exec(fs.readFileSync(f, 'utf8'));
      if (m) out.push(path.join(m[1], 'Community'));
    } catch {}
  }
  return out;
}

// Each candidate with where it came from, in order.
const candidates = [
  [asCommunity(given), '--community'],
  [asCommunity(process.env.MSFS_COMMUNITY), 'MSFS_COMMUNITY'],
  [savedCommunity(), `saved in ${SAVED}`],
  ...fromUserCfg().map((p) => [p, 'InstalledPackagesPath in UserCfg.opt']),
  [path.join(process.env.APPDATA ?? '', 'Microsoft Flight Simulator 2024', 'Packages', 'Community'), 'default location, Steam'],
  [path.join(process.env.LOCALAPPDATA ?? '', 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'Packages', 'Community'), 'default location, MS Store'],
].filter(([p]) => p);

// An explicitly named folder must exist: falling back to another one would install where the user did not ask.
if (given && !fs.existsSync(candidates[0][0])) {
  console.error(`That folder does not exist: ${candidates[0][0]}`);
  process.exit(NOT_FOUND);
}
const found = candidates.find(([p]) => fs.existsSync(p));
if (!found) {
  console.error(
    'MSFS 2024\'s Community folder was not found. Looked in:\n' +
      candidates.map(([p, why]) => `  ${p}  (${why})`).join('\n') +
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
