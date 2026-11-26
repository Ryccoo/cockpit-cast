// The Community folder rules of hook/install-hook.mjs: which folder it uses, that a chosen (saved)
// folder is binding, that a folder is saved only once the hook is in it, the MS Store and Addons Linker
// cases. Every test runs a copy of the script next to a fake built hook, with LOCALAPPDATA, APPDATA and
// ProgramData pointing into a scratch folder: nothing on this PC is read or changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../hook/install-hook.mjs', import.meta.url));
const PKG = 'zzz-cockpitcast-hook';
const BI = path.join('html_ui', 'Pages', 'VCockpit', 'Instruments', 'Shared', 'BaseInstrument.js');

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hook = path.join(root, 'app', 'hook');
  fs.mkdirSync(path.join(hook, 'dist', PKG, path.dirname(BI)), { recursive: true });
  fs.writeFileSync(path.join(hook, 'dist', PKG, BI), '// fake hook\n');
  fs.copyFileSync(SCRIPT, path.join(hook, 'install-hook.mjs'));
  const env = {
    ...process.env,
    LOCALAPPDATA: path.join(root, 'local'),
    APPDATA: path.join(root, 'roaming'),
    ProgramData: path.join(root, 'programdata'),
    MSFS_COMMUNITY: '',
  };
  for (const k of ['LOCALAPPDATA', 'APPDATA', 'ProgramData']) fs.mkdirSync(env[k], { recursive: true });
  const w = {
    root,
    steamCommunity: path.join(env.APPDATA, 'Microsoft Flight Simulator 2024', 'Packages', 'Community'),
    storeRoot: path.join(env.LOCALAPPDATA, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe'),
    savedFile: path.join(env.LOCALAPPDATA, 'CockpitCast', 'hook.json'),
    run: (...args) => {
      const r = spawnSync(process.execPath, [path.join(hook, 'install-hook.mjs'), ...args], { env, encoding: 'utf8' });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    },
    dir: (...p) => {
      const d = path.join(root, ...p);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
    saved: () => (fs.existsSync(w.savedFile) ? JSON.parse(fs.readFileSync(w.savedFile, 'utf8')).community : null),
    save: (dir) => {
      fs.mkdirSync(path.dirname(w.savedFile), { recursive: true });
      fs.writeFileSync(w.savedFile, JSON.stringify({ community: dir }));
    },
    installedIn: (dir) => fs.existsSync(path.join(dir, PKG, BI)),
  };
  return w;
}

test('no Community folder anywhere: exit 3, nothing saved', (t) => {
  const w = world(t);
  const r = w.run();
  assert.equal(r.code, 3, r.out);
  assert.equal(w.saved(), null);
});

test('the default Steam folder is found and used, but not saved (nobody chose it)', (t) => {
  const w = world(t);
  fs.mkdirSync(w.steamCommunity, { recursive: true });
  fs.writeFileSync(path.join(w.root, 'roaming', 'Microsoft Flight Simulator 2024', 'UserCfg.opt'), '');
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.ok(w.installedIn(w.steamCommunity));
  assert.equal(w.saved(), null);
});

test('--community: installs there and saves it', (t) => {
  const w = world(t);
  const c = w.dir('D', 'MSFS', 'Community');
  const r = w.run('--community', c);
  assert.equal(r.code, 0, r.out);
  assert.ok(w.installedIn(c));
  assert.equal(w.saved(), c);
});

test('--community of a missing folder: exit 3 and the saved folder stays', (t) => {
  const w = world(t);
  const good = w.dir('good', 'Community');
  w.save(good);
  const r = w.run('--community', path.join(w.root, 'nope', 'Community'));
  assert.equal(r.code, 3, r.out);
  assert.equal(w.saved(), good);
});

test('a saved folder that cannot be found: exit 3, no other folder is used', (t) => {
  const w = world(t);
  fs.mkdirSync(w.steamCommunity, { recursive: true }); // would be found otherwise
  const gone = path.join(w.root, 'X', 'Community');
  w.save(gone);
  const r = w.run();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /remembers cannot be found/);
  assert.ok(!w.installedIn(w.steamCommunity));
  assert.equal(w.saved(), gone);
});

test('a saved folder that exists is used', (t) => {
  const w = world(t);
  const c = w.dir('E', 'Community');
  w.save(c);
  assert.equal(w.run().code, 0);
  assert.ok(w.installedIn(c));
});

test('--save-only remembers a folder even when it cannot be checked now', (t) => {
  const w = world(t);
  const gone = path.join(w.root, 'Y', 'Community');
  const r = w.run('--community', gone, '--save-only');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(r.out.trim().split('\n').pop()), { saved: gone, access: 'missing' });
  assert.equal(w.saved(), gone);
  assert.ok(!fs.existsSync(path.join(gone, PKG)));
});

test('--detect reports the saved folder, also when it is missing', (t) => {
  const w = world(t);
  fs.mkdirSync(w.steamCommunity, { recursive: true });
  const gone = path.join(w.root, 'Z', 'Community');
  w.save(gone);
  const d = JSON.parse(w.run('--detect').out.trim().split('\n').pop());
  assert.equal(d.community, gone);
  assert.equal(d.saved, true);
  assert.equal(d.access, 'missing');
  assert.equal(d.installed, false);
});

test('MS Store only: a saved Steam folder is a leftover, the Store folder is used', (t) => {
  const w = world(t);
  const store = path.join(w.storeRoot, 'LocalCache', 'Packages', 'Community');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(w.steamCommunity, { recursive: true }); // leftover, no Steam UserCfg.opt
  w.save(w.steamCommunity);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.ok(w.installedIn(store));
  assert.ok(!w.installedIn(w.steamCommunity));
});

test('MSFS Addons Linker: the Community folder from its settings is found', (t) => {
  const w = world(t);
  const linked = w.dir('Games', 'MSFS2024', 'Community');
  const cfgDir = w.dir('programdata', 'MSFS Addons Linker');
  fs.writeFileSync(path.join(cfgDir, 'settings.ini'), `[General]\nCommunityFolder2024="${linked}"\n`);
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.ok(w.installedIn(linked));
});

test('another package replacing the same sim file: refused unless --force', (t) => {
  const w = world(t);
  const c = w.dir('F', 'Community');
  fs.mkdirSync(path.join(c, 'other-mod', path.dirname(BI)), { recursive: true });
  fs.writeFileSync(path.join(c, 'other-mod', BI), '');
  const r = w.run('--community', c);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /other-mod/);
  assert.equal(w.saved(), null); // nothing installed, nothing saved
  assert.equal(w.run('--community', c, '--force').code, 0);
  assert.ok(w.installedIn(c));
});

test('--remove takes the hook out of the saved folder', (t) => {
  const w = world(t);
  const c = w.dir('G', 'Community');
  assert.equal(w.run('--community', c).code, 0);
  assert.equal(w.run('--remove').code, 0);
  assert.ok(!fs.existsSync(path.join(c, PKG)));
});
