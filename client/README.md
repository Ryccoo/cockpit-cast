# CockpitCast client

The app that runs on the display devices. Build and usage instructions are in the main
[README](../README.md#client-app) (section "Client app").

Code map:

| File | What |
|---|---|
| `lib/main.dart` | Start-up: Settings page, or straight to the displays |
| `lib/settings.dart` | Saved settings and command-line flags |
| `lib/settings_screen.dart` | Settings page |
| `lib/displays_screen.dart` | One window's content (glass displays or a gauge layout) |
| `lib/host_connection.dart`, `lib/protocol.dart` | WebSocket link to the host |
| `lib/discovery.dart` | Finding the host on the network (mDNS) |
| `lib/desktop.dart` | Monitors, full screen, extra windows, start at sign-in (desktop only) |
| `lib/gauges/` | Steam gauges (keep in sync with `host/public/gauges.js`) |
