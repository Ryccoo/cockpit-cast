// The dial gauge with odd tick spacing from a layout (pull request #2): a spacing of 0 (or less) made the
// tick loop never end, which froze the display app. Such ticks are now left out, like the editor does.
import 'dart:ui' as ui;

import 'package:cockpitcast/gauges/gauge_values.dart';
import 'package:cockpitcast/gauges/instruments.dart';
import 'package:flutter_test/flutter_test.dart';

void paintDial(Map<String, dynamic> options) {
  final values = GaugeValues();
  final recorder = ui.PictureRecorder();
  DialGauge(values, options, values).paint(ui.Canvas(recorder), const ui.Size(400, 400));
  recorder.endRecording().dispose();
}

void main() {
  test('a dial with normal steps draws', () {
    paintDial({'min': 0, 'max': 100, 'majorStep': 20, 'minorStep': 5});
  });

  for (final step in [0, -10]) {
    test('majorStep $step: no labels, no endless loop', () {
      paintDial({'min': 0, 'max': 100, 'majorStep': step});
    });
    test('minorStep $step: no minor ticks, no endless loop', () {
      paintDial({'min': 0, 'max': 100, 'majorStep': 20, 'minorStep': step});
    });
  }
}
