# Cockpit Link protocols

Three links, all on the sim PC except the client link:

1. **Capture link** (version 2): capture.dll (or `host/tools/fake-capture.mjs`) and the host, two-way, named pipe.
2. **Client link** (version 1): host to client apps over the LAN, WebSocket.
3. **Hook link**: the Community hook in the sim's instrument pages to the host, WebSocket on localhost.

All integers are little-endian.

## 1. Capture link: named pipe (version 2)

- Pipe: `\\.\pipe\cockpit-link-capture`. The host is the server; the capture source connects as a client.
- Stream of messages in both directions, each one:

```
u32  length   bytes that follow this field (type + payload)
u8   type
...  payload
```

Capture source to host:

| type | name      | payload |
|------|-----------|---------|
| 1    | HELLO     | UTF-8 JSON: `{"source":"capture.dll","version":"0.1.0","pid":42164,"protocol":2}`. First message after connecting. |
| 2    | FRAME     | `u8 idLen`, `id` (ASCII), `u16 width`, `u16 height`, `u32 seq`, then JPEG bytes to the end |
| 3    | LOG       | UTF-8 text, one line; the host writes it to its own log |
| 4    | STATS     | UTF-8 JSON, free-form diagnostics (tracked textures, matches, encode times...). Shown in `/api/status`. About every 2 s. |
| 5    | UNCHANGED | `u8 idLen`, `id`, `u32 seq`: the display was re-checked and the picture is identical to the last FRAME. Keeps the display live without resending it. |

Host to capture source:

| type | name      | payload |
|------|-----------|---------|
| 16   | CONFIG    | UTF-8 JSON, below. Sent as soon as the source connects, and again whenever anything in it changes. |
| 17   | HEARTBEAT | empty. Every second. |
| 18   | SHUTDOWN  | empty. Stop capturing, release GPU resources, disconnect, and do not reconnect. |

CONFIG:

```json
{
  "version": 2,
  "jpegQuality": 80,
  "heartbeatTimeoutMs": 10000,
  "displays": [
    {
      "id": "pfd",
      "marker": [[201, 13, 77], [17, 190, 233]],
      "read": { "x": 0, "y": 0 },
      "crop": { "w": 1024, "h": 768 },
      "texture": { "w": 1024, "h": 768 },
      "enabled": true,
      "maxFps": 30
    }
  ]
}
```

- `marker`: the two RGB pixels the hook paints at `read` (pixel 0 at x, pixel 1 at x+1).
- `read`, `crop`, `texture`: from the hook's layout report, in texture pixels. `crop` null means use the whole texture from `read`. `texture` null means the size is not known yet.
- `enabled`: some client is watching this display. Disabled displays are not copied or encoded (identifying textures may continue, at low cost).
- `maxFps`: capture no faster than this for this display.

Rules for a capture source (capture.dll):

- Capture nothing until the first CONFIG arrives.
- Send only new frames. Drop frames when the pipe is busy; never block the sim's render thread on the pipe.
- Paint over the two marker pixels before encoding, so clients never see them.
- Skip a frame whose picture is identical to the previous one (checksum) and send UNCHANGED instead, at least once a second, so the host keeps the display live.
- If no HEARTBEAT arrives for `heartbeatTimeoutMs`, stop capturing (hooks pass straight through) until heartbeats return.
- When the pipe breaks (host restarted), keep the hooks in pass-through and try to reconnect every 2 s. The host never injects a second copy into a process that already has the DLL loaded.
- Maximum message length: 8 MiB. Larger messages close the connection.

## 2. Client link: WebSocket (version 1)

- The host advertises itself with mDNS/DNS-SD: service type `_cockpit-link._tcp`, TXT `protocol=1`, `name=<host name>`.
- Default port 8800.
- Endpoint: `ws://<host>:8800/ws`.

### Text messages (JSON)

Client to host:

```json
{ "type": "hello", "client": "Cockpit Pi left", "protocol": 1 }
{ "type": "subscribe", "display": "pfd", "maxFps": 30 }
{ "type": "unsubscribe", "display": "pfd" }
```

Host to client:

```json
{ "type": "welcome", "protocol": 1, "host": "SIM-PC", "version": "0.1.0" }
{ "type": "displays", "displays": [ { "id": "pfd", "name": "PFD", "width": 1024, "height": 768, "live": true, "fps": 24.8 } ] }
{ "type": "status",
  "sim": { "connected": true, "inFlight": true, "paused": false, "aircraft": "...", "liveForSec": 42 },
  "capture": { "connected": true, "source": "capture.dll", "pid": 42164, "injector": "connected" },
  "hook": { "connected": true, "pages": 2, "displays": ["mfd", "pfd"] } }
{ "type": "error", "message": "unknown display 'xyz'" }
```

- `displays` lists every display in `config/displays.json` from the start (width 0 and not live until frames arrive), plus any other id a capture source sends. It is sent on connect and whenever the set, sizes or `live` flags change. A display is live when a frame or UNCHANGED arrived in the last 2 s.
- `status` is sent on connect and whenever it changes. `capture.injector` is the host's injection state: `waiting-sim`, `waiting-simconnect`, `waiting-flight`, `stabilizing`, `injecting`, `loaded`, `connected`, `failed`, `manual`, `no-dll`, `no-injector`, `error`.
- `maxFps` is 0.2-60 (0.2: one picture every 5 s, for previews); the host never sends a display faster than that to that client. Default 30. Subscriptions also drive capture: a display nobody subscribes to is not captured.

### Gauge data, layouts and screens (steam gauges; same connection)

Client to host:

```json
{ "type": "subscribeData", "maxHz": 60 }
{ "type": "unsubscribeData" }
{ "type": "saveLayout", "layout": { "id": "six-pack", "name": "Six-pack", "width": 1200, "height": 800, "gauges": [ { "id": "asi", "type": "asi", "x": 0, "y": 0, "w": 400, "h": 400, "options": {} } ] } }
{ "type": "deleteLayout", "id": "my-layout" }
// A layout item of type "glass" shows a captured display (or part of it) among the gauges:
// { "id": "glass1", "type": "glass", "x": 0, "y": 0, "w": 400, "h": 120,
//   "options": { "display": "pfd", "crop": { "x": 0.05, "y": 0, "w": 0.5, "h": 0.2 }, "fit": "contain" } }
// crop is a fraction of the picture (omitted = all of it); fit is contain | cover | fill. Clients subscribe
// to frames of the displays their layout uses. "subscribe" accepts maxFps down to 0.2 (editor previews, one picture every 5 s).
{ "type": "resetLayouts" }
{ "type": "subscribeCatalog" }   // the editor: every display seen, by aircraft (sent now and on change)
{ "type": "unsubscribeCatalog" } // the editor tab is hidden: no catalog, no picture grabs
{ "type": "setScreens", "screens": [ { "id": "1", "name": "Screen 1", "glass": "pfd", "steam": "six-pack" } ],
  "aircraft": { "asobo_tbm930": { "2": { "kind": "layout", "id": "tbm-panel" } } } }   // aircraft: optional, left out = keep
```

Host to client:

```json
{ "type": "dataVars", "vars": ["ias", "pitch", "bank", "alt", "..."] }
{ "type": "data", "t": 1764000000000, "v": [105.2, -2.5, 0.0, 4512.0] }
{ "type": "layouts", "layouts": [ { "id": "six-pack", "name": "Six-pack", "width": 1200, "height": 800, "gauges": [] } ] }
{ "type": "screens", "screens": [ { "id": "1", "name": "Screen 1", "mode": "glass", "show": { "kind": "display", "id": "pfd" } },
                                  { "id": "2", "name": "Screen 2", "mode": "steam", "show": { "kind": "layout", "id": "engine-radios" }, "custom": false } ],
  "aircraft": "asobo_c152", "perAircraft": { "asobo_tbm930": { "2": { "kind": "layout", "id": "tbm-panel" } } },
  "knownAircraft": ["asobo_c152", "asobo_tbm930"] }
{ "type": "layoutSaved", "id": "six-pack" }
{ "type": "catalog", "simRunning": true, "aircraft": "asobo_sr22_g3x", "present": ["g3x-pfd-1", "gtn750"],
  "aircraftList": [ { "name": "asobo_sr22_g3x", "lastSeen": "2026-11-25T13:20:30Z", "displays": ["g3x-pfd-1", "gtn750"] },
                    { "name": "carenado_pa34", "lastSeen": "2026-11-10T11:00:00Z", "displays": ["gtn750"] } ],
  "displays": { "gtn750": { "name": "GTN750", "primary": false, "size": "800x600", "builtIn": false,
                            "thumbAt": 1764076830175, "aircraft": ["asobo_sr22_g3x", "carenado_pa34"] } } }
```

- `catalog` (only after `subscribeCatalog`): `aircraft` is the loaded aircraft while the sim runs, else null; `present` the displays in its cockpit; `aircraftList` every aircraft seen with its displays, most recently flown first (from the instrument log and the learned displays). `thumbAt` is when the saved picture was taken (null: none yet); fetch it from `/thumb/<id>.jpg`.

- `dataVars` comes once after `subscribeData`; every `data` message has the values in that order (keys and
  SimConnect names: `host/src/simvars.mjs`). Read-only. The host reads SimConnect every visual frame only
  while some client is subscribed, and sends each client at most `maxHz` (default 30, up to 60).
- `layouts` is sent on connect and after any change (stored in `%LOCALAPPDATA%\CockpitLink\layouts.json`;
  defaults in `host/defaults/layouts.json`). Gauge types: `asi`, `attitude`, `altimeter`, `turn`,
  `heading`, `vsi`, `dial` (generic: `var`, `min`, `max`, `arcs`...), `cdi` (`nav` 1/2), `adf`, `clock`.
- `screens` is sent on connect and whenever it changes. The host decides per screen (`host/src/screens.mjs`):
  `glass` as soon as the hook reports a primary display (PFD, MFD, EICAS...; even before it is laid out), `steam`
  once the hook has reported the cockpit's instruments, none of them glass, and the list has been stable for
  10 s (or, if the hook reports nothing, after `steamAfterSec`, 30 s). After an aircraft change, and before
  the first decision, the mode is `waiting`. `show.kind` is
  `display` (subscribe to that display), `layout` (subscribe to data, draw that layout) or `waiting`.
  Per-aircraft choices (`perAircraft`, by aircraft folder name): while that aircraft is loaded, a screen
  with a choice shows it (`custom: true`) whatever the mode, and its glass display is not given to another
  screen. Clients read only `screens`; `aircraft`, `perAircraft` and `knownAircraft` are for the editor.

### Binary messages (frames)

```
4 bytes  magic "CLF1"
u32      seq          frame counter from the capture source
f64      hostTimeMs   host clock (ms since Unix epoch) when the frame arrived
u16      width
u16      height
u8       idLen
...      id (ASCII)
...      JPEG bytes to the end
```

- Flow control: the host keeps only the latest frame per display. If a client's socket is backed up, older frames are skipped, never queued, so a slow client gets fewer frames rather than growing lag.

## 3. Hook link: WebSocket on localhost

- Endpoint: `ws://127.0.0.1:8800/hook`. Connections from other machines are refused.
- Every instrument page connects (pages with no instruments do nothing), retrying every 5-60 s if the host is not running. Without the host the hook paints markers from its built-in table only.
- **Instrument key:** the element tag, plus `#<n>` when the instrument's `url` has `Index=<n>` (e.g. `wt21-pfd#2`). Table entries may use either form; the exact key wins.

Host to hook (on connect, and whenever the display registry changes):

```json
{ "type": "displays", "table": { "wtg1000-pfd": { "id": "pfd", "px": [[201,13,77],[17,190,233]] },
                                 "wt21-pfd#2": { "id": "wt21-pfd-2", "px": [[53,86,201],[37,201,118]] } } }
```

Hook to host:

```json
{ "type": "hello", "page": "wtg1000-pfd#1 /Pages/VCockpit/...", "version": "0.1.0" }
{ "type": "instruments", "page": "/Pages/VCockpit/Core/VCockpit.html", "texture": { "w": 1024, "h": 768 },
  "instruments": [ { "key": "wtg1000-pfd#1", "tag": "wtg1000-pfd",
                     "url": "/Pages/VCockpit/Instruments/NavSystems/WTG1000/PFD/WTG1000_PFD.html?Index=1",
                     "templateID": null, "identifier": null, "w": 1024, "h": 768 } ] }
{ "type": "layout", "displays": [
  { "id": "pfd", "tag": "wtg1000-pfd#1",
    "read": { "x": 0, "y": 0 }, "crop": { "w": 1024, "h": 768 }, "texture": { "w": 1024, "h": 768 } } ] }
```

- `instruments` is sent after connecting and when the list changes (rescanned every 10 s). Instruments are elements with a `url` under `/pages/vcockpit/instruments/`, or `BaseInstrument` objects in the first two levels under `<vcockpit-panel>`. `w`/`h` are texture pixels. The host learns all of them (at least 32x16) as displays (`host/src/displayRegistry.mjs`) and logs all of them per aircraft (`host/src/instruments.mjs`).
- `layout` lists every display on the page that is in the table. It is sent after connecting and whenever it changes; a display missing from it is gone from that page. All values are texture pixels: page CSS pixels times `devicePixelRatio`. `read` is the display's visible top-left corner, where the hook paints the marker; `crop` is the visible size; `texture` is the page size.
- The host merges the latest layout per display into CONFIG. CONFIG holds only displays in the loaded cockpit or watched by a client, at most 16. When all 16 entries in capture.dll are taken, it reuses an idle entry that is no longer in CONFIG.

## Tray icon: host and cockpit-link-tray.exe (Windows)

The host starts `tray/build/Release/cockpit-link-tray.exe` and talks to it over the program's stdin and
stdout, one UTF-8 line per message. When the host exits, stdin closes and the tray program exits too.

- Host to tray: `editor <url>`, `monitor <url>` (what the click and the menu open), and
  `status <idle|sim|live> <tooltip>` (lines separated by a literal `\n`; at most 127 characters). Sent when
  it changes, checked every 2 s.
- Tray to host: `quit` (menu *Quit Cockpit Link host*); the host shuts down.

## HTTP

- `GET /api/instruments`: instruments in the loaded cockpit (largest first, with `capturedAs`) and everything seen per aircraft.
- `GET /api/displays`: all displays (built-in and learned) and those present in the loaded cockpit.
- `POST /api/displays` (sim PC only): `{ "key": "<instrument key>" }` adds an instrument as a display; `{ "id", "name"?, "primary"? }` changes a learned one; `{ "id", "forget": true }` removes it.
- `GET /thumb/<id>.jpg`: the last picture saved of a display (any client; 404 if none). The host saves one at most once a minute while a display is captured, and, only while an editor is open, grabs one by itself (1 fps for a few seconds) for displays in the loaded cockpit that nobody watches, when theirs is missing or older than 10 minutes. With no editor open, nothing is captured beyond what clients watch.
- `GET /api/status`: JSON with host info, sim, capture, hook and injector state, capture sources with their STATS, layouts, the current CONFIG, displays and connected clients.
- `POST /api/inject` (localhost only): inject capture.dll now, skipping the wait for a live flight.
- `POST /api/capture/shutdown` (localhost only): send SHUTDOWN to every capture source.
- `GET /`: debug monitor page (for testing only; real clients are apps).
