# Instructions for coding agents

Read this before changing anything in CockpitCast. It applies to every coding agent (and to people:
[CONTRIBUTING.md](CONTRIBUTING.md) points here). Start with the [README](README.md) for what the parts are,
[docs/protocol.md](docs/protocol.md) for the links between them, and
[docs/development.md](docs/development.md) for testing without the sim.

## Rules that are never broken

- **Glass displays come from the sim's DirectX 12 textures** (capture.dll). No pop-out windows and no
  window or screen capture, not even as a fallback.
- **Read-only towards the sim.** Nothing is sent back to MSFS: no SimConnect writes, no events, no
  changed rendering. capture.dll only copies textures.
- **All code is our own; dependencies have open licences** compatible with GPL-3.0 (list new ones in
  `installer/THIRD-PARTY-NOTICES.txt`). Do not copy code, files, names or references from other
  products, add-ons or projects into the repository.
- **Never change security settings on a user's PC** (antivirus, Smart App Control, firewall rules,
  permissions) from code or installers. Explain what the user can do instead.
- **Tests never touch a real sim or a real setup.** A test host runs isolated (`COCKPITCAST_ISOLATED=1`,
  a free port, `LOCALAPPDATA`/`APPDATA`/`ProgramData` pointed at a scratch folder). Never connect a test
  to a running MSFS or to the user's CockpitCast, and never write to the real
  `%LOCALAPPDATA%\CockpitCast`.
- **No secrets or personal data** in code, logs, tests, commits or issues (keys, passwords, e-mail
  addresses, user names in paths).

## Before you change code

1. Understand the request. If it is a question or a bug report, explain the cause and propose a fix
   first; change code when asked to.
2. Read the module you touch and its neighbours. Follow the existing structure and naming instead of
   adding a parallel way of doing the same thing.
3. Look for existing tests of that behaviour (`host/test/`, `client/test/`).

## Clean code

- **Small and direct.** Solve the problem asked, in the place it belongs. No speculative options,
  layers or abstractions "for later". Delete code that the change makes unused (dead functions, unused
  files, old flags).
- **Names say what things are** in the domain: screen, display, layout, hook, Community folder,
  capture. Use the same word for the same thing everywhere (code, UI, docs, logs).
- **Comments explain why**, not what the next line does: the constraint, the Windows or sim quirk, the
  bug a line prevents. Each file starts with a short comment on what it is for. Keep comments true when
  you change code.
- **Errors are real messages.** Say what failed and what the user can do ("The Community folder
  CockpitCast remembers cannot be found right now: … Is its drive connected?"), never just a code.
  Do not swallow errors silently except where failing is harmless, and then say so in a comment.
- **Log what helps a bug report**: one line per state change (connected, chose folder X, mode glass),
  not per frame. No personal data beyond what the logs already hold (paths, aircraft names).
- **User-facing text is plain English**, short, and the same in the window, tray, installer and README.
- **No unrelated changes** in a change: no reformatting, renames or "while I was here" edits. Keep
  diffs reviewable.

Per language:

| Part | Style |
|---|---|
| Host (`host/`, Node.js, ES modules) | No build step, no TypeScript. Node's standard library first; a new npm dependency needs a good reason. `async`/`await`; never block the event loop with long sync work while streaming. |
| Window (`host/public/`) | Plain HTML, CSS and JavaScript, no framework or bundler. Escape everything inserted as HTML (`esc`). Pages from other computers are read-only: local-only APIs answer 403 to them. |
| Hook (`hook/`) | Runs inside the sim's instrument pages: small, no dependencies, must never break an instrument. |
| C++ (`capture/`, `injector/`, `tray/`, `screens/`) | C++20, Win32 and D3D directly, RAII for handles. capture.dll runs inside the sim: never block the render thread, never crash on unexpected input, fail closed (stop capturing). |
| Display app (`client/`, Flutter) | `flutter analyze` must be clean. Device-agnostic: no keyboard required, works on Windows, Linux, Android. |

## Tests

Every change that alters behaviour comes with a test, unless it can only be tested in the sim (then
say how you tested it by hand). A bug fix starts with a test that fails without the fix.

| Part | Run | Where |
|---|---|---|
| Host | `cd host && npm test` | `host/test/*.test.mjs` (Node's built-in runner, no extra dependencies) |
| Display app | `cd client && flutter analyze && flutter test` | `client/test/` |

- Unit tests use small fakes (see `host/test/screens.test.mjs`) rather than mocking libraries.
- Scripts that touch folders (like `hook/install-hook.mjs`) are tested by running a copy against a
  scratch folder (see `host/test/install-hook.test.mjs`).
- End-to-end host behaviour goes in `host/test/smoke.test.mjs`: a real host, started isolated.
- Tests are fast and independent: scratch folders from `os.tmpdir()`, cleaned up in `t.after`; free
  ports, never 8800; no network access beyond localhost.
- GitHub runs all of them on every push and pull request (`.github/workflows/tests.yml`), and a
  release is only built when they pass.

C++ and anything inside the sim (capture, injection, the hook in a real cockpit) are tested by hand
with the tools in `docs/development.md` (`panel-sim.exe`, `fake-sim.exe`, `fake-capture.mjs`).

## Keep in sync

- A message between parts changed: update `docs/protocol.md`, both ends, and the smoke test.
- Something users see or set changed: update the README (and the window's Help text if it is a fix).
- A new setting or environment switch: document it in `docs/development.md` or the README.
- Versions live in three places that must match: `host/package.json`, `client/pubspec.yaml`,
  `client/lib/about.dart` (the release workflow checks).

## Commits and pull requests

- One topic per commit. The message says what changed and why, in plain sentences.
- Run the tests before committing. Do not commit build output, logs, `node_modules` or local settings.
- Do not push, tag or publish a release unless the maintainer asked for it.
- First-time contributors sign the [CLA](CLA.md) (a bot asks on the pull request).
