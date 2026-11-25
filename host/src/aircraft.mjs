// Aircraft profiles: reference speeds the sim does not expose (Vfe, Vno). See defaults/aircraft.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLog } from './log.mjs';

const log = makeLog('aircraft');
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults', 'aircraft.json');

let profiles = [];
try {
  profiles = JSON.parse(fs.readFileSync(FILE, 'utf8')).aircraft.map((p) => ({ ...p, re: new RegExp(p.match, 'i') }));
} catch (e) {
  log.warn(`cannot read ${FILE}: ${e.message}`);
}

/// Profile for an aircraft folder name, or null (the client then estimates).
export function aircraftProfile(aircraft) {
  if (!aircraft) return null;
  const p = profiles.find((x) => x.re.test(aircraft));
  return p ? { profile: p.name, vfe: p.vfe ?? null, vno: p.vno ?? null } : null;
}
