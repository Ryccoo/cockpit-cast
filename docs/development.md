# Development and testing

Everything here can run without the sim. See
`docs/protocol.md` for the three links (capture pipe, client WebSocket, hook WebSocket).

## Test tools

| Tool | What it does |
|---|---|
| `host/tools/fake-capture.mjs` (`npm run fake-capture`) | Behaves like capture.dll: connects to the host's pipe and sends moving PFD/MFD test cards (only while a client watches). `--static` sends a still picture |
| `host/tools/test-client.mjs` | Command-line client: `node tools/test-client.mjs --seconds 5` prints frame rates per display |
| `injector/build/Release/fake-sim.exe` | A process to inject into, plus a test DLL (`injector/build/test/Release/cockpit-link-capture.dll`) that connects to the host and logs the CONFIG it receives |
| `capture/build/Release/panel-sim.exe` | D3D12 stand-in for the sim: renders fake PFD/MFD panels with marker pixels, plus decoys. The real capture.dll can be injected into it |
| `client/tool/discover.dart` | `dart run tool/discover.dart`: lists the hosts found on the network |

Host environment switches for testing:

| Variable | Effect |
|---|---|
| `COCKPIT_LINK_FAKE_DATA=1` | Synthetic flight data for the steam gauges (no sim needed) |
| `COCKPIT_LINK_SCREEN_MODE=steam` / `glass` | Force the screen mode instead of detecting it |
| `COCKPIT_LINK_SIM_EXE=<exe name>` | Which process the injector waits for (e.g. `panel-sim.exe`) |
| `COCKPIT_LINK_REQUIRE_FLIGHT=0` | Inject without waiting for a live flight |
| `COCKPIT_LINK_DLL=<path>` | DLL to inject |
| `COCKPIT_LINK_AUTO_INJECT=0` | Do not inject by itself (manual: `curl -X POST http://localhost:8800/api/inject`) |
| `COCKPIT_LINK_TRAY=0` | No tray icon |
| `COCKPIT_LINK_PORT=<port>` | Host port (default 8800; rebuild the hook if you change it) |

## Recipes

Installers (needs Inno Setup 6 as well as the build tools; output in `installer\output\`):

```
powershell -ExecutionPolicy Bypass -File installer\build.ps1            # everything
powershell -ExecutionPolicy Bypass -File installer\build.ps1 -SkipBuild # reuse the existing builds
```

The tray program as launcher, like an installed copy (starts the host with no console window; quit
from its menu): run `tray\build\Release\cockpit-link-tray.exe` directly instead of `npm start`.

Pipeline without the sim (fake frames):

```
cd host
npm start
npm run fake-capture          # second terminal
```

Injection without the sim:

```
injector\build\Release\fake-sim.exe
set COCKPIT_LINK_SIM_EXE=fake-sim.exe
set COCKPIT_LINK_REQUIRE_FLIGHT=0
set COCKPIT_LINK_DLL=..\injector\build\test\Release\cockpit-link-capture.dll
cd host && npm start
```

Real capture.dll without the sim:

```
capture\build\Release\panel-sim.exe
set COCKPIT_LINK_SIM_EXE=panel-sim.exe
set COCKPIT_LINK_REQUIRE_FLIGHT=0
cd host && npm start          # injects capture.dll into panel-sim; watch pfd/mfd in a client
```

Steam gauges without the sim:

```
set COCKPIT_LINK_FAKE_DATA=1
set COCKPIT_LINK_SCREEN_MODE=steam
cd host && npm start
```

## Keeping things in sync

- `host/public/gauges.js` (editor) is a port of `client/lib/gauges/instruments.dart` (client). Change both.
- `config/displays.json` (built-in displays) feeds both the hook build and the host. Learned displays
  need no rebuild: the host sends the hook its table at runtime.
- The hook is the stock `BaseInstrument.js` with our code appended: rebuild it after every sim update.

## Logs and state

| What | Where |
|---|---|
| Host log | `%LOCALAPPDATA%\CockpitLink\logs\host.log` (previous run: `host.1.log`) |
| capture.dll log | `%LOCALAPPDATA%\CockpitLink\logs\capture.log` |
| Full host state | `http://localhost:8800/api/status` |
| Learned displays | `http://localhost:8800/api/displays`, `%LOCALAPPDATA%\CockpitLink\displays.json` |
| Saved display pictures (editor Insert window) | `%LOCALAPPDATA%\CockpitLink\thumbs\<id>.jpg`, `http://localhost:8800/thumb/<id>.jpg` |
| Instruments seen per aircraft | `http://localhost:8800/api/instruments`, `%LOCALAPPDATA%\CockpitLink\instruments.json` |
| Saved layouts and screens | `%LOCALAPPDATA%\CockpitLink\layouts.json`, `screens.json` |
