# Marker colours

The table lives in **`config/displays.json`** (one source for everything):

- `hook/build-hook.mjs` builds it into the Community hook, which paints the colours.
- The host sends it to capture.dll in CONFIG (`docs/protocol.md` section 1), which matches textures by it.

Current entries:

| Instrument element tag | Display id | Pixel 0 (x) | Pixel 1 (x+1) |
|---|---|---|---|
| `wtg1000-pfd` | `pfd` | rgb(201, 13, 77) | rgb(17, 190, 233) |
| `wtg1000-mfd` | `mfd` | rgb(77, 201, 13) | rgb(233, 17, 190) |

How the hook paints them: a fixed-position 2x1 px element on the page at the display's visible top-left
corner, above everything else. That corner, in texture pixels, is the `read` point the hook reports to
the host, so capture.dll knows exactly where to look.

Notes for capture.dll:

- Compare with a small tolerance (for example ±3 per channel). Textures may be BGRA (swap R and B) and
  the sim may blend at the edges.
- Paint the two marker pixels over (for example with the pixels below them) before JPEG encoding, so
  clients never see them.
- Element tags for the default C172 G1000 are `wtg1000-pfd` and `wtg1000-mfd` (as seen in the sim).
- Learned displays (`host/src/displayRegistry.mjs`) get their colours from a grid: low channel 5-53, high
  185-249, middle 70-166, steps of 16, every order of channels (840 colours, at least 16 apart in some
  channel; capture.dll matches within 3). The two pixels of one marker use different channel orders.
  The hook receives the table from the host at runtime, so no rebuild is needed.
