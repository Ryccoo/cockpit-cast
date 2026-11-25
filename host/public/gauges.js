// Gauge drawing for the layout editor (browser canvas).
// KEEP IN SYNC with the client's gauges: client/lib/gauges/gauge_base.dart and instruments.dart.
// Same design: each gauge is drawn in a 400 x 400 space centred on (0,0), face radius 186.
//
//   drawGauge(ctx, widthPx, heightPx, type, options, V)
//   V: { get(key, fallback), knows(key), live }

(function () {
  'use strict';
  const R = 200, FACE = 186, DEG = Math.PI / 180;
  const C = {
    white: '#f0eee8', grey: '#a8a8a8', green: '#1fae4b', yellow: '#f2c21b', red: '#e0322b',
    needle: '#f4f2ec', orange: '#f08a1c', blue: '#3b82f6',
  };
  const named = (n) => C[n] || C.white;
  const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
  const dialAngle = (v, min, max, start, sweep) => (start + sweep * Math.max(-0.02, Math.min(1.02, (v - min) / (max - min)))) * DEG;
  const compass = (d) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10));
  const fmt = (v, d) => (d > 0 ? v.toFixed(d) : String(Math.round(v)));
  const round5 = (v) => Math.round(v / 5) * 5;

  function tick(c, a, r1, r2, w, color = C.white) {
    const [x1, y1] = polar(r1, a), [x2, y2] = polar(r2, a);
    c.strokeStyle = color; c.lineWidth = w; c.lineCap = 'butt';
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  }
  function arc(c, r, a1, a2, w, color) {
    c.strokeStyle = color; c.lineWidth = w;
    c.beginPath(); c.arc(0, 0, r, a1, a2); c.stroke();
  }
  function text(c, s, x, y, size, color = C.white, weight = 700) {
    c.fillStyle = color; c.font = `${weight} ${size}px system-ui, Segoe UI, Roboto, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(s, x, y);
  }
  function tri(c, pts, color) {
    c.fillStyle = color; c.beginPath(); c.moveTo(...pts[0]);
    for (const p of pts.slice(1)) c.lineTo(...p);
    c.closePath(); c.fill();
  }
  function hub(c, w) {
    const g = c.createRadialGradient(-3, -3, 0, -3, -3, w * 1.2);
    g.addColorStop(0, '#4a4b4f'); g.addColorStop(1, '#141416');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, w * 1.15, 0, Math.PI * 2); c.fill();
  }
  function needle(c, a, len, { width = 12, tail = 30, color = C.needle, withHub = true } = {}) {
    const path = () => {
      c.beginPath(); c.moveTo(-tail, -width / 2); c.lineTo(len - 22, -width / 2.4); c.lineTo(len, 0);
      c.lineTo(len - 22, width / 2.4); c.lineTo(-tail, width / 2); c.closePath();
    };
    c.save(); c.translate(5, 7); c.rotate(a); c.filter = 'blur(3px)'; c.fillStyle = 'rgba(0,0,0,0.4)'; path(); c.fill(); c.restore();
    c.save(); c.rotate(a); c.fillStyle = color; path(); c.fill(); c.restore();
    if (withHub) hub(c, width);
  }

  function caseAndFace(c) {
    c.fillStyle = '#1a1b1d'; roundRect(c, -R, -R, 2 * R, 2 * R, 26); c.fill();
    for (const [x, y] of [[-176, -176], [176, -176], [-176, 176], [176, 176]]) {
      const g = c.createRadialGradient(x - 3, y - 3, 0, x - 3, y - 3, 12);
      g.addColorStop(0, '#6a6c70'); g.addColorStop(1, '#2a2b2e');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, 11, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#151517'; c.lineWidth = 2.5; c.beginPath(); c.moveTo(x - 7, y + 4); c.lineTo(x + 7, y - 4); c.stroke();
    }
    const ring = c.createLinearGradient(-150, -150, 150, 150);
    ring.addColorStop(0, '#5a5c60'); ring.addColorStop(0.55, '#202124'); ring.addColorStop(1, '#3c3e42');
    c.fillStyle = ring; c.beginPath(); c.arc(0, 0, R - 2, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#060607'; c.beginPath(); c.arc(0, 0, FACE + 3, 0, Math.PI * 2); c.fill();
    const face = c.createRadialGradient(0, 0, 0, 0, 0, FACE);
    face.addColorStop(0, '#1c1d20'); face.addColorStop(1, '#0d0d0f');
    c.fillStyle = face; c.beginPath(); c.arc(0, 0, FACE, 0, Math.PI * 2); c.fill();
  }
  function glass(c) {
    const g = c.createLinearGradient(-120, -170, 60, 40);
    g.addColorStop(0, 'rgba(255,255,255,0.086)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, FACE, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 12; c.beginPath(); c.arc(0, 0, FACE - 6, 0, Math.PI * 2); c.stroke();
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  const opt = (o, k, d) => (typeof o[k] === 'number' ? o[k] : d);

  // ---------------- gauges (face + moving parts; drawn every frame) ----------------
  const G = {};

  G.asi = (c, o, V) => {
    const vs0 = V.get('vs0'), vs1 = V.get('vs1'), vneSim = V.get('vne');
    let vfe = V.get('vfe'), vno = V.get('vno'), est = false;
    if (vfe <= 0 && vs0 > 0) { vfe = round5(vs0 * 2.1); est = true; }
    if (vno <= 0 && vneSim > 0) { vno = round5(vneSim / 1.25); est = true; }
    const vne = typeof o.vne === 'number' ? o.vne : vneSim;
    const max = opt(o, 'max', vne > 0 ? Math.max(160, Math.ceil((vne * 1.18) / 20) * 20) : 200);
    const low = opt(o, 'low', max > 260 ? 60 : 40);
    const a = (v) => (v <= low ? (-90 + Math.max(0, Math.min(1, v / low)) * 28) * DEG : (-62 + Math.max(0, Math.min(1.02, (v - low) / (max - low))) * 300) * DEG);
    const rng = (k, def) => (Array.isArray(o[k]) && o[k].length === 2 ? o[k] : def);
    const white = rng('white', vs0 > 0 && vfe > 0 ? [vs0, vfe] : null);
    const green = rng('green', vs1 > 0 && vno > 0 ? [vs1, vno] : null);
    const yellow = rng('yellow', vno > 0 && vne > 0 ? [vno, vne] : null);
    if (white) arc(c, 150, a(white[0]), a(white[1]), 10, C.white);
    if (green) arc(c, 164, a(green[0]), a(green[1]), 15, C.green);
    if (yellow) arc(c, 164, a(yellow[0]), a(yellow[1]), 15, C.yellow);
    if (vne > 0) tick(c, a(vne), 146, 184, 6, C.red);
    const major = max > 260 ? 20 : 10;
    for (let v = low; v <= max + 0.1; v += major / 2) { const m = (v - low) % major === 0; tick(c, a(v), m ? 158 : 170, 184, m ? 4.5 : 2.5); }
    for (let v = low; v <= max + 0.1; v += major * 2) text(c, String(Math.round(v)), ...polar(124, a(v)), 30);
    text(c, 'AIRSPEED', 0, -62, 19); text(c, 'KNOTS', 0, 60, 19);
    if (est && !Array.isArray(o.white)) text(c, 'EST', 0, 92, 13, C.grey);
    needle(c, a(Math.max(0, V.get('ias'))), 168);
  };

  G.attitude = (c, o, V) => {
    const pitchUp = -V.get('pitch'), rollRight = -V.get('bank'), ringR = 150, ppd = 5.2;
    c.save(); c.rotate(-rollRight * DEG);
    c.fillStyle = '#1f5a9c'; c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, FACE, Math.PI, 2 * Math.PI); c.fill();
    c.fillStyle = '#4e2f16'; c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, FACE, 0, Math.PI); c.fill();
    for (const b of [-60, -30, -20, -10, 10, 20, 30, 60]) { const big = Math.abs(b) === 30 || Math.abs(b) === 60; tick(c, (-90 + b) * DEG, ringR + 4, big ? 184 : 172, big ? 5 : 3); }
    for (const b of [-45, 45]) { c.save(); const [x, y] = polar(176, (-90 + b) * DEG); c.translate(x, y); c.rotate(b * DEG); tri(c, [[0, 8], [-7, -6], [7, -6]], C.white); c.restore(); }
    tri(c, [[0, -ringR - 4], [-12, -180], [12, -180]], C.white);
    c.save(); c.beginPath(); c.arc(0, 0, ringR, 0, Math.PI * 2); c.clip();
    c.translate(0, Math.max(-30, Math.min(30, pitchUp)) * ppd);
    let g = c.createLinearGradient(0, -160, 0, 0); g.addColorStop(0, '#1f5a9c'); g.addColorStop(1, '#2f78c8');
    c.fillStyle = g; c.fillRect(-400, -600, 800, 600);
    g = c.createLinearGradient(0, 0, 0, 160); g.addColorStop(0, '#6e4320'); g.addColorStop(1, '#4e2f16');
    c.fillStyle = g; c.fillRect(-400, 0, 800, 600);
    c.strokeStyle = C.white; c.lineWidth = 3; c.beginPath(); c.moveTo(-400, 0); c.lineTo(400, 0); c.stroke();
    for (let p = -20; p <= 20; p += 5) {
      if (!p) continue;
      const y = -p * ppd, half = p % 10 === 0 ? 46 : 20;
      c.lineWidth = 2.5; c.beginPath(); c.moveTo(-half, y); c.lineTo(half, y); c.stroke();
      if (p % 10 === 0) { text(c, String(Math.abs(p)), -half - 18, y, 15); text(c, String(Math.abs(p)), half + 18, y, 15); }
    }
    c.restore(); c.restore();
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 3; c.beginPath(); c.arc(0, 0, ringR, 0, Math.PI * 2); c.stroke();
    tri(c, [[0, -ringR - 6], [-13, -FACE + 2], [13, -FACE + 2]], C.orange);
    c.strokeStyle = C.orange; c.lineWidth = 8; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-112, 0); c.lineTo(-44, 0); c.lineTo(-18, 18); c.lineTo(18, 18); c.lineTo(44, 0); c.lineTo(112, 0); c.stroke();
    c.fillStyle = C.orange; c.beginPath(); c.arc(0, 0, 6, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#151517'; c.beginPath(); c.arc(0, 0, FACE, 35 * DEG, 145 * DEG); c.closePath(); c.fill();
    text(c, 'ATTITUDE', 0, 150, 13, C.grey);
  };

  G.altimeter = (c, o, V) => {
    const a = (d) => (-90 + d * 36) * DEG, alt = V.get('alt');
    for (let i = 0; i < 50; i++) { const m = i % 5 === 0; tick(c, (-90 + i * 7.2) * DEG, m ? 158 : 171, 184, m ? 4.5 : 2.5); }
    for (let d = 0; d < 10; d++) text(c, String(d), ...polar(132, a(d)), 38);
    text(c, 'ALT', 0, -64, 19); text(c, '100 FEET', 0, -40, 13, C.grey); text(c, 'IN HG', 100, -32, 11, C.grey);
    c.fillStyle = '#000'; roundRect(c, 62, -18, 80, 36, 4); c.fill();
    c.fillStyle = '#e9e6dc'; roundRect(c, 64, -16, 76, 32, 3); c.fill();
    text(c, V.get('baro', 29.92).toFixed(2), 102, 0, 21, '#111');
    c.save(); c.rotate(a(alt / 10000));
    c.strokeStyle = C.needle; c.lineWidth = 3; c.beginPath(); c.moveTo(0, 0); c.lineTo(170, 0); c.stroke();
    tri(c, [[184, 0], [162, -11], [162, 11]], C.needle); c.restore();
    needle(c, a((alt % 10000) / 1000), 100, { width: 20, tail: 16, withHub: false });
    needle(c, a((alt % 1000) / 100), 166, { width: 11, tail: 30 });
  };

  G.turn = (c, o, V) => {
    for (const m of [-20, 0, 20]) { tick(c, (180 + m) * DEG, 148, 180, 7); tick(c, -m * DEG, 148, 180, 7); }
    const [lx, ly] = polar(128, 160 * DEG), [rx, ry] = polar(128, 20 * DEG);
    text(c, 'L', lx, ly + 14, 26); text(c, 'R', rx, ry + 14, 26);
    text(c, 'TURN COORDINATOR', 0, -118, 16); text(c, 'D.C. ELEC.', 0, -92, 11, C.grey);
    text(c, 'NO PITCH INFORMATION', 0, 62, 11, C.grey); text(c, '2 MIN', 0, 158, 15, C.grey);
    const tc = [0, -330], tr = 430;
    c.lineCap = 'round';
    c.strokeStyle = '#050505'; c.lineWidth = 40; c.beginPath(); c.arc(tc[0], tc[1], tr, 76 * DEG, 104 * DEG); c.stroke();
    const tg = c.createLinearGradient(0, 80, 0, 122); tg.addColorStop(0, '#dce3d2'); tg.addColorStop(1, '#9ea693');
    c.strokeStyle = tg; c.lineWidth = 32; c.beginPath(); c.arc(tc[0], tc[1], tr, 76 * DEG, 104 * DEG); c.stroke();
    let ball = V.get('ball'); if (Math.abs(ball) > 1.5) ball /= 127;
    const [bx, by] = polar(tr, (90 - Math.max(-1, Math.min(1, ball)) * 12) * DEG);
    c.fillStyle = '#080808'; c.beginPath(); c.arc(tc[0] + bx, tc[1] + by, 15, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#111'; c.lineWidth = 3; c.lineCap = 'butt';
    for (const x of [-19, 19]) { c.beginPath(); c.moveTo(x, 84); c.lineTo(x, 120); c.stroke(); }
    const tilt = Math.max(-35, Math.min(35, (V.get('turnRate') / 3) * 20));
    c.save(); c.rotate(tilt * DEG); c.fillStyle = C.white;
    roundRect(c, -134, -6, 268, 12, 6); c.fill(); roundRect(c, -4.5, -36, 9, 36, 4); c.fill(); roundRect(c, -35, -10, 70, 8, 4); c.fill();
    c.beginPath(); c.arc(0, 0, 20, 0, Math.PI * 2); c.fill(); c.restore();
    if (V.live && V.knows('battMaster') && V.get('battMaster') < 0.5) { c.fillStyle = C.red; c.fillRect(60, 30, 56, 26); text(c, 'OFF', 88, 43, 16); }
  };

  G.heading = (c, o, V) => {
    c.save(); c.rotate(-V.get('hdg') * DEG);
    for (let d = 0; d < 360; d += 5) { const m = d % 10 === 0; tick(c, (d - 90) * DEG, m ? 152 : 166, 180, m ? 4.5 : 2.5); }
    for (let d = 0; d < 360; d += 30) { c.save(); c.rotate(d * DEG); text(c, compass(d), 0, -124, d % 90 === 0 ? 38 : 30); c.restore(); }
    c.save(); c.rotate(V.get('hdgBug') * DEG);
    tri(c, [[-18, -184], [18, -184], [18, -166], [8, -166], [0, -174], [-8, -166], [-18, -166]], C.orange); c.restore();
    c.restore();
    for (let m = 45; m < 360; m += 45) { if (m === 180) continue; c.save(); c.rotate(m * DEG); tri(c, [[0, -170], [-7, -184], [7, -184]], C.white); c.restore(); }
    tri(c, [[0, -150], [-12, -184], [12, -184]], C.orange);
    c.strokeStyle = C.orange; c.lineCap = 'round'; c.lineWidth = 9;
    c.beginPath(); c.moveTo(0, -64); c.lineTo(0, 62); c.moveTo(-62, -6); c.lineTo(62, -6); c.stroke();
    c.lineWidth = 7; c.beginPath(); c.moveTo(-24, 50); c.lineTo(24, 50); c.stroke();
  };

  G.vsi = (c, o, V) => {
    const max = opt(o, 'max', 2000), a = (v) => (180 + Math.max(-1.02, Math.min(1.02, v / max)) * 170) * DEG;
    for (let i = -20; i <= 20; i++) { const m = i % 5 === 0; tick(c, a((i * max) / 20), m ? 156 : 170, 184, m ? 4.5 : 2.5); }
    for (let i = -4; i <= 4; i++) { const v = (i * max) / 4; text(c, String(Math.round(Math.abs(v) / 100)), ...polar(128, a(v)), 32); }
    text(c, 'UP', -58, -56, 18); text(c, 'DOWN', -58, 56, 18);
    text(c, 'VERTICAL SPEED', 28, -20, 13, C.grey); text(c, '100 FEET PER MINUTE', 28, 20, 11, C.grey);
    needle(c, a(V.get('vs')), 170);
  };

  G.dial = (c, o, V) => {
    const min = opt(o, 'min', 0), max = opt(o, 'max', 100), a = (v) => dialAngle(v, min, max, 150, 240);
    for (const arcDef of Array.isArray(o.arcs) ? o.arcs : []) arc(c, 164, a(arcDef.from ?? min), a(arcDef.to ?? max), 17, named(arcDef.color));
    const red = typeof o.redlineVar === 'string' && o.redlineVar ? V.get(o.redlineVar) : 0;
    if (red > 0) tick(c, a(red), 146, 184, 7, C.red);
    const major = opt(o, 'majorStep', (max - min) / 5), minor = opt(o, 'minorStep', 0), scale = opt(o, 'labelScale', 1);
    if (minor > 0) for (let v = min; v <= max + 1e-6; v += minor) tick(c, a(v), 170, 184, 2.5);
    const ld = (major * scale) % 1 === 0 ? 0 : 1;
    if (major > 0) for (let v = min; v <= max + 1e-6; v += major) { tick(c, a(v), 152, 184, 5); text(c, fmt(v * scale, ld), ...polar(120, a(v)), 30); }
    text(c, o.label || '', 0, -66, 26); text(c, o.sublabel || '', 0, -38, 20, C.grey);
    const v = V.get(o.var || '');
    if (o.showValue !== false) {
      c.fillStyle = '#050506'; roundRect(c, -60, 80, 120, 44, 5); c.fill();
      text(c, fmt(v, typeof o.decimals === 'number' ? o.decimals : 0), 0, 102, 32, '#e8e2d0');
    }
    needle(c, a(v), 170);
  };

  G.cdi = (c, o, V) => {
    const n = String(Math.round(opt(o, 'nav', 1)));
    c.strokeStyle = C.white; c.lineWidth = 2.5;
    for (let i = -5; i <= 5; i++) {
      if (!i) continue;
      c.beginPath(); c.arc(i * 22, 0, 5, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(0, i * 22, 5, 0, Math.PI * 2); c.stroke();
    }
    c.lineWidth = 3; c.beginPath(); c.arc(0, 0, 24, 0, Math.PI * 2); c.stroke();
    c.save(); c.rotate(-V.get(`nav${n}Obs`) * DEG);
    for (let d = 0; d < 360; d += 5) { const m = d % 10 === 0; tick(c, (d - 90) * DEG, m ? 158 : 168, 182, m ? 4 : 2.5); }
    for (let d = 0; d < 360; d += 30) { c.save(); c.rotate(d * DEG); text(c, compass(d), 0, -136, 26); c.restore(); }
    c.restore();
    tri(c, [[0, -156], [-12, -182], [12, -182]], C.white); tri(c, [[0, 158], [-9, 180], [9, 180]], C.white);
    text(c, `VOR ${n}`, -84, -84, 17, C.grey);
    const dev = Math.max(-1, Math.min(1, V.get(`nav${n}Cdi`) / 127)) * 110;
    c.strokeStyle = C.white; c.lineWidth = 7; c.lineCap = 'round';
    c.beginPath(); c.moveTo(dev, -120); c.lineTo(dev, 120); c.stroke();
    if (V.get(`nav${n}HasGs`) > 0.5) {
      const gs = Math.max(-1, Math.min(1, V.get(`nav${n}Gsi`) / 127)) * 110;
      c.beginPath(); c.moveTo(-120, -gs); c.lineTo(120, -gs); c.stroke();
    }
    const tf = Math.round(V.get(`nav${n}ToFrom`));
    if (V.get(`nav${n}HasNav`) < 0.5 || tf === 0) { c.fillStyle = C.red; c.fillRect(44, 40, 66, 32); text(c, 'NAV', 77, 88, 16, C.red); }
    else { const up = tf === 1; tri(c, [[77, up ? 40 : 72], [56, up ? 70 : 42], [98, up ? 70 : 42]], C.white); text(c, up ? 'TO' : 'FR', 77, 88, 16); }
  };

  G.adf = (c, o, V) => {
    c.save(); c.rotate(-V.get('adfCard') * DEG);
    for (let d = 0; d < 360; d += 5) { const m = d % 10 === 0; tick(c, (d - 90) * DEG, m ? 158 : 168, 182, m ? 4 : 2.5); }
    for (let d = 0; d < 360; d += 30) { c.save(); c.rotate(d * DEG); text(c, compass(d), 0, -134, 28); c.restore(); }
    c.restore();
    text(c, 'ADF', 0, -72, 17, C.grey);
    const rel = V.get('adfSignal') > 0 ? V.get('adfRadial') : 90;
    needle(c, (rel - 90) * DEG, 166, { width: 14, tail: 150, color: C.yellow });
    for (let m = 45; m < 360; m += 45) { c.save(); c.rotate(m * DEG); tri(c, [[0, -172], [-6, -184], [6, -184]], C.white); c.restore(); }
    tri(c, [[0, -152], [-11, -184], [11, -184]], C.orange);
    c.strokeStyle = C.orange; c.lineCap = 'round'; c.lineWidth = 7;
    c.beginPath(); c.moveTo(0, -44); c.lineTo(0, 44); c.moveTo(-44, -4); c.lineTo(44, -4); c.stroke();
    c.lineWidth = 5; c.beginPath(); c.moveTo(-16, 36); c.lineTo(16, 36); c.stroke();
  };

  G.clock = (c, o, V) => {
    for (let i = 0; i < 60; i++) { const m = i % 5 === 0; tick(c, (-90 + i * 6) * DEG, m ? 158 : 172, 184, m ? 5 : 2.5); }
    for (let h = 1; h <= 12; h++) text(c, String(h), ...polar(130, (-90 + h * 30) * DEG), 34);
    const zulu = o.zone === 'zulu';
    text(c, zulu ? 'UTC' : 'LOCAL', 0, 62, 17, C.grey);
    const s = V.get(zulu ? 'zuluTime' : 'localTime');
    needle(c, (-90 + ((s / 3600) % 12) * 30) * DEG, 96, { width: 16, tail: 18, withHub: false });
    needle(c, (-90 + ((s / 60) % 60) * 6) * DEG, 152, { width: 11, tail: 22, withHub: false });
    c.save(); c.rotate((-90 + Math.floor(s % 60) * 6) * DEG);
    c.strokeStyle = C.red; c.lineWidth = 3; c.beginPath(); c.moveTo(-32, 0); c.lineTo(172, 0); c.stroke(); c.restore();
    hub(c, 10);
  };

  function drawGauge(ctx, w, h, type, options, V) {
    ctx.clearRect(0, 0, w, h);
    const s = Math.min(w, h) / (2 * R);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(s, s);
    caseAndFace(ctx);
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, FACE, 0, Math.PI * 2); ctx.clip();
    const fn = G[type];
    if (fn) fn(ctx, options || {}, V);
    else text(ctx, `unknown: ${type}`, 0, 0, 22, C.red);
    ctx.restore();
    glass(ctx);
    if (!V.live) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(0, 0, FACE, 0, Math.PI * 2); ctx.fill();
      text(ctx, 'NO DATA', 0, 40, 22, '#ff8a80');
    }
    ctx.restore();
  }

  window.CockpitGauges = { drawGauge };
})();
