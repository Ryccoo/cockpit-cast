// Sim variables streamed to clients for data-driven gauges (steam gauges). Read-only.
// One list, in this order, is sent to clients as `dataVars`; every `data` message carries the values
// in the same order. Add entries at the end; clients look values up by key, never by position.
//
// key: short name used by gauges (client/lib/gauges/...)
// name: SimConnect simulation variable; unit: SimConnect unit string

export const SIMVARS = [
  // flight instruments (gauge-driven values where the sim provides them)
  { key: 'ias', name: 'AIRSPEED INDICATED', unit: 'knots' },
  { key: 'pitch', name: 'ATTITUDE INDICATOR PITCH DEGREES', unit: 'degrees' },
  { key: 'bank', name: 'ATTITUDE INDICATOR BANK DEGREES', unit: 'degrees' },
  { key: 'alt', name: 'INDICATED ALTITUDE', unit: 'feet' },
  { key: 'baro', name: 'KOHLSMAN SETTING HG', unit: 'inHg' },
  { key: 'vs', name: 'VERTICAL SPEED', unit: 'feet per minute' },
  { key: 'hdg', name: 'HEADING INDICATOR', unit: 'degrees' },
  { key: 'hdgBug', name: 'AUTOPILOT HEADING LOCK DIR', unit: 'degrees' },
  { key: 'turnRate', name: 'TURN INDICATOR RATE', unit: 'degrees per second' },
  { key: 'ball', name: 'TURN COORDINATOR BALL', unit: 'position' },
  { key: 'suction', name: 'SUCTION PRESSURE', unit: 'inHg' },

  // engine 1
  { key: 'rpm', name: 'GENERAL ENG RPM:1', unit: 'rpm' },
  { key: 'map', name: 'ENG MANIFOLD PRESSURE:1', unit: 'inHg' },
  { key: 'oilTemp', name: 'GENERAL ENG OIL TEMPERATURE:1', unit: 'fahrenheit' },
  { key: 'oilPress', name: 'GENERAL ENG OIL PRESSURE:1', unit: 'psi' },
  { key: 'egt', name: 'GENERAL ENG EXHAUST GAS TEMPERATURE:1', unit: 'fahrenheit' },
  { key: 'fuelFlow', name: 'ENG FUEL FLOW GPH:1', unit: 'gallons per hour' },
  { key: 'fuelL', name: 'FUEL LEFT QUANTITY', unit: 'gallons' },
  { key: 'fuelR', name: 'FUEL RIGHT QUANTITY', unit: 'gallons' },

  // electrical
  { key: 'amps', name: 'ELECTRICAL BATTERY LOAD', unit: 'amperes' },
  { key: 'volts', name: 'ELECTRICAL MAIN BUS VOLTAGE', unit: 'volts' },

  // navigation
  { key: 'nav1Obs', name: 'NAV OBS:1', unit: 'degrees' },
  { key: 'nav1Cdi', name: 'NAV CDI:1', unit: 'number' },
  { key: 'nav1Gsi', name: 'NAV GSI:1', unit: 'number' },
  { key: 'nav1ToFrom', name: 'NAV TOFROM:1', unit: 'enum' },
  { key: 'nav1HasNav', name: 'NAV HAS NAV:1', unit: 'bool' },
  { key: 'nav1HasGs', name: 'NAV HAS GLIDE SLOPE:1', unit: 'bool' },
  { key: 'nav2Obs', name: 'NAV OBS:2', unit: 'degrees' },
  { key: 'nav2Cdi', name: 'NAV CDI:2', unit: 'number' },
  { key: 'nav2Gsi', name: 'NAV GSI:2', unit: 'number' },
  { key: 'nav2ToFrom', name: 'NAV TOFROM:2', unit: 'enum' },
  { key: 'nav2HasNav', name: 'NAV HAS NAV:2', unit: 'bool' },
  { key: 'nav2HasGs', name: 'NAV HAS GLIDE SLOPE:2', unit: 'bool' },
  { key: 'adfRadial', name: 'ADF RADIAL:1', unit: 'degrees' },
  { key: 'adfCard', name: 'ADF CARD', unit: 'degrees' },
  { key: 'adfSignal', name: 'ADF SIGNAL:1', unit: 'number' },

  // misc
  { key: 'flaps', name: 'FLAPS HANDLE PERCENT', unit: 'percent' },
  { key: 'trim', name: 'ELEVATOR TRIM PCT', unit: 'percent' },
  { key: 'onGround', name: 'SIM ON GROUND', unit: 'bool' },
  { key: 'localTime', name: 'LOCAL TIME', unit: 'seconds' },
  { key: 'zuluTime', name: 'ZULU TIME', unit: 'seconds' },

  // aircraft reference values (constant per aircraft): airspeed arcs and redlines come from the sim.
  // There is no SimVar for Vfe or Vno: those come from host/defaults/aircraft.json (see aircraft.mjs).
  { key: 'vs0', name: 'DESIGN SPEED VS0', unit: 'knots' },
  { key: 'vs1', name: 'DESIGN SPEED VS1', unit: 'knots' },
  { key: 'vc', name: 'DESIGN SPEED VC', unit: 'knots' },
  { key: 'vne', name: 'AIRSPEED BARBER POLE', unit: 'knots' },
  { key: 'maxRpm', name: 'MAX RATED ENGINE RPM', unit: 'rpm' },

  // electrical state for OFF flags. The un-indexed main bus voltage read 0 in the MSFS 2024 C152, so the
  // turn coordinator flag follows the battery master; bus 1 voltage is read explicitly as well.
  { key: 'battMaster', name: 'ELECTRICAL MASTER BATTERY', unit: 'bool' },
  { key: 'bus1Volts', name: 'ELECTRICAL MAIN BUS VOLTAGE:1', unit: 'volts' },
];

export const SIMVAR_KEYS = SIMVARS.map((v) => v.key);
