// ===== CockpitCast hook (appended to the stock BaseInstrument.js by hook/build-hook.mjs) =====
// On every instrument page:
//   - tells the CockpitCast host on this PC which instruments the page holds (element tag, url, size).
//     The host learns the big ones as glass displays and answers with its display table
//     (instrument key -> display id + two marker colours), so new displays need no rebuild of this file;
//   - for instruments in that table: paints the two marker pixels at the display's top-left corner, so
//     capture.dll can tell which DirectX texture is which display, keeps static displays redrawn with a
//     1 px heartbeat, and reports where the display sits in the page so capture.dll can crop it.
// Pages without instruments do nothing. Without the host the hook paints only the built-in table.
//
// Instrument key: the element tag, plus "#<n>" when the instrument's url has Index=<n> (cockpits with two
// of the same instrument). The table may hold either form; the exact key wins.
(function () {
  if (window.__cockpitCastHook) return;
  window.__cockpitCastHook = 1;

  // Built-in table, filled in by build-hook.mjs from config/displays.json. Replaced by the host's table.
  var DISPLAYS = /*__DISPLAYS__*/ {};
  var HOST_URL = 'ws://127.0.0.1:' + /*__PORT__*/ 8800 + '/hook';
  var VERSION = /*__VERSION__*/ 'dev';
  var INST_URL = '/pages/vcockpit/instruments/';
  var MARK_CLASS = '__cockpitcast_marker';

  function keyOf(el) {
    var tag = el.tagName.toLowerCase();
    var url = el.getAttribute('url') || '';
    // WASM gauges all share one element tag; the gauge name in the url tells them apart
    // (e.g. wasm-instrument:pfd).
    var g = /[?&]wasm_gauge=([A-Za-z0-9_.-]{1,40})/i.exec(url);
    if (g) tag += ':' + g[1].toLowerCase();
    var m = /[?&]index=(\d{1,2})\b/i.exec(url);
    return m ? tag + '#' + m[1] : tag;
  }
  function lookup(key) {
    return DISPLAYS[key] || DISPLAYS[key.split('#')[0]] || null;
  }
  function isInstrument(el) {
    try { return typeof BaseInstrument !== 'undefined' && el instanceof BaseInstrument; } catch (e) { return false; }
  }

  // All instrument elements on the page: elements whose url points at an instrument, and instrument
  // objects among the first two levels under <vcockpit-panel>.
  function findInstruments() {
    var out = [];
    function add(el) {
      if (!el || out.indexOf(el) >= 0) return;
      var url = (el.getAttribute('url') || '').toLowerCase();
      if (url.indexOf(INST_URL) >= 0 || isInstrument(el)) out.push(el);
    }
    var els = document.querySelectorAll('[url]');
    for (var i = 0; i < els.length; i++) add(els[i]);
    var panels = document.querySelectorAll('vcockpit-panel');
    for (var p = 0; p < panels.length; p++) {
      var kids = panels[p].children;
      for (var k = 0; k < kids.length; k++) {
        add(kids[k]);
        for (var g = 0; g < kids[k].children.length; g++) add(kids[k].children[g]);
      }
    }
    return out;
  }

  function describe(el) {
    var r = el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    var templateID = null, identifier = null;
    try { if (typeof el.templateID === 'string') templateID = el.templateID; } catch (e) {}
    try { if (typeof el.instrumentIdentifier === 'string') identifier = el.instrumentIdentifier; } catch (e) {}
    return {
      key: keyOf(el), tag: el.tagName.toLowerCase(), url: (el.getAttribute('url') || '').slice(0, 300),
      templateID: templateID, identifier: identifier,
      w: Math.round(r.width * dpr), h: Math.round(r.height * dpr)
    };
  }

  // Visible part of an element in page (CSS) pixels, clipped to the viewport.
  function visibleRect(el) {
    var r = el.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.max(0, Math.round(r.left)), top = Math.max(0, Math.round(r.top));
    var right = Math.min(vw, Math.round(r.right)), bottom = Math.min(vh, Math.round(r.bottom));
    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top), vw: vw, vh: vh };
  }

  function pixel(left, rgb) {
    var p = document.createElement('div');
    p.style.cssText = 'position:absolute;left:' + left + 'px;top:0;width:1px;height:1px;' +
      'background-color:rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ') !important;';
    return p;
  }

  // The marker is a fixed-position element at the display's visible top-left corner, so its texture
  // position is exactly the read point we report.
  function ensureMarker(item, rect) {
    var want = item.def.id + '@' + rect.x + ',' + rect.y + ':' + item.def.px.join(',');
    var m = item.marker;
    if (m && m.isConnected && m.getAttribute('data-want') === want) return;
    if (m && m.isConnected) m.parentNode.removeChild(m);
    m = document.createElement('div');
    m.className = MARK_CLASS;
    m.appendChild(pixel(0, item.def.px[0]));
    m.appendChild(pixel(1, item.def.px[1]));
    (document.body || document.documentElement).appendChild(m);
    item.marker = m;
    m.setAttribute('data-want', want);
    m.style.cssText = 'position:fixed;left:' + rect.x + 'px;top:' + rect.y + 'px;width:2px;height:1px;' +
      'z-index:2147483647;pointer-events:none;';
  }
  function removeMarkers(keep) {
    var all = document.querySelectorAll('.' + MARK_CLASS);
    for (var i = 0; i < all.length; i++) if (keep.indexOf(all[i]) < 0) all[i].parentNode.removeChild(all[i]);
  }

  var heartbeat = null, beatOn = false;
  function ensureHeartbeat() {
    if (heartbeat && heartbeat.parentNode) return;
    heartbeat = document.createElement('div');
    heartbeat.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;pointer-events:none;' +
      'z-index:2147483647;background-color:rgb(0,0,0);';
    (document.body || document.documentElement).appendChild(heartbeat);
  }

  // ---- link to the host (best effort, retried slowly) ----
  var ws = null, wsOpen = false, retryMs = 5000, nextTry = 0;
  var lastLayout = '', invSent = '';
  function connect(names) {
    var now = Date.now();
    if (ws || now < nextTry) return;
    nextTry = now + retryMs;
    retryMs = Math.min(retryMs * 2, 60000);
    try {
      var s = new WebSocket(HOST_URL);
      ws = s;
      s.onopen = function () {
        wsOpen = true;
        retryMs = 5000;
        lastLayout = '';
        invSent = '';
        sendText(JSON.stringify({ type: 'hello', page: names + ' ' + location.pathname, version: VERSION }));
      };
      s.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg && msg.type === 'displays' && msg.table && typeof msg.table === 'object') {
          DISPLAYS = msg.table;
          items = null; // match the instruments against the new table on the next tick
        }
      };
      s.onclose = s.onerror = function () { wsOpen = false; if (ws === s) ws = null; };
    } catch (e) { ws = null; }
  }
  function sendText(text) {
    try { ws.send(text); } catch (e) {}
  }

  // ---- once a second ----
  var instruments = [], items = null, inventory = '', scans = 0;
  function rescan() {
    instruments = findInstruments();
    items = [];
    for (var i = 0; i < instruments.length; i++) {
      var key = keyOf(instruments[i]), def = lookup(key);
      if (def) items.push({ el: instruments[i], def: def, key: key, tag: instruments[i].tagName.toLowerCase() });
    }
    var list = instruments.map(describe);
    var dpr = window.devicePixelRatio || 1;
    inventory = JSON.stringify({
      type: 'instruments', page: location.pathname,
      texture: { w: Math.round(window.innerWidth * dpr), h: Math.round(window.innerHeight * dpr) },
      instruments: list
    });
  }

  function tick() {
    // Rescan every 10 s (instruments can appear late, sizes settle), or when the table changed.
    if (!items || scans++ % 10 === 0) rescan();
    if (!instruments.length) return; // not an instrument page: do nothing at all
    connect(instruments.map(keyOf).join(','));
    if (wsOpen && inventory !== invSent) { sendText(inventory); invSent = inventory; }

    var markers = [], rects = [];
    for (var i = 0; i < items.length; i++) {
      if (!items[i].el.isConnected) { items = null; return; }
      rects.push(visibleRect(items[i].el));
      ensureMarker(items[i], rects[i]);
      markers.push(items[i].marker);
    }
    removeMarkers(markers);
    if (!items.length) return;
    ensureHeartbeat();
    beatOn = !beatOn;
    heartbeat.style.backgroundColor = beatOn ? 'rgb(2,2,2)' : 'rgb(0,0,0)';

    if (!wsOpen) return;
    var dpr = window.devicePixelRatio || 1;
    var layout = JSON.stringify({ type: 'layout', displays: items.map(function (it, n) {
      var r = rects[n];
      return {
        id: it.def.id, tag: it.key,
        read: { x: Math.round(r.x * dpr), y: Math.round(r.y * dpr) },
        crop: { w: Math.round(r.w * dpr), h: Math.round(r.h * dpr) },
        texture: { w: Math.round(r.vw * dpr), h: Math.round(r.vh * dpr) }
      };
    }) });
    if (layout !== lastLayout) { lastLayout = layout; sendText(layout); }
  }

  function start() { setInterval(function () { try { tick(); } catch (e) {} }, 1000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
