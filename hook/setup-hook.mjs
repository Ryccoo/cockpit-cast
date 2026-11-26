// Builds and installs the Community hook in one go: what the installer runs, and the Start menu's
// "Repair Community hook" (needed after every sim update, since the hook holds a copy of a sim file).
//
//   node hook/setup-hook.mjs [--pause] [--force] [--community <folder>]
//
// --pause: run in its own console window (the Start menu entry). It waits for Enter at the end, and if
// the Community folder is not found it asks for it. --force installs even if another Community package
// replaces the same sim file. --community names the Community folder (install-hook.mjs remembers it).
// The output also goes to %LOCALAPPDATA%\CockpitCast\logs\hook-setup.log.
// Exit code: 0 the hook is installed, 3 no Community folder found, 1 any other failure.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOT_FOUND = 3;
const args = process.argv.slice(2);
const interactive = args.includes('--pause');
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
  return r.status ?? 1;
}

// Console answers, read as lines (an iterator keeps lines typed ahead; '' at the end of input).
const lines = interactive ? createInterface({ input: process.stdin })[Symbol.asyncIterator]() : null;
async function ask(prompt) {
  process.stdout.write(prompt);
  const { value, done } = await lines.next();
  return done ? '' : value.trim();
}
const installArgs = [];
if (args.includes('--force')) installArgs.push('--force');
const ci = args.indexOf('--community');
if (ci >= 0 && args[ci + 1]) installArgs.push('--community', args[ci + 1]);

say('CockpitCast: setting up the Community hook for MSFS 2024\n');
let code = run('build-hook.mjs');
if (code === 0) code = run('install-hook.mjs', installArgs);
// Started from the Start menu: ask where the Community folder is, until it works or the user gives up.
const keep = installArgs.includes('--force') ? ['--force'] : [];
while (code === NOT_FOUND && lines) {
  const answer = await ask('\nPaste the full path of the Community folder (Enter to cancel): ');
  if (!answer) break;
  text += `> ${answer}\n`;
  code = run('install-hook.mjs', [...keep, '--community', answer]);
}
say(code === 0 ? '\nDone. Restart MSFS if it is running.' : '\nThe hook is NOT installed (see above).');
try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, text);
} catch {}

if (lines) await ask('\nPress Enter to close this window.');
process.exit(code === 0 ? 0 : code === NOT_FOUND ? NOT_FOUND : 1);
