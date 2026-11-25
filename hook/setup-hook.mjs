// Builds and installs the Community hook in one go: what the installer runs, and the Start menu's
// "Repair Community hook" (needed after every sim update, since the hook holds a copy of a sim file).
//
//   node hook/setup-hook.mjs [--pause] [--force]
//
// --pause waits for Enter at the end (when run in its own console window). --force installs even if
// another Community package replaces the same sim file. The output also goes to
// %LOCALAPPDATA%\CockpitCast\logs\hook-setup.log. Exit code 0 when the hook is installed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const logFile = path.join(process.env.LOCALAPPDATA ?? HERE, 'CockpitCast', 'logs', 'hook-setup.log');
let text = '';
const say = (s) => {
  text += s + '\n';
  console.log(s);
};

function run(script, extra = []) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...extra], { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (out) say(out);
  return r.status === 0;
}

say('CockpitCast: setting up the Community hook for MSFS 2024\n');
const ok = run('build-hook.mjs') && run('install-hook.mjs', args.includes('--force') ? ['--force'] : []);
say(ok ? '\nDone. Restart MSFS if it is running.' : '\nThe hook is NOT installed (see above).');
try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, text);
} catch {}

if (args.includes('--pause')) {
  process.stdout.write('\nPress Enter to close this window.');
  process.stdin.once('data', () => process.exit(ok ? 0 : 1));
} else {
  process.exit(ok ? 0 : 1);
}
