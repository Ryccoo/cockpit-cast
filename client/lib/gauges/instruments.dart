// KEEP IN SYNC with the layout editor's browser copy: host/public/gauges.js (same design and maths).
// The gauge library. Each type is a painter working in a 400 x 400 space (see gauge_base.dart).
// Types (layout "type" field): asi, attitude, altimeter, turn, heading, vsi, dial, cdi, adf, clock.
// Values come from GaugeValues by the keys in host/src/simvars.mjs.

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:material_ui/material_ui.dart';

import 'gauge_base.dart';
import 'gauge_values.dart';

GaugePainter? makeGauge(String type, GaugeValues v, Map<String, dynamic> o, Listenable repaint) {
  switch (type) {
    case 'asi':
      return AirspeedGauge(v, o, repaint);
    case 'attitude':
      return AttitudeGauge(v, o, repaint);
    case 'altimeter':
      return AltimeterGauge(v, o, repaint);
    case 'turn':
      return TurnCoordinatorGauge(v, o, repaint);
    case 'heading':
      return HeadingGauge(v, o, repaint);
    case 'vsi':
      return VsiGauge(v, o, repaint);
    case 'dial':
      return DialGauge(v, o, repaint);
    case 'cdi':
      return CdiGauge(v, o, repaint);
    case 'adf':
      return AdfGauge(v, o, repaint);
    case 'clock':
      return ClockGauge(v, o, repaint);
  }
  return null;
}

const double _deg = math.pi / 180;

String _compassLabel(int d) => switch (d) { 0 => 'N', 90 => 'E', 180 => 'S', 270 => 'W', _ => '${d ~/ 10}' };

double _round5(double v) => (v / 5).round() * 5.0;

// ---------------- airspeed ----------------
// Arcs come from the sim: white Vs0..Vfe, green Vs1..Vno, yellow Vno..Vne, red line at Vne.
// Vs0, Vs1, Vne: SimVars. Vfe, Vno: host aircraft profile, else estimated (marked "EST").
// Options override any of them: white [a,b], green [a,b], yellow [a,b], vne, max.
class AirspeedGauge extends GaugePainter {
  AirspeedGauge(super.values, super.options, super.repaint);

  late double _max;
  late double _low; // first labelled speed; below it the scale is compressed

  ({double vs0, double vs1, double vfe, double vno, double vne, bool estimated}) speeds() {
    final vs0 = values.get('vs0'), vs1 = values.get('vs1'), vne = values.get('vne');
    var estimated = false;
    var vfe = values.get('vfe');
    if (vfe <= 0 && vs0 > 0) {
      vfe = _round5(vs0 * 2.1);
      estimated = true;
    }
    var vno = values.get('vno');
    if (vno <= 0 && vne > 0) {
      vno = _round5(vne / 1.25);
      estimated = true;
    }
    return (vs0: vs0, vs1: vs1, vfe: vfe, vno: vno, vne: vne, estimated: estimated);
  }

  @override
  String faceKey() {
    final s = speeds();
    return '${s.vs0.round()},${s.vs1.round()},${s.vfe.round()},${s.vno.round()},${s.vne.round()}';
  }

  // 0 at the top; [_low] a little clockwise of it; linear from there to [_max] over most of the dial.
  double a(double v) {
    if (v <= _low) return (-90 + (v / _low).clamp(0.0, 1.0) * 28) * _deg;
    return (-62 + ((v - _low) / (_max - _low)).clamp(0.0, 1.02) * 300) * _deg;
  }

  void _scale() {
    final vne = range('green') != null ? opt('vne', values.get('vne')) : values.get('vne');
    _max = opt('max', vne > 0 ? math.max(160, ((vne * 1.18) / 20).ceil() * 20.0) : 200);
    _low = opt('low', _max > 260 ? 60 : 40);
  }

  @override
  void drawFace(Canvas c) {
    _scale();
    final s = speeds();
    final white = range('white') ?? (s.vs0 > 0 && s.vfe > 0 ? [s.vs0, s.vfe] : null);
    final green = range('green') ?? (s.vs1 > 0 && s.vno > 0 ? [s.vs1, s.vno] : null);
    final yellow = range('yellow') ?? (s.vno > 0 && s.vne > 0 ? [s.vno, s.vne] : null);
    final vne = options['vne'] != null ? opt('vne', 0) : s.vne;
    if (white != null) drawArc(c, 150, a(white[0]), a(white[1]), 10, kWhite);
    if (green != null) drawArc(c, 164, a(green[0]), a(green[1]), 15, kGreen);
    if (yellow != null) drawArc(c, 164, a(yellow[0]), a(yellow[1]), 15, kYellow);
    if (vne > 0) drawTick(c, a(vne), 146, 184, 6, kRed);
    final major = _max > 260 ? 20.0 : 10.0;
    for (var v = _low; v <= _max + 0.1; v += major / 2) {
      final isMajor = (v - _low) % major == 0;
      drawTick(c, a(v), isMajor ? 158 : 170, 184, isMajor ? 4.5 : 2.5);
    }
    for (var v = _low; v <= _max + 0.1; v += major * 2) {
      drawText(c, v.round().toString(), polar(124, a(v)), 30);
    }
    drawText(c, 'AIRSPEED', const Offset(0, -62), 19, spacing: 1);
    drawText(c, 'KNOTS', const Offset(0, 60), 19, spacing: 1);
    if (s.estimated && range('white') == null) drawText(c, 'EST', const Offset(0, 92), 13, color: kGrey);
  }

  @override
  void drawDynamic(Canvas c) {
    _scale();
    drawNeedle(c, a(math.max(0, values.get('ias'))), 168);
  }
}

// ---------------- attitude ----------------
// Like a real gyro horizon: the bank scale ring turns with the horizon card, a fixed orange index at
// the top reads it, and the orange miniature aircraft is fixed.
class AttitudeGauge extends GaugePainter {
  AttitudeGauge(super.values, super.options, super.repaint);

  static const double pxPerDeg = 5.2;
  static const double ringR = 150; // inner edge of the bank ring
  static const Color sky = Color(0xFF2F78C8), skyDark = Color(0xFF1F5A9C);
  static const Color ground = Color(0xFF6E4320), groundDark = Color(0xFF4E2F16);

  @override
  void drawFace(Canvas c) {}

  @override
  void drawDynamic(Canvas c) {
    // The sim reports nose-up pitch and right bank as negative numbers.
    final pitchUp = -values.get('pitch');
    final rollRight = -values.get('bank');
    c.save();
    c.rotate(-rollRight * _deg);

    // Outer bank ring: sky over ground, turning with the horizon.
    c.drawArc(Rect.fromCircle(center: Offset.zero, radius: kFaceR), math.pi, math.pi, true, Paint()..color = skyDark);
    c.drawArc(Rect.fromCircle(center: Offset.zero, radius: kFaceR), 0, math.pi, true, Paint()..color = groundDark);
    for (final b in const [-60, -30, -20, -10, 10, 20, 30, 60]) {
      final big = b.abs() == 30 || b.abs() == 60;
      drawTick(c, (-90 + b) * _deg, ringR + 4, big ? 184 : 172, big ? 5 : 3);
    }
    for (final b in const [-45, 45]) {
      final p = polar(176, (-90 + b) * _deg);
      c.save();
      c.translate(p.dx, p.dy);
      c.rotate(b * _deg);
      c.drawPath(Path()
        ..moveTo(0, 8)
        ..lineTo(-7, -6)
        ..lineTo(7, -6)
        ..close(), Paint()..color = kWhite);
      c.restore();
    }
    // Zero index (sky pointer) on the ring.
    c.drawPath(Path()
      ..moveTo(0, -ringR - 4)
      ..lineTo(-12, -180)
      ..lineTo(12, -180)
      ..close(), Paint()..color = kWhite);

    // Inner pitch card, moving with pitch.
    c.save();
    c.clipPath(Path()..addOval(Rect.fromCircle(center: Offset.zero, radius: ringR)));
    c.translate(0, pitchUp.clamp(-30.0, 30.0) * pxPerDeg);
    c.drawRect(const Rect.fromLTRB(-400, -600, 400, 0), Paint()
      ..shader = ui.Gradient.linear(const Offset(0, -160), Offset.zero, const [skyDark, sky]));
    c.drawRect(const Rect.fromLTRB(-400, 0, 400, 600), Paint()
      ..shader = ui.Gradient.linear(Offset.zero, const Offset(0, 160), const [ground, groundDark]));
    c.drawLine(const Offset(-400, 0), const Offset(400, 0), Paint()
      ..color = kWhite
      ..strokeWidth = 3);
    for (var p = -20; p <= 20; p += 5) {
      if (p == 0) continue;
      final y = -p * pxPerDeg;
      final half = p % 10 == 0 ? 46.0 : 20.0;
      c.drawLine(Offset(-half, y), Offset(half, y), Paint()
        ..color = kWhite
        ..strokeWidth = 2.5);
      if (p % 10 == 0) {
        drawText(c, '${p.abs()}', Offset(-half - 18, y), 15);
        drawText(c, '${p.abs()}', Offset(half + 18, y), 15);
      }
    }
    c.restore();
    c.restore();

    // Ring edge shadow.
    c.drawCircle(Offset.zero, ringR, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..color = const Color(0x80000000));
  }

  @override
  void drawTop(Canvas c) {
    // Fixed bank index at the top.
    c.drawPath(Path()
      ..moveTo(0, -ringR - 6)
      ..lineTo(-13, -kFaceR + 2)
      ..lineTo(13, -kFaceR + 2)
      ..close(), Paint()..color = kOrange);
    // Fixed miniature aircraft.
    final shadow = Paint()
      ..color = const Color(0x66000000)
      ..strokeWidth = 9
      ..strokeCap = StrokeCap.round
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3);
    final p = Paint()
      ..color = kOrange
      ..strokeWidth = 8
      ..strokeCap = StrokeCap.round;
    for (final paint in [shadow, p]) {
      final o = paint == shadow ? const Offset(3, 4) : Offset.zero;
      c.drawLine(const Offset(-112, 0) + o, const Offset(-44, 0) + o, paint);
      c.drawLine(const Offset(44, 0) + o, const Offset(112, 0) + o, paint);
      c.drawLine(const Offset(-44, 0) + o, const Offset(-18, 18) + o, paint);
      c.drawLine(const Offset(44, 0) + o, const Offset(18, 18) + o, paint);
      c.drawLine(const Offset(-18, 18) + o, const Offset(18, 18) + o, paint);
    }
    c.drawCircle(Offset.zero, 6, Paint()..color = kOrange);
    // Lower case of the instrument (fixed), as on real gyro horizons.
    final lower = Path()
      ..addArc(Rect.fromCircle(center: Offset.zero, radius: kFaceR), 35 * _deg, 110 * _deg)
      ..close();
    c.drawPath(lower, Paint()..color = const Color(0xFF151517));
    drawText(c, 'ATTITUDE', const Offset(0, 150), 13, color: kGrey, spacing: 1);
  }
}

// ---------------- altimeter ----------------
class AltimeterGauge extends GaugePainter {
  AltimeterGauge(super.values, super.options, super.repaint);

  double a(double digit) => (-90 + digit * 36) * _deg;

  @override
  void drawFace(Canvas c) {
    for (var i = 0; i < 50; i++) {
      final major = i % 5 == 0;
      drawTick(c, (-90 + i * 7.2) * _deg, major ? 158 : 171, 184, major ? 4.5 : 2.5);
    }
    for (var d = 0; d < 10; d++) {
      drawText(c, '$d', polar(132, a(d.toDouble())), 38);
    }
    drawText(c, 'ALT', const Offset(0, -64), 19, spacing: 1);
    drawText(c, '100 FEET', const Offset(0, -40), 13, color: kGrey, spacing: 1);
    drawText(c, 'IN HG', const Offset(100, -32), 11, color: kGrey);
    // Kollsman window
    c.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(62, -18, 80, 36), const Radius.circular(4)), Paint()..color = const Color(0xFF000000));
  }

  @override
  void drawDynamic(Canvas c) {
    final alt = values.get('alt');
    c.save();
    c.clipRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(64, -16, 76, 32), const Radius.circular(3)));
    c.drawRect(const Rect.fromLTWH(64, -16, 76, 32), Paint()..color = const Color(0xFFE9E6DC));
    drawText(c, values.get('baro', 29.92).toStringAsFixed(2), const Offset(102, 0), 21, color: const Color(0xFF111111));
    c.restore();
    // 10,000 ft: thin pointer with a triangle at the rim
    final a10k = a(alt / 10000);
    c.save();
    c.rotate(a10k);
    c.drawLine(Offset.zero, const Offset(170, 0), Paint()
      ..color = kNeedle
      ..strokeWidth = 3);
    c.drawPath(Path()
      ..moveTo(184, 0)
      ..lineTo(162, -11)
      ..lineTo(162, 11)
      ..close(), Paint()..color = kNeedle);
    c.restore();
    drawNeedle(c, a((alt % 10000) / 1000), 100, width: 20, tail: 16, hub: false); // 1,000 ft
    drawNeedle(c, a((alt % 1000) / 100), 166, width: 11, tail: 30); // 100 ft
  }
}

// ---------------- turn coordinator ----------------
class TurnCoordinatorGauge extends GaugePainter {
  TurnCoordinatorGauge(super.values, super.options, super.repaint);

  static const Offset tubeC = Offset(0, -330);
  static const double tubeR = 430;

  @override
  void drawFace(Canvas c) {
    // Standard-rate marks (20 degrees) and wings-level marks.
    for (final m in const [-20.0, 0.0, 20.0]) {
      drawTick(c, (180 + m) * _deg, 148, 180, 7);
      drawTick(c, (-m) * _deg, 148, 180, 7);
    }
    drawText(c, 'L', polar(128, 160 * _deg) + const Offset(0, 14), 26);
    drawText(c, 'R', polar(128, 20 * _deg) + const Offset(0, 14), 26);
    drawText(c, 'TURN COORDINATOR', const Offset(0, -118), 16, spacing: 1);
    drawText(c, '2 MIN', const Offset(0, 158), 15, color: kGrey);
    drawText(c, 'D.C. ELEC.', const Offset(0, -92), 11, color: kGrey, spacing: 0.5);
    drawText(c, 'NO PITCH INFORMATION', const Offset(0, 62), 11, color: kGrey, spacing: 0.5);
    // Inclinometer: glass tube with liquid.
    final tube = Path()..addArc(Rect.fromCircle(center: tubeC, radius: tubeR), 76 * _deg, 28 * _deg);
    c.drawPath(tube, Paint()
      ..color = const Color(0xFF050505)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 40
      ..strokeCap = StrokeCap.round);
    c.drawPath(tube, Paint()
      ..shader = ui.Gradient.linear(const Offset(0, 80), const Offset(0, 122), const [Color(0xFFDCE3D2), Color(0xFF9EA693)])
      ..style = PaintingStyle.stroke
      ..strokeWidth = 32
      ..strokeCap = StrokeCap.round);
  }

  @override
  void drawDynamic(Canvas c) {
    var ball = values.get('ball');
    if (ball.abs() > 1.5) ball /= 127; // some aircraft report -127..127
    final ballAng = (90 - ball.clamp(-1.0, 1.0) * 12) * _deg;
    final bp = tubeC + polar(tubeR, ballAng);
    c.drawCircle(bp, 15, Paint()
      ..shader = ui.Gradient.radial(bp - const Offset(4, 4), 16, const [Color(0xFF555555), Color(0xFF050505)]));
    // Reference wires over the tube.
    for (final x in const [-19.0, 19.0]) {
      c.drawLine(Offset(x, 84), Offset(x, 120), Paint()
        ..color = const Color(0xFF111111)
        ..strokeWidth = 3);
    }
    // Miniature aircraft (rear view): 3 deg/s (standard rate) tilts it to the 20-degree mark.
    final tilt = (values.get('turnRate') / 3 * 20).clamp(-35.0, 35.0);
    c.save();
    c.rotate(tilt * _deg);
    final shadow = Paint()
      ..color = const Color(0x66000000)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3);
    final white = Paint()..color = kWhite;
    for (final paint in [shadow, white]) {
      final o = paint == shadow ? const Offset(4, 5) : Offset.zero;
      c.drawRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: o, width: 268, height: 12), const Radius.circular(6)), paint);
      c.drawRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: const Offset(0, -18) + o, width: 9, height: 36), const Radius.circular(4)), paint);
      c.drawRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: const Offset(0, -6) + o, width: 70, height: 8), const Radius.circular(4)), paint);
      c.drawCircle(o, 20, paint);
    }
    c.restore();
    // OFF flag only when we know the power is off (battery master off); bus voltage SimVars are not
    // reliable across aircraft.
    if (values.live && values.knows('battMaster') && values.get('battMaster') < 0.5) {
      c.drawRect(const Rect.fromLTWH(60, 30, 56, 26), Paint()..color = kRed);
      drawText(c, 'OFF', const Offset(88, 43), 16, color: kWhite);
    }
  }
}

// ---------------- heading indicator ----------------
class HeadingGauge extends GaugePainter {
  HeadingGauge(super.values, super.options, super.repaint);

  @override
  void drawFace(Canvas c) {}

  @override
  void drawDynamic(Canvas c) {
    final hdg = values.get('hdg');
    c.save();
    c.rotate(-hdg * _deg);
    for (var d = 0; d < 360; d += 5) {
      final major = d % 10 == 0;
      drawTick(c, (d - 90) * _deg, major ? 152 : 166, 180, major ? 4.5 : 2.5);
    }
    for (var d = 0; d < 360; d += 30) {
      c.save();
      c.rotate(d * _deg);
      drawText(c, _compassLabel(d), const Offset(0, -124), d % 90 == 0 ? 38 : 30);
      c.restore();
    }
    // Heading bug on the card edge.
    c.save();
    c.rotate(values.get('hdgBug') * _deg);
    c.drawPath(Path()
      ..moveTo(-18, -184)
      ..lineTo(18, -184)
      ..lineTo(18, -166)
      ..lineTo(8, -166)
      ..lineTo(0, -174)
      ..lineTo(-8, -166)
      ..lineTo(-18, -166)
      ..close(), Paint()..color = kOrange);
    c.restore();
    c.restore();
  }

  @override
  void drawTop(Canvas c) {
    // Fixed 45-degree marks and lubber line on the bezel.
    for (var m = 45; m < 360; m += 45) {
      if (m == 180) continue;
      c.save();
      c.rotate(m * _deg);
      c.drawPath(Path()
        ..moveTo(0, -170)
        ..lineTo(-7, -184)
        ..lineTo(7, -184)
        ..close(), Paint()..color = kWhite);
      c.restore();
    }
    c.drawPath(Path()
      ..moveTo(0, -150)
      ..lineTo(-12, -184)
      ..lineTo(12, -184)
      ..close(), Paint()..color = kOrange);
    // Fixed aircraft symbol.
    final p = Paint()
      ..color = kOrange
      ..strokeWidth = 9
      ..strokeCap = StrokeCap.round;
    c.drawLine(const Offset(0, -64), const Offset(0, 62), p);
    c.drawLine(const Offset(-62, -6), const Offset(62, -6), p);
    c.drawLine(const Offset(-24, 50), const Offset(24, 50), p..strokeWidth = 7);
  }
}

// ---------------- vertical speed ----------------
class VsiGauge extends GaugePainter {
  VsiGauge(super.values, super.options, super.repaint);

  double get max => opt('max', 2000);
  // 0 at 9 o'clock; +max clockwise to about 3 o'clock, -max counter-clockwise.
  double a(double v) => (180 + (v / max).clamp(-1.02, 1.02) * 170) * _deg;

  @override
  void drawFace(Canvas c) {
    final step = max / 20;
    for (var i = -20; i <= 20; i++) {
      final major = i % 5 == 0;
      drawTick(c, a(i * step), major ? 156 : 170, 184, major ? 4.5 : 2.5);
    }
    for (var i = -4; i <= 4; i++) {
      if (i == 0) continue;
      final v = i * max / 4;
      drawText(c, '${(v.abs() / 100).round()}', polar(128, a(v)), 32);
    }
    drawText(c, '0', polar(128, a(0)), 32);
    drawText(c, 'UP', const Offset(-58, -56), 18);
    drawText(c, 'DOWN', const Offset(-58, 56), 18);
    drawText(c, 'VERTICAL SPEED', const Offset(28, -20), 13, color: kGrey, spacing: 0.5);
    drawText(c, '100 FEET PER MINUTE', const Offset(28, 20), 11, color: kGrey);
  }

  @override
  void drawDynamic(Canvas c) => drawNeedle(c, a(values.get('vs')), 170);
}

// ---------------- generic dial (engine gauges and anything else) ----------------
// options: var, label, sublabel, min, max, majorStep, minorStep, labelScale, decimals, arcs[{from,to,color}],
//          redlineVar (draw a red line at that value from the sim, e.g. maxRpm), showValue (default true)
class DialGauge extends GaugePainter {
  DialGauge(super.values, super.options, super.repaint);

  static const double start = 150, sweep = 240;
  double get min => opt('min', 0);
  double get max => opt('max', 100);
  double a(double v) => dialAngle(v, min, max, start, sweep);

  double get redline {
    final k = options['redlineVar'];
    return k is String ? values.get(k) : 0;
  }

  @override
  String faceKey() => '${redline.round()}';

  @override
  void drawFace(Canvas c) {
    final arcs = options['arcs'];
    if (arcs is List) {
      for (final arc in arcs) {
        if (arc is! Map) continue;
        final from = (arc['from'] as num?)?.toDouble() ?? min, to = (arc['to'] as num?)?.toDouble() ?? max;
        drawArc(c, 164, a(from), a(to), 17, namedColor(arc['color'] as String?));
      }
    }
    if (redline > 0) drawTick(c, a(redline), 146, 184, 7, kRed);
    final major = opt('majorStep', (max - min) / 5), minor = opt('minorStep', 0);
    if (minor > 0) {
      for (var v = min; v <= max + 1e-6; v += minor) {
        drawTick(c, a(v), 170, 184, 2.5);
      }
    }
    final scale = opt('labelScale', 1);
    final labelDecimals = (major * scale) % 1 == 0 ? 0 : 1;
    for (var v = min; v <= max + 1e-6; v += major) {
      drawTick(c, a(v), 152, 184, 5);
      drawText(c, fmtNum(v * scale, labelDecimals), polar(120, a(v)), 30);
    }
    drawText(c, optS('label', ''), const Offset(0, -66), 26, spacing: 0.5);
    drawText(c, optS('sublabel', ''), const Offset(0, -38), 20, color: kGrey);
  }

  @override
  void drawDynamic(Canvas c) {
    final v = values.get(optS('var', ''));
    if (options['showValue'] != false) {
      c.drawRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: const Offset(0, 102), width: 120, height: 44), const Radius.circular(5)),
          Paint()..color = const Color(0xFF050506));
      drawText(c, fmtNum(v, (options['decimals'] as num?)?.toInt() ?? 0), const Offset(0, 102), 32, color: const Color(0xFFE8E2D0));
    }
    drawNeedle(c, a(v), 170);
  }
}

// ---------------- VOR / ILS (CDI) ----------------
// options: nav (1 or 2)
class CdiGauge extends GaugePainter {
  CdiGauge(super.values, super.options, super.repaint);

  String get n => '${opt('nav', 1).round()}';

  @override
  void drawFace(Canvas c) {
    final dot = Paint()
      ..color = kWhite
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.5;
    for (var i = -5; i <= 5; i++) {
      if (i == 0) continue;
      c.drawCircle(Offset(i * 22.0, 0), 5, dot);
      c.drawCircle(Offset(0, i * 22.0), 5, dot);
    }
    c.drawCircle(Offset.zero, 24, dot..strokeWidth = 3);
  }

  @override
  void drawDynamic(Canvas c) {
    final obs = values.get('nav${n}Obs');
    c.save();
    c.rotate(-obs * _deg);
    for (var d = 0; d < 360; d += 5) {
      final major = d % 10 == 0;
      drawTick(c, (d - 90) * _deg, major ? 158 : 168, 182, major ? 4 : 2.5);
    }
    for (var d = 0; d < 360; d += 30) {
      c.save();
      c.rotate(d * _deg);
      drawText(c, _compassLabel(d), const Offset(0, -136), 26);
      c.restore();
    }
    c.restore();
    // OBS index at the top and reciprocal at the bottom.
    c.drawPath(Path()
      ..moveTo(0, -156)
      ..lineTo(-12, -182)
      ..lineTo(12, -182)
      ..close(), Paint()..color = kWhite);
    c.drawPath(Path()
      ..moveTo(0, 158)
      ..lineTo(-9, 180)
      ..lineTo(9, 180)
      ..close(), Paint()..color = kWhite);
    drawText(c, 'VOR $n', const Offset(-84, -84), 17, color: kGrey);

    final hasNav = values.flag('nav${n}HasNav');
    // Deviation needle: CDI -127..127 = full scale (5 dots).
    final dev = (values.get('nav${n}Cdi') / 127).clamp(-1.0, 1.0) * 110;
    final needle = Paint()
      ..color = kWhite
      ..strokeWidth = 7
      ..strokeCap = StrokeCap.round;
    c.drawLine(Offset(dev + 3, -116), Offset(dev + 3, 124), Paint()
      ..color = const Color(0x55000000)
      ..strokeWidth = 7);
    c.drawLine(Offset(dev, -120), Offset(dev, 120), needle);
    if (values.flag('nav${n}HasGs')) {
      final gs = (values.get('nav${n}Gsi') / 127).clamp(-1.0, 1.0) * 110;
      c.drawLine(Offset(-120, -gs), Offset(120, -gs), needle);
    }
    final toFrom = values.get('nav${n}ToFrom').round(); // 0 off, 1 to, 2 from
    if (!hasNav || toFrom == 0) {
      c.save();
      c.clipRect(const Rect.fromLTWH(44, 40, 66, 32));
      c.drawRect(const Rect.fromLTWH(44, 40, 66, 32), Paint()..color = kRed);
      for (var x = 30.0; x < 130; x += 14) {
        c.drawLine(Offset(x, 40), Offset(x + 20, 72), Paint()
          ..color = kWhite
          ..strokeWidth = 5);
      }
      c.restore();
      drawText(c, 'NAV', const Offset(77, 88), 16, color: kRed);
    } else {
      final up = toFrom == 1;
      c.drawPath(Path()
        ..moveTo(77, up ? 40 : 72)
        ..lineTo(56, up ? 70 : 42)
        ..lineTo(98, up ? 70 : 42)
        ..close(), Paint()..color = kWhite);
      drawText(c, up ? 'TO' : 'FR', const Offset(77, 88), 16);
    }
  }
}

// ---------------- ADF ----------------
class AdfGauge extends GaugePainter {
  AdfGauge(super.values, super.options, super.repaint);

  @override
  void drawFace(Canvas c) {}

  @override
  void drawDynamic(Canvas c) {
    final card = values.get('adfCard');
    c.save();
    c.rotate(-card * _deg);
    for (var d = 0; d < 360; d += 5) {
      final major = d % 10 == 0;
      drawTick(c, (d - 90) * _deg, major ? 158 : 168, 182, major ? 4 : 2.5);
    }
    for (var d = 0; d < 360; d += 30) {
      c.save();
      c.rotate(d * _deg);
      drawText(c, _compassLabel(d), const Offset(0, -134), 28);
      c.restore();
    }
    c.restore();
    drawText(c, 'ADF', const Offset(0, -72), 17, color: kGrey, spacing: 1);
    // Needle: relative bearing to the station; parks at 90 degrees without a signal.
    final hasSignal = values.get('adfSignal') > 0;
    final rel = hasSignal ? values.get('adfRadial') : 90.0;
    drawNeedle(c, (rel - 90) * _deg, 166, width: 14, tail: 150, color: kYellow);
  }

  @override
  void drawTop(Canvas c) {
    for (var m = 45; m < 360; m += 45) {
      c.save();
      c.rotate(m * _deg);
      c.drawPath(Path()
        ..moveTo(0, -172)
        ..lineTo(-6, -184)
        ..lineTo(6, -184)
        ..close(), Paint()..color = kWhite);
      c.restore();
    }
    c.drawPath(Path()
      ..moveTo(0, -152)
      ..lineTo(-11, -184)
      ..lineTo(11, -184)
      ..close(), Paint()..color = kOrange);
    final w = Paint()
      ..color = kOrange
      ..strokeWidth = 7
      ..strokeCap = StrokeCap.round;
    c.drawLine(const Offset(0, -44), const Offset(0, 44), w);
    c.drawLine(const Offset(-44, -4), const Offset(44, -4), w);
    c.drawLine(const Offset(-16, 36), const Offset(16, 36), w..strokeWidth = 5);
  }
}

// ---------------- clock ----------------
// options: zone ("local" or "zulu")
class ClockGauge extends GaugePainter {
  ClockGauge(super.values, super.options, super.repaint);

  @override
  void drawFace(Canvas c) {
    for (var i = 0; i < 60; i++) {
      final major = i % 5 == 0;
      drawTick(c, (-90 + i * 6) * _deg, major ? 158 : 172, 184, major ? 5 : 2.5);
    }
    for (var h = 1; h <= 12; h++) {
      drawText(c, '$h', polar(130, (-90 + h * 30) * _deg), 34);
    }
    drawText(c, optS('zone', 'local') == 'zulu' ? 'UTC' : 'LOCAL', const Offset(0, 62), 17, color: kGrey, spacing: 1);
  }

  @override
  void drawDynamic(Canvas c) {
    final secs = values.get(optS('zone', 'local') == 'zulu' ? 'zuluTime' : 'localTime');
    final h = (secs / 3600) % 12, m = (secs / 60) % 60, s = secs % 60;
    drawNeedle(c, (-90 + h * 30) * _deg, 96, width: 16, tail: 18, hub: false);
    drawNeedle(c, (-90 + m * 6) * _deg, 152, width: 11, tail: 22, hub: false);
    c.save();
    c.rotate((-90 + s.floorToDouble() * 6) * _deg);
    c.drawLine(const Offset(-32, 0), const Offset(172, 0), Paint()
      ..color = kRed
      ..strokeWidth = 3);
    c.restore();
    drawHub(c, 10);
  }
}
