// Latest gauge data from the host, smoothed for drawing at the screen's frame rate.
//
// Samples arrive at up to 30-60 Hz, unevenly. Drawing uses a point slightly in the past (one sample
// interval) and interpolates between the two samples around it, so needles move smoothly instead of
// stepping. Angles (headings, bearings) interpolate the short way round.

import 'dart:math' as math;

import 'package:material_ui/material_ui.dart';

class GaugeValues extends ChangeNotifier {
  static const _angular = {'hdg', 'hdgBug', 'nav1Obs', 'nav2Obs', 'adfRadial', 'adfCard'};

  final Stopwatch _clock = Stopwatch()..start();
  Map<String, int> _index = const {};
  List<double>? _prev;
  List<double>? _cur;
  int _prevAt = 0;
  int _curAt = 0;

  /// Values that are not in the data stream (e.g. Vfe/Vno from the host's aircraft profile).
  Map<String, double> _refs = const {};

  void setRefs(Map<String, double> refs) => _refs = refs;

  /// True if the host sends [key] in its data stream.
  bool knows(String key) => _index.containsKey(key);

  /// True if [key] is known (in the stream or in the refs) and non-zero.
  bool has(String key) => (_index.containsKey(key) && _cur != null && get(key) != 0) || (_refs[key] ?? 0) != 0;

  /// Order of values in each sample (from the host's `dataVars`).
  void setVars(List<String> vars) {
    _index = {for (var i = 0; i < vars.length; i++) vars[i]: i};
    _prev = null;
    _cur = null;
  }

  void push(List<double> values) {
    _prev = _cur;
    _prevAt = _curAt;
    _cur = values;
    _curAt = _clock.elapsedMilliseconds;
    notifyListeners();
  }

  /// True when data arrived in the last 2 s.
  bool get live => _cur != null && _clock.elapsedMilliseconds - _curAt < 2000;

  double get(String key, [double fallback = 0]) {
    final i = _index[key];
    final cur = _cur;
    if (i == null || cur == null || i >= cur.length) return _refs[key] ?? fallback;
    final prev = _prev;
    if (prev == null || i >= prev.length) return cur[i];
    final span = (_curAt - _prevAt).clamp(1, 250);
    final renderAt = _clock.elapsedMilliseconds - span;
    final f = ((renderAt - _prevAt) / span).clamp(0.0, 1.0);
    final a = prev[i], b = cur[i];
    if (_angular.contains(key)) {
      var d = (b - a) % 360;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      return (a + d * f) % 360;
    }
    return a + (b - a) * f;
  }

  bool flag(String key) => get(key) > 0.5;

  static double clampD(double v, double lo, double hi) => math.max(lo, math.min(hi, v));
}
