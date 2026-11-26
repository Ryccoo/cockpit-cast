// Tray icon on Windows: keeps its tooltip and colour up to date. Clicking the icon opens the layout
// editor; its menu can quit the host (emits 'quit') or install an update (emits 'update'). See
// tray/src/tray.cpp. Two ways round:
//   npm start        the host starts the tray program; it exits by itself when the host does.
//   tray launcher    (installed copies: Start menu, sign-in) the tray program started the host, with
//                    COCKPITCAST_TRAY_PARENT=1, and talks to it over the host's stdin/stdout. When the
//                    tray goes away (stdin closes), the host stops too.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { makeLog } from './log.mjs';

const log = makeLog('tray');
const MAX_RESTARTS = 5;

export class Tray extends EventEmitter {
  /// getState() -> { level: 'idle' | 'sim' | 'live', lines: [text] }
  constructor({ exe, port, getState, supportUrl = null }) {
    super();
    this.supportUrl = supportUrl;
    this.exe = exe;
    this.port = port;
    this.getState = getState;
    this.child = null;
    this.closing = false;
    this.restarts = 0;
    this.lastStatus = '';
    this.timer = null;
  }

  /// Started by the tray launcher? Then the tray is on our stdin/stdout.
  static get parented() {
    return process.env.COCKPITCAST_TRAY_PARENT === '1';
  }

  start() {
    if (process.platform !== 'win32') return;
    if (Tray.parented) return this.attachParent();
    if (!fs.existsSync(this.exe)) {
      log.info(`no tray icon: ${this.exe} not built (see README, "Build the C++ parts")`);
      return;
    }
    this.spawn();
    this.timer = setInterval(() => this.update(), 2000);
  }

  attachParent() {
    this.parent = true;
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d.toString('utf8');
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        this.onLine(line);
      }
    });
    process.stdin.on('end', () => {
      if (this.closing) return;
      log.info('tray launcher gone; stopping');
      this.emit('quit');
    });
    const base = `http://localhost:${this.port}`;
    this.write(`editor ${base}/editor`);
    this.write(`monitor ${base}/`);
    if (this.supportUrl) this.write(`support ${this.supportUrl}`);
    if (this.updateVersion) this.write(`update ${this.updateVersion}`);
    if (this.localState) this.write(`local ${this.localState}`);
    this.update();
    this.timer = setInterval(() => this.update(), 2000);
  }

  onLine(line) {
    if (line === 'quit') {
      log.info('quit from the tray menu');
      this.emit('quit');
    } else if (line === 'update') {
      log.info('update from the tray menu');
      this.emit('update');
    } else if (line === 'local-toggle') {
      this.emit('local-toggle');
    }
  }

  /// A newer version exists (menu item and a notification), or null.
  setUpdate(version) {
    if (version === this.updateVersion) return;
    this.updateVersion = version;
    if (version) this.write(`update ${version}`);
  }

  /// Local screens: 'none' (menu item hidden), 'on' or 'off' (ticked or not).
  setLocal(state) {
    if (state === this.localState) return;
    this.localState = state;
    this.write(`local ${state}`);
  }

  /// Launcher mode: the tray stops the host, runs this installer (silent update) and exits.
  install(file) {
    this.write(`install ${file}`);
  }

  spawn() {
    const child = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    this.lastStatus = '';
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        this.onLine(line);
      }
    });
    child.on('error', (e) => log.warn(`tray icon: ${e.message}`));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.closing) return;
      if (this.restarts++ >= MAX_RESTARTS) return void log.warn(`tray icon exited (${code}); not restarting`);
      log.warn(`tray icon exited (${code}); restarting`);
      setTimeout(() => !this.closing && this.spawn(), 3000);
    });
    const base = `http://localhost:${this.port}`;
    this.write(`editor ${base}/editor`);
    this.write(`monitor ${base}/`);
    if (this.supportUrl) this.write(`support ${this.supportUrl}`);
    if (this.updateVersion) this.write(`update ${this.updateVersion}`);
    if (this.localState) this.write(`local ${this.localState}`);
    this.update();
  }

  update() {
    if (!this.child && !this.parent) return;
    const { level, lines } = this.getState();
    // The tooltip holds at most 127 characters.
    const text = lines.join('\\n').replace(/[\r\n]/g, ' ').slice(0, 127);
    const status = `status ${level} ${text}`;
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.write(status);
  }

  write(line) {
    if (this.parent) process.stdout.write(`${line}\n`);
    else if (this.child?.stdin.writable) this.child.stdin.write(`${line}\n`);
  }

  close() {
    this.closing = true;
    clearInterval(this.timer);
    this.child?.stdin.end();
  }
}
