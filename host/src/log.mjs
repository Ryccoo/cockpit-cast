// Timestamped logger: console, plus a log file once logToFile() is called.

import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const MAX_LOG_BYTES = 10 * 1024 * 1024;
let file = null;
let toConsole = true;

/// Started by the tray launcher: stdout is its message channel, so log to the file only.
export function logToConsole(on) {
  toConsole = on;
}

function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/// Also write every log line to `logPath`. The previous run's log is kept as `<name>.1.log`.
export function logToFile(logPath) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (fs.existsSync(logPath)) fs.renameSync(logPath, logPath.replace(/\.log$/, '') + '.1.log');
    file = { fd: fs.openSync(logPath, 'a'), bytes: 0 };
    write(`${new Date().toISOString()} log started`);
  } catch (e) {
    console.error(`cannot open log file ${logPath}: ${e.message}`);
  }
}

function write(line) {
  if (!file || file.bytes > MAX_LOG_BYTES) return;
  try {
    const buf = Buffer.from(line + '\n');
    fs.writeSync(file.fd, buf);
    file.bytes += buf.length;
    if (file.bytes > MAX_LOG_BYTES) fs.writeSync(file.fd, 'log size limit reached; further lines go to the console only\n');
  } catch {}
}

export function makeLog(tag) {
  const out = (lvl, con, args) => {
    const line = `${stamp()} ${lvl} [${tag}] ${format(...args)}`;
    if (toConsole) con(line);
    write(line);
  };
  return {
    info: (...a) => out('INFO', console.log, a),
    warn: (...a) => out('WARN', console.warn, a),
    error: (...a) => out('ERR ', console.error, a),
  };
}
