// SPIKE (branch spike-h-events, not for release): can the hook press G1000 buttons?
// Sends cockpit H-events through a host started with COCKPITCAST_SPIKE=1, one per Enter, and prints what
// each instrument page reported (which instruments got the event, which threw).
//
//   node host/tools/spike-h-events.mjs [--port 8800]
//
// At the prompt: Enter sends the next planned step, or type any event name (e.g. AS1000_PFD_SOFTKEYS_3)
// to send that one; "list" shows the plan, "q" quits.

import readline from 'node:readline/promises';

const pi = process.argv.indexOf('--port');
const base = `http://127.0.0.1:${pi > 0 ? Number(process.argv[pi + 1]) : 8800}`;

const PLAN = [
  ['AS1000_MFD_FMS_Lower_INC', 'MFD: the page group changes (big FMS knob, one click right)'],
  ['AS1000_MFD_FMS_Lower_DEC', 'MFD: back to the page group before'],
  ['AS1000_MFD_SOFTKEYS_12', 'MFD: the right-most softkey acts (label lights up or a menu opens)'],
  ['AS1000_PFD_SOFTKEYS_2', 'PFD: second softkey acts (its submenu opens or an option toggles)'],
  ['AS1000_PFD_SOFTKEYS_11', 'PFD: eleventh softkey acts'],
  ['AS1000_PFD_SOFTKEYS_12', 'PFD: right-most softkey acts'],
  ['AS1000_PFD_FMS_Upper_INC', 'PFD: small FMS knob, one click right (a page or the cursor appears)'],
  ['AS1000_PFD_CLR', 'PFD: CLR closes what the last step opened'],
  ['AS1000_PFD_BARO_INC', 'PFD: the altimeter setting goes up one step'],
  ['AS1000_PFD_BARO_DEC', 'PFD: and back down'],
];

async function api(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 404) throw new Error('the spike API is off: start the host from this branch with COCKPITCAST_SPIKE=1');
  const out = await res.json();
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out;
}

async function send(name, expect) {
  const before = (await api('GET', '/api/spike/h-events')).results.length;
  const { pages } = await api('POST', '/api/spike/h-event', { name });
  console.log(`\n> ${name}  (sent to ${pages} instrument page${pages === 1 ? '' : 's'})`);
  if (expect) console.log(`  watch: ${expect}`);
  await new Promise((r) => setTimeout(r, 600));
  const fresh = (await api('GET', '/api/spike/h-events')).results.slice(before).filter((r) => r.name === name);
  for (const r of fresh) {
    if (!r.called.length && !r.failed.length) continue; // pages without instruments that take events
    console.log(`  ${r.page}: called ${r.called.join(', ') || 'none'}${r.failed.length ? `\n    FAILED ${r.failed.join('\n    FAILED ')}` : ''}`);
  }
  if (!fresh.some((r) => r.called.length || r.failed.length)) console.log('  no page handed it to an instrument');
}

try {
  await api('GET', '/api/spike/h-events');
} catch (e) {
  console.error(e.message.includes('fetch failed') ? `no host at ${base}` : e.message);
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const list = () => PLAN.forEach(([n, w], i) => console.log(`  ${i + 1}. ${n}: ${w}`));
console.log('Plan (Enter = next step, or type an event name; "list", "q"):');
list();
let step = 0;
for (;;) {
  const line = (await rl.question(`\n[${step < PLAN.length ? `next: ${step + 1}. ${PLAN[step][0]}` : 'plan done'}] > `)).trim();
  if (line === 'q') break;
  if (line === 'list') { list(); continue; }
  try {
    if (line) await send(line);
    else if (step < PLAN.length) { await send(...PLAN[step]); step++; }
  } catch (e) {
    console.log(`  error: ${e.message}`);
  }
}
rl.close();
