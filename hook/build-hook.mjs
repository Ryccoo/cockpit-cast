// Builds the Community package: stock BaseInstrument.js + our hook appended, plus manifest and layout.
//
//   node hook/build-hook.mjs [--stock <path to stock BaseInstrument.js>]
//
// Without --stock it looks for the sim: every Steam library (any drive), then the MS Store / Xbox app
// install. MSFS_STOCK_BASEINSTRUMENT may also name the file.
//
// Output: hook/dist/zzz-cockpit-link-hook/  (copy into the Community folder with install-hook.mjs)
// Re-run after every sim update: the stock file changes with the sim.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = 'zzz-cockpit-link-hook';
const REL = 'html_ui/Pages/VCockpit/Instruments/Shared/BaseInstrument.js';
const IN_PACKAGES = path.join('asobo-vcockpits-instruments', ...REL.split('/'));

// Where MSFS 2024 keeps its own packages (the stock file is in asobo-vcockpits-instruments).
function simPackageFolders() {
  const out = [];
  // Steam: the library folders listed in libraryfolders.vdf (games can be on any drive).
  const steamRoots = new Set(['C:\\Program Files (x86)\\Steam']);
  try {
    const reg = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(reg);
    if (m) steamRoots.add(path.normalize(m[1].trim()));
  } catch {}
  for (const root of steamRoots) {
    const libs = new Set([root]);
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replaceAll('\\\\', '\\'));
    } catch {}
    for (const lib of libs) out.push(path.join(lib, 'steamapps', 'common', 'MSFS2024', 'Packages'));
  }
  // MS Store / Xbox app: installed under <drive>:\XboxGames by default.
  for (const drive of 'CDEFGHIJ') {
    out.push(path.join(`${drive}:\\`, 'XboxGames', 'Microsoft Flight Simulator 2024', 'Content', 'Packages'));
    out.push(path.join(`${drive}:\\`, 'XboxGames', 'Microsoft Flight Simulator 2024', 'Content'));
  }
  return out;
}

function findStock() {
  for (const dir of simPackageFolders()) {
    const p = path.join(dir, IN_PACKAGES);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const argi = process.argv.indexOf('--stock');
const stockPath = argi > 0 ? process.argv[argi + 1] : process.env.MSFS_STOCK_BASEINSTRUMENT || findStock();
if (!stockPath || !fs.existsSync(stockPath)) {
  console.error(
    `MSFS 2024's BaseInstrument.js was not found${stockPath ? ` at:\n  ${stockPath}` : ' (looked in the Steam libraries and XboxGames folders)'}.\n` +
      `Pass its location with --stock <file>. It is in the sim's Packages folder under ${IN_PACKAGES}.`,
  );
  process.exit(1);
}

const stock = fs.readFileSync(stockPath, 'utf8');
if (stock.includes('Cockpit Link hook')) {
  console.error('That file already contains the Cockpit Link hook; point --stock at the original sim file.');
  process.exit(1);
}
// Fill the hook's display table and host port from the shared config.
const { displays } = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config', 'displays.json'), 'utf8'));
const table = {};
for (const d of displays) for (const tag of d.tags) table[tag.toLowerCase()] = { id: d.id, px: d.marker };
const port = Number(process.env.COCKPIT_LINK_PORT) || 8800;
const version = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'host', 'package.json'), 'utf8')).version;
let hook = fs.readFileSync(path.join(HERE, 'src', 'cockpit-link-hook.js'), 'utf8');
for (const [mark, value] of [
  ['/*__DISPLAYS__*/ {}', JSON.stringify(table)],
  ['/*__PORT__*/ 8800', String(port)],
  ["/*__VERSION__*/ 'dev'", JSON.stringify(version)],
]) {
  if (!hook.includes(mark)) throw new Error(`hook source is missing placeholder ${mark}`);
  hook = hook.replace(mark, value);
}
const header =
  '// Cockpit Link: stock MSFS BaseInstrument.js with the Cockpit Link hook appended at the end.\n' +
  `// Built ${new Date().toISOString()} from ${stockPath}\n\n`;
const out = header + stock.replace(/\s*$/, '\n') + hook;

const dist = path.join(HERE, 'dist', PKG);
fs.rmSync(dist, { recursive: true, force: true });
const target = path.join(dist, ...REL.split('/'));
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);

const manifest = {
  dependencies: [],
  content_type: 'UNKNOWN',
  title: 'Cockpit Link Hook',
  manufacturer: 'Cockpit Link',
  creator: 'Cockpit Link',
  package_version: '0.1.0',
  minimum_game_version: '1.39.12',
  release_notes: { neutral: { LastUpdate: '', OlderHistory: '' } },
  export_type: 'Community',
  package_order_hint: 'PANEL_PATCH',
  globally_overriden_base_sim_files: ['\\html_ui\\pages\\VCockpit\\Instruments\\Shared\\BaseInstrument.js'],
};
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// layout.json date is a Windows FILETIME: 100 ns ticks since 1601-01-01.
const stat = fs.statSync(target);
const filetime = (BigInt(Math.round(stat.mtimeMs)) + 11644473600000n) * 10000n;
const layout = `{\n  "content": [\n    {\n      "path": "${REL}",\n      "size": ${stat.size},\n      "date": ${filetime}\n    }\n  ]\n}\n`;
fs.writeFileSync(path.join(dist, 'layout.json'), layout);

console.log(`Built ${dist}`);
console.log(`  BaseInstrument.js: ${stat.size} bytes (stock ${Buffer.byteLength(stock)} + hook)`);
console.log(`  displays: ${Object.entries(table).map(([t, d]) => `${t} -> ${d.id}`).join(', ')}; host port ${port}`);
