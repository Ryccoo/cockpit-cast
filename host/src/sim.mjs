// SimConnect monitor: is the sim running, is a flight loaded, is it paused, which aircraft.
// Drives DLL injection (via liveSince) and supplies gauge data: while setDataWanted(true), the
// variables in simvars.mjs are read every visual frame and emitted as 'data' (array in SIMVARS order).

import { EventEmitter } from 'node:events';
import { open, Protocol, SimConnectConstants, SimConnectDataType, SimConnectPeriod } from 'node-simconnect';
import { SIMVARS } from './simvars.mjs';
import { aircraftProfile } from './aircraft.mjs';
import { makeLog } from './log.mjs';

const log = makeLog('sim');

const EV_SIM = 1;
const EV_PAUSE = 2;
const EV_AIRCRAFT = 3;
const REQ_SIM = 10;
const REQ_AIRCRAFT = 11;
const RETRY_MS = 5000;
const DEF_GAUGES = 20;
const REQ_GAUGES = 20;
const DEF_TITLE = 21;
const REQ_TITLE = 21;

export class SimMonitor extends EventEmitter {
  constructor() {
    super();
    // aircraft: the aircraft's folder name (the key for per-aircraft settings); title: its name in the
    // sim (TITLE, e.g. "Cessna Skyhawk G1000 Asobo"), read once per aircraft, null until known.
    this.state = { connected: false, inFlight: false, paused: false, aircraft: null, title: null, liveSince: null };
    this.handle = null;
    this.stopped = false;
    this.lastError = null;
    this.dataWanted = false;
    this.dataRequested = false;
    this.defSendIds = new Map(); // SimConnect send id -> simvar, to name bad variables in exceptions
    this.dataCount = 0;
  }

  start() {
    this.connect();
  }

  async connect() {
    if (this.stopped) return;
    try {
      const { recvOpen, handle } = await open('CockpitCast', Protocol.KittyHawk);
      this.handle = handle;
      this.lastError = null;
      log.info(`connected to ${recvOpen.applicationName}`);
      this.set({ connected: true });

      handle.on('event', (e) => this.onEvent(e));
      handle.on('eventFilename', (e) => {
        if (e.clientEventId === EV_AIRCRAFT) this.setAircraft(shortAircraft(e.fileName));
      });
      handle.on('systemState', (s) => this.onSystemState(s));
      handle.on('exception', (ex) => {
        const v = this.defSendIds.get(ex.sendId);
        log.warn(`SimConnect exception ${ex.exception} (send ${ex.sendId})${v ? ` for ${v.name} [${v.unit}]` : ''}`);
      });
      handle.on('simObjectData', (d) => {
        if (d.requestID === REQ_TITLE) {
          const title = d.data.readString256().trim();
          if (title && title !== this.state.title) this.set({ title });
          return;
        }
        if (d.requestID !== REQ_GAUGES) return;
        const values = new Array(SIMVARS.length);
        for (let i = 0; i < SIMVARS.length; i++) values[i] = d.data.readFloat64();
        this.dataCount++;
        this.emit('data', values);
      });
      handle.on('quit', () => this.onDisconnect('sim quit'));
      handle.on('close', () => this.onDisconnect('connection closed'));
      handle.on('error', (err) => this.onDisconnect(`error: ${err.message}`));

      handle.subscribeToSystemEvent(EV_SIM, 'Sim');
      handle.subscribeToSystemEvent(EV_PAUSE, 'Pause');
      handle.subscribeToSystemEvent(EV_AIRCRAFT, 'AircraftLoaded');
      handle.requestSystemState(REQ_SIM, 'Sim');
      handle.requestSystemState(REQ_AIRCRAFT, 'AircraftLoaded');

      this.defSendIds.clear();
      handle.addToDataDefinition(DEF_TITLE, 'TITLE', null, SimConnectDataType.STRING256);
      for (const v of SIMVARS) {
        const id = handle.addToDataDefinition(DEF_GAUGES, v.name, v.unit, SimConnectDataType.FLOAT64);
        this.defSendIds.set(id, v);
      }
      this.dataRequested = false;
      this.updateDataRequest();
    } catch (err) {
      const msg = err?.message || err?.code || 'MSFS is not running';
      if (msg !== this.lastError) log.info(`sim not reachable (${msg}); retrying every ${RETRY_MS / 1000}s`);
      this.lastError = msg;
      setTimeout(() => this.connect(), RETRY_MS);
    }
  }

  /// Read gauge variables while true (some client is showing gauges).
  setDataWanted(wanted) {
    this.dataWanted = wanted;
    this.updateDataRequest();
  }

  updateDataRequest() {
    const want = this.dataWanted && this.state.connected;
    if (!this.handle || want === this.dataRequested) return;
    const period = want ? SimConnectPeriod.VISUAL_FRAME : SimConnectPeriod.NEVER;
    this.handle.requestDataOnSimObject(REQ_GAUGES, DEF_GAUGES, SimConnectConstants.OBJECT_ID_USER, period);
    this.dataRequested = want;
    log.info(want ? `gauge data on (${SIMVARS.length} variables per frame)` : 'gauge data off');
  }

  onEvent(e) {
    if (e.clientEventId === EV_SIM) this.setInFlight(e.data === 1);
    else if (e.clientEventId === EV_PAUSE) this.setPaused(e.data === 1);
  }

  onSystemState(s) {
    if (s.requestID === REQ_SIM) this.setInFlight(s.dataInteger === 1);
    else if (s.requestID === REQ_AIRCRAFT && s.dataString) this.setAircraft(shortAircraft(s.dataString));
  }

  setAircraft(aircraft) {
    if (aircraft !== this.state.aircraft) this.set({ aircraft, title: null });
    this.requestTitle();
  }

  // The user aircraft's TITLE, once (again when a flight starts: right after loading it may not exist yet).
  requestTitle() {
    this.handle?.requestDataOnSimObject(REQ_TITLE, DEF_TITLE, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.ONCE);
  }

  setInFlight(inFlight) {
    if (inFlight === this.state.inFlight) return;
    log.info(inFlight ? 'flight running' : 'flight stopped (menu or loading)');
    this.set({ inFlight });
    if (inFlight) {
      this.handle?.requestSystemState(REQ_AIRCRAFT, 'AircraftLoaded');
      this.requestTitle();
    }
    this.updateLive();
  }

  setPaused(paused) {
    if (paused === this.state.paused) return;
    log.info(paused ? 'paused' : 'unpaused');
    this.set({ paused });
    this.updateLive();
  }

  // liveSince: when the flight last became running and unpaused. The injector will wait on this.
  updateLive() {
    const live = this.state.inFlight && !this.state.paused;
    if (live && !this.state.liveSince) this.set({ liveSince: Date.now() });
    if (!live && this.state.liveSince) this.set({ liveSince: null });
  }

  onDisconnect(why) {
    if (!this.state.connected) return;
    log.info(`disconnected (${why})`);
    this.handle = null;
    this.dataRequested = false;
    this.set({ connected: false, inFlight: false, paused: false, liveSince: null });
    setTimeout(() => this.connect(), RETRY_MS);
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit('status');
  }

  status() {
    const { connected, inFlight, paused, aircraft, title, liveSince } = this.state;
    return {
      connected,
      inFlight,
      paused,
      aircraft,
      title,
      liveForSec: liveSince ? Math.floor((Date.now() - liveSince) / 1000) : 0,
      // Speeds the sim does not provide, from the aircraft profile (null: client estimates).
      speeds: aircraftProfile(aircraft),
    };
  }

  close() {
    this.stopped = true;
    try {
      this.handle?.close();
    } catch {}
  }
}

// "SimObjects\Airplanes\asobo_c172sp_g1000\...\aircraft.CFG" -> "asobo_c172sp_g1000"
function shortAircraft(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  const i = parts.findIndex((p) => p.toLowerCase() === 'airplanes' || p.toLowerCase() === 'rotorcraft');
  return i >= 0 && parts[i + 1] ? parts[i + 1] : parts.at(-3) ?? String(path);
}
