# Contributing to CockpitCast

Thanks for helping. Issues and pull requests are welcome.

- **Reporting a bug:** say what you expected and what happened, and attach the logs: in the CockpitCast
  window, **Help > Logs** makes a zip for a bug report (the display app: **Settings > Logs**).
- **Changing code:** read [AGENTS.md](AGENTS.md). It holds the project's rules, the code style and how to
  test, for people and coding agents alike. [docs/development.md](docs/development.md) shows how to run and
  test every part without the sim.
- **Before you open a pull request:** `cd host && npm test`, and for the display app
  `cd client && flutter analyze && flutter test`. GitHub runs the same checks on every pull request.
- **First pull request:** a bot asks you to sign the [Contributor License Agreement](CLA.md) with one comment.
  You keep the copyright in your work.

Ideas that need help: better primary-display guesses for more aircraft, more gauge types, and setup notes
for specific display devices.
