// Base for all gauges: each gauge draws in a 400 x 400 space centred on (0,0), scaled to fit its box.
// Look: square dark backing plate with corner screws, metal bezel ring, matte face (radius kFaceR),
// glass reflection on top. The static face is recorded once (and again when [faceKey] changes);
// moving parts are drawn every frame.

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:material_ui/material_ui.dart';

import 'gauge_values.dart';

const double kR = 200; // half the gauge box, in gauge units
const double kFaceR = 186; // visible face radius inside the bezel ring

abstract class GaugePainter extends CustomPainter {
  GaugePainter(this.values, this.options, Listenable repaint) : super(repaint: repaint);

  final GaugeValues values;
  final Map<String, dynamic> options;

  ui.Picture? _face;
  Size? _faceSize;
  String? _faceKey;

  /// Static parts, in gauge units (called rarely).
  void drawFace(Canvas c);

  /// Moving parts, in gauge units (called every frame).
  void drawDynamic(Canvas c);

  /// Parts drawn over the moving parts (fixed symbols); default none.
  void drawTop(Canvas c) {}

  /// Anything the static face depends on besides size and options (e.g. V-speeds from the sim).
  String faceKey() => '';

  @override
  void paint(Canvas canvas, Size size) {
    final s = math.min(size.width, size.height) / (2 * kR);
    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    canvas.scale(s);
    final key = faceKey();
    if (_face == null || _faceSize != size || _faceKey != key) {
      final rec = ui.PictureRecorder();
      final c = Canvas(rec);
      _drawCase(c);
      drawFace(c);
      _face?.dispose();
      _face = rec.endRecording();
      _faceSize = size;
      _faceKey = key;
    }
    canvas.drawPicture(_face!);
    canvas.save();
    canvas.clipPath(Path()..addOval(Rect.fromCircle(center: Offset.zero, radius: kFaceR)));
    drawDynamic(canvas);
    drawTop(canvas);
    canvas.restore();
    _drawGlass(canvas);
    if (!values.live) _offFlag(canvas);
    canvas.restore();
  }

  void _drawCase(Canvas c) {
    // Backing plate with rounded corners and four screws.
    c.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTRB(-kR, -kR, kR, kR), const Radius.circular(26)), Paint()..color = const Color(0xFF1A1B1D));
    for (final p in const [Offset(-176, -176), Offset(176, -176), Offset(-176, 176), Offset(176, 176)]) {
      c.drawCircle(p, 11, Paint()
        ..shader = ui.Gradient.radial(p - const Offset(3, 3), 12, const [Color(0xFF6A6C70), Color(0xFF2A2B2E)]));
      c.drawLine(p + const Offset(-7, 4), p + const Offset(7, -4), Paint()
        ..color = const Color(0xFF151517)
        ..strokeWidth = 2.5);
    }
    // Bezel ring: brushed dark metal.
    c.drawCircle(Offset.zero, kR - 2, Paint()
      ..shader = ui.Gradient.linear(const Offset(-150, -150), const Offset(150, 150), const [Color(0xFF5A5C60), Color(0xFF202124), Color(0xFF3C3E42)], const [0, 0.55, 1]));
    c.drawCircle(Offset.zero, kFaceR + 3, Paint()..color = const Color(0xFF060607));
    // Matte face, very slightly lighter towards the centre.
    c.drawCircle(Offset.zero, kFaceR, Paint()
      ..shader = ui.Gradient.radial(Offset.zero, kFaceR, const [Color(0xFF1C1D20), Color(0xFF0D0D0F)]));
  }

  void _drawGlass(Canvas c) {
    // Soft reflection across the upper left of the cover glass.
    c.drawCircle(Offset.zero, kFaceR, Paint()
      ..shader = ui.Gradient.linear(const Offset(-120, -170), const Offset(60, 40), const [Color(0x16FFFFFF), Color(0x00FFFFFF)]));
    // Inner shadow at the rim.
    c.drawCircle(Offset.zero, kFaceR - 6, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 12
      ..color = const Color(0x40000000));
  }

  void _offFlag(Canvas c) {
    c.drawCircle(Offset.zero, kFaceR, Paint()..color = const Color(0xA0000000));
    drawText(c, 'NO DATA', Offset.zero, 26, color: const Color(0xFFFF5050));
  }

  @override
  bool shouldRepaint(covariant GaugePainter old) => old.options != options;

  // ---- option helpers ----
  double opt(String k, double d) => (options[k] as num?)?.toDouble() ?? d;
  String optS(String k, String d) => (options[k] as String?) ?? d;
  List<double>? range(String k) {
    final r = options[k];
    if (r is List && r.length == 2) return [(r[0] as num).toDouble(), (r[1] as num).toDouble()];
    return null;
  }
}

// ---- colours ----

const Color kFace = Color(0xFF111214);
const Color kWhite = Color(0xFFF0EEE8); // slightly warm, like painted markings
const Color kGrey = Color(0xFFA8A8A8);
const Color kGreen = Color(0xFF1FAE4B);
const Color kYellow = Color(0xFFF2C21B);
const Color kRed = Color(0xFFE0322B);
const Color kNeedle = Color(0xFFF4F2EC);
const Color kOrange = Color(0xFFF08A1C);

Color namedColor(String? name) {
  switch (name) {
    case 'green':
      return kGreen;
    case 'yellow':
      return kYellow;
    case 'red':
      return kRed;
    case 'white':
      return kWhite;
    case 'blue':
      return const Color(0xFF3B82F6);
    default:
      return kWhite;
  }
}

// ---- drawing helpers (gauge units) ----

/// Angle in radians for a value on a dial; 0 rad points right, angles grow clockwise (screen space).
double dialAngle(double v, double min, double max, double startDeg, double sweepDeg) {
  final f = ((v - min) / (max - min)).clamp(-0.02, 1.02);
  return (startDeg + sweepDeg * f) * math.pi / 180;
}

Offset polar(double r, double a) => Offset(r * math.cos(a), r * math.sin(a));

void drawTick(Canvas c, double a, double r1, double r2, double width, [Color color = kWhite]) {
  c.drawLine(polar(r1, a), polar(r2, a), Paint()
    ..color = color
    ..strokeWidth = width
    ..strokeCap = StrokeCap.butt);
}

void drawArc(Canvas c, double r, double a1, double a2, double width, Color color) {
  c.drawArc(Rect.fromCircle(center: Offset.zero, radius: r), a1, a2 - a1, false, Paint()
    ..color = color
    ..style = PaintingStyle.stroke
    ..strokeWidth = width);
}

void drawText(Canvas c, String s, Offset at, double size, {Color color = kWhite, FontWeight weight = FontWeight.w700, double spacing = 0}) {
  final tp = TextPainter(
    text: TextSpan(text: s, style: TextStyle(color: color, fontSize: size, fontWeight: weight, height: 1.0, letterSpacing: spacing)),
    textDirection: TextDirection.ltr,
    textAlign: TextAlign.center,
  )..layout();
  tp.paint(c, at - Offset(tp.width / 2, tp.height / 2));
}

/// Needle from the centre to radius [len], at angle [a], with a soft shadow and a hub cap.
void drawNeedle(Canvas c, double a, double len, {double width = 12, double tail = 30, Color color = kNeedle, bool hub = true}) {
  final p = Path()
    ..moveTo(-tail, -width / 2)
    ..lineTo(len - 22, -width / 2.4)
    ..lineTo(len, 0)
    ..lineTo(len - 22, width / 2.4)
    ..lineTo(-tail, width / 2)
    ..close();
  c.save();
  c.translate(5, 7);
  c.rotate(a);
  c.drawPath(p, Paint()
    ..color = const Color(0x66000000)
    ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4));
  c.restore();
  c.save();
  c.rotate(a);
  c.drawPath(p, Paint()..color = color);
  c.restore();
  if (hub) drawHub(c, width);
}

void drawHub(Canvas c, double width) {
  c.drawCircle(Offset.zero, width * 1.15, Paint()
    ..shader = ui.Gradient.radial(const Offset(-3, -3), width * 1.2, const [Color(0xFF4A4B4F), Color(0xFF141416)]));
}

String fmtNum(double v, int decimals) => decimals <= 0 ? v.round().toString() : v.toStringAsFixed(decimals);
