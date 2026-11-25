// Copies the built hook package into the MSFS 2024 Community folder, or removes it.
//
//   node hook/install-hook.mjs            install (sim must be closed)
//   node hook/install-hook.mjs --remove   uninstall
//
// Only one package can override BaseInstrument.js at a time. If another Community package
// overrides it too, this refuses unless --force is given.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = 'zzz-cockpit-link-hook';
const COMMUNITY = process.env.MSFS_COMMUNITY || findCommunity();

// The Community folder sits in the sim's packages folder (InstalledPackagesPath in UserCfg.opt), which
// the user picks at install time. UserCfg.opt is in a different place for the Steam and MS Store versions.
function findCommunity() {
  const cfgs = [
    path.join(process.env.APPDATA ?? '', 'Microsoft Flight Simulator 2024', 'UserCfg.opt'), // Steam
    path.join(process.env.LOCALAPPDATA ?? '', 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt'), // MS Store
  ];
  for (const f of cfgs) {
    try {
      const m = /^\s*InstalledPackagesPath\s+"([^"]+)"/m.exec(fs.readFileSync(f, 'utf8'));
      if (m && fs.existsSync(path.join(m[1], 'Community'))) return path.join(m[1], 'Community');
    } catch {}
  }
  return path.join(process.env.APPDATA ?? '', 'Microsoft Flight Simulator 2024', 'Packages', 'Community');
}
const target = path.join(COMMUNITY, PKG);
const args = new Set(process.argv.slice(2));

if (!fs.existsSync(COMMUNITY)) {
  console.error(`Community folder not found: ${COMMUNITY}\nSet MSFS_COMMUNITY to its path.`);
  process.exit(1);
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
  .filter((name) => name !== PKG && fs.existsSync(path.join(COMMUNITY, name, REL)));
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
console.log(`Installed ${target}\nRestart MSFS for it to take effect.`);
