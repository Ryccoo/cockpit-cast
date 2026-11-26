# Development and testing

Everything here can run without the sim. See
`docs/protocol.md` for the three links (capture pipe, client WebSocket, hook WebSocket).

## Test tools

| Tool | What it does |
|---|---|
| `host/tools/fake-capture.mjs` (`npm run fake-capture`) | Behaves like capture.dll: connects to the host's pipe and sends moving PFD/MFD test cards (only while a client watches). `--static` sends a still picture |
| `host/tools/test-client.mjs` | Command-line client: `node tools/test-client.mjs --seconds 5` prints frame rates per display |
| `injector/build/Release/fake-sim.exe` | A process to inject into, plus a test DLL (`injector/build/test/Release/cockpitcast-capture.dll`) that connects to the host and logs the CONFIG it receives |
| `capture/build/Release/panel-sim.exe` | D3D12 stand-in for the sim: renders fake PFD/MFD panels with marker pixels, plus decoys. The real capture.dll can be injected into it |
| `client/tool/discover.dart` | `dart run tool/discover.dart`: lists the hosts found on the network |

Host environment switches for testing:

| Variable | Effect |
|---|---|
| `COCKPITCAST_FAKE_DATA=1` | Synthetic flight data for the steam gauges (no sim needed) |
| `COCKPITCAST_SCREEN_MODE=steam` / `glass` | Force the screen mode instead of detecting it |
| `COCKPITCAST_SIM_EXE=<exe name>` | Which process the injector waits for (e.g. `panel-sim.exe`) |
| `COCKPITCAST_REQUIRE_FLIGHT=0` | Inject without waiting for a live flight |
| `COCKPITCAST_DLL=<path>` | DLL to inject |
| `COCKPITCAST_AUTO_INJECT=0` | Do not inject by itself (manual: `curl -X POST http://localhost:8800/api/inject`) |
| `COCKPITCAST_TRAY=0` | No tray icon |
| `COCKPITCAST_PORT=<port>` | Host port (default 8800; rebuild the hook if you change it) |

## Recipes

Installers (needs Inno Setup 6 as well as the build tools; output in `installer\output\`):

```
powershell -ExecutionPolicy Bypass -File installer\build.ps1            # everything
powershell -ExecutionPolicy Bypass -File installer\build.ps1 -SkipBuild # reuse the existing builds
```

The tray program as launcher, like an installed copy (starts the host with no console window; quit
from its menu): run `tray\build\Release\cockpitcast-tray.exe` directly instead of `npm start`.

Pipeline without the sim (fake frames):

```
cd host
npm start
npm run fake-capture          # second terminal
```

Injection without the sim:

```
injector\build\Release\fake-sim.exe
set COCKPITCAST_SIM_EXE=fake-sim.exe
set COCKPITCAST_REQUIRE_FLIGHT=0
set COCKPITCAST_DLL=..\injector\build\test\Release\cockpitcast-capture.dll
cd host && npm start
```

Real capture.dll without the sim:

```
capture\build\Release\panel-sim.exe
set COCKPITCAST_SIM_EXE=panel-sim.exe
set COCKPITCAST_REQUIRE_FLIGHT=0
cd host && npm start          # injects capture.dll into panel-sim; watch pfd/mfd in a client
```

Steam gauges without the sim:

```
set COCKPITCAST_FAKE_DATA=1
set COCKPITCAST_SCREEN_MODE=steam
cd host && npm start
```

Updates without a real release (a stand-in for GitHub's API that serves the newer installers):

```
set COCKPITCAST_UPDATE_URL=http://127.0.0.1:8899/latest
"%LOCALAPPDATA%\Programs\CockpitCast\cockpitcast.exe"          # host: checks a minute after start
"%LOCALAPPDATA%\Programs\CockpitCast Client\cockpitcast.exe"   # client: checks 10 s after start
```

The URL must answer like `GET /repos/<owner>/<repo>/releases/latest` (`tag_name`, `html_url`,
`assets[].name` and `browser_download_url`), with `SHA256SUMS.txt` among the assets. The installers must
be built with a higher version (host/package.json, client/pubspec.yaml and client/lib/about.dart).

## Keeping things in sync

- `host/public/gauges.js` (editor) is a port of `client/lib/gauges/instruments.dart` (client). Change both.
- `config/displays.json` (built-in displays) feeds both the hook build and the host. Learned displays
  need no rebuild: the host sends the hook its table at runtime.
- The hook is the stock `BaseInstrument.js` with our code appended: rebuild it after every sim update.
- The version is in three places: `host/package.json`, `client/pubspec.yaml` and `client/lib/about.dart`
  (`appVersion`, which the client's updater compares). The release workflow refuses a tag that differs.

## Android test builds

The Android app is not published with the releases; it is planned for the Play Store. The release
workflow builds it on every run, signed with the upload key:
- **APK:** for testing on your own devices.
- **App bundle (`.aab`):** for the Play Store.

Both go into an encrypted `CockpitCast-Client-android.7z` on the run's page (Artifacts, kept 30 days).
Its password is the keystore password. Workflow artifacts of a public repo can be downloaded by any
signed-in GitHub user, which is why they're encrypted.

**Run workflow** on the Actions tab builds everything as a test and publishes nothing. Only a
version tag publishes a release.

Signing:
- **CI:** repository secrets `ANDROID_KEYSTORE_BASE64` (the `.jks` file, base64) and
  `ANDROID_KEYSTORE_PASSWORD`; the key alias is `upload`. Without them the app is built but not uploaded.
- **Local:** `client/android/key.properties` (git-ignored) with `storeFile=`, `storePassword=` and
  `keyAlias=upload`. Without it, release builds use the debug key.
- **The key:** this is the Play Store *upload* key. With Play App Signing, Google signs the published
  app, and a lost upload key can be reset through Play Console support. Keep a backup of the `.jks`
  and its password anyway.

## Logs and state

| What | Where |
|---|---|
| Host log | `%LOCALAPPDATA%\CockpitCast\logs\host.log` (previous run: `host.1.log`) |
| capture.dll log | `%LOCALAPPDATA%\CockpitCast\logs\capture.log` |
| Update installs | `%LOCALAPPDATA%\CockpitCast\logs\update-install.log` (host), `%LOCALAPPDATA%\CockpitCast\client-update.log` (client) |
| Full host state | `http://localhost:8800/api/status` |
| Learned displays | `http://localhost:8800/api/displays`, `%LOCALAPPDATA%\CockpitCast\displays.json` |
| Saved display pictures (editor Insert window) | `%LOCALAPPDATA%\CockpitCast\thumbs\<id>.jpg`, `http://localhost:8800/thumb/<id>.jpg` |
| Instruments seen per aircraft | `http://localhost:8800/api/instruments`, `%LOCALAPPDATA%\CockpitCast\instruments.json` |
| Saved layouts and screens | `%LOCALAPPDATA%\CockpitCast\layouts.json`, `screens.json` |
