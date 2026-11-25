// Synthetic flight data for testing gauges without the sim (COCKPIT_LINK_FAKE_DATA=1).
// Emits 'data' at 30 Hz while wanted, with values in SIMVARS order: a C172 doing gentle climbing and
// descending turns, with engine, fuel and radio values that move a little.

import { EventEmitter } from 'node:events';
import { SIMVARS } from './simvars.mjs';
import { makeLog } from './log.mjs';

const log = makeLog('fake-data');

export class FakeData extends EventEmitter {
  constructor() {
    super();
    this.wanted = false;
    this.t0 = Date.now();
    this.hdg = 300;
    this.alt = 4500;
    this.fuelL = 24;
    this.fuelR = 23.5;
    this.lastT = 0;
  }

  setDataWanted(wanted) {
    if (wanted === this.wanted) return;
    this.wanted = wanted;
    clearInterval(this.timer);
    if (wanted) {
      this.lastT = (Date.now() - this.t0) / 1000;
      this.timer = setInterval(() => this.tick(), 1000 / 30);
    }
    log.info(wanted ? 'fake gauge data on' : 'fake gauge data off');
  }

  tick() {
    const t = (Date.now() - this.t0) / 1000;
    const dt = t - this.lastT;
    this.lastT = t;
    const bank = 22 * Math.sin(t / 15);
    const turnRate = (1091 * Math.tan((bank * Math.PI) / 180)) / 105; // deg/s at 105 kt
    this.hdg = (this.hdg + turnRate * dt + 360) % 360;
    const vs = 600 * Math.sin(t / 23);
    this.alt += (vs / 60) * dt;
    const pitch = 2.5 + vs / 250;
    this.fuelL = Math.max(0, this.fuelL - (4.2 / 3600) * dt);
    this.fuelR = Math.max(0, this.fuelR - (4.2 / 3600) * dt);
    const v = {
      ias: 105 - vs / 60 + 2 * Math.sin(t / 3),
      pitch: -pitch, // the sim reports nose-up as negative
      bank: -bank, // and right bank as negative
      alt: this.alt,
      baro: 29.92,
      vs,
      hdg: this.hdg,
      hdgBug: 330,
      turnRate,
      ball: 0.1 * Math.sin(t / 4),
      suction: 5.0 + 0.1 * Math.sin(t / 7),
      rpm: 2350 + vs / 8 + 10 * Math.sin(t / 2),
      map: 22.5,
      oilTemp: 185 + 5 * Math.sin(t / 30),
      oilPress: 62 + 2 * Math.sin(t / 9),
      egt: 1350 + 20 * Math.sin(t / 11),
      fuelFlow: 8.5 + vs / 1000,
      fuelL: this.fuelL,
      fuelR: this.fuelR,
      amps: 2 + Math.sin(t / 5),
      volts: 28.1,
      nav1Obs: 330,
      nav1Cdi: 60 * Math.sin(t / 13),
      nav1Gsi: 40 * Math.sin(t / 17),
      nav1ToFrom: 1,
      nav1HasNav: 1,
      nav1HasGs: 1,
      nav2Obs: 90,
      nav2Cdi: -30 * Math.sin(t / 19),
      nav2Gsi: 0,
      nav2ToFrom: 2,
      nav2HasNav: 1,
      nav2HasGs: 0,
      adfRadial: (40 + 20 * Math.sin(t / 21) + 360) % 360,
      adfCard: 0,
      adfSignal: 1,
      flaps: 0,
      trim: 0,
      onGround: 0,
      localTime: (Date.now() / 1000) % 86400,
      zuluTime: (Date.now() / 1000) % 86400,
      vs0: 40,
      vs1: 48,
      vc: 124,
      vne: 163,
      maxRpm: 2700,
      battMaster: 1,
      bus1Volts: 28.1,
    };
    this.emit('data', SIMVARS.map((s) => v[s.key] ?? 0));
  }

  close() {
    clearInterval(this.timer);
  }
}
