// Draws a gauge layout: the whole layout is scaled to fit the screen (keeping its shape) and every
// gauge is repainted on each screen refresh with smoothed values. Glass items show a captured display
// (or part of one) from the host, next to the steam gauges.

import 'package:flutter/scheduler.dart';
import 'package:material_ui/material_ui.dart';

import 'display_view.dart';
import 'gauges/gauge_base.dart';
import 'gauges/gauge_values.dart';
import 'gauges/instruments.dart';
import 'host_connection.dart';
import 'protocol.dart';

class LayoutView extends StatefulWidget {
  const LayoutView({super.key, required this.layout, required this.values, this.feedFor, this.nameFor});
  final GaugeLayout layout;
  final GaugeValues values;

  /// Pictures for glass items (null: glass items show their name only).
  final DisplayFeed Function(String id)? feedFor;
  /// Display names from the host, for glass items whose display is not in the cockpit.
  final String? Function(String id)? nameFor;

  @override
  State<LayoutView> createState() => _LayoutViewState();
}

class _LayoutViewState extends State<LayoutView> with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  final _frame = ValueNotifier<int>(0);
  final Map<String, GaugePainter> _painters = {};

  @override
  void initState() {
    super.initState();
    _ticker = createTicker((_) => _frame.value++)..start();
  }

  @override
  void didUpdateWidget(LayoutView old) {
    super.didUpdateWidget(old);
    if (old.layout != widget.layout) _painters.clear(); // options may have changed
  }

  @override
  void dispose() {
    _ticker.dispose();
    _frame.dispose();
    super.dispose();
  }

  GaugePainter? _painterFor(LayoutGauge g) {
    final key = '${g.id}|${g.type}';
    return _painters[key] ??= makeGauge(g.type, widget.values, g.options, _frame) ?? _UnknownGauge(widget.values, g.type, _frame);
  }

  @override
  Widget build(BuildContext context) {
    final l = widget.layout;
    return LayoutBuilder(builder: (context, c) {
      final scale = (c.maxWidth / l.width) < (c.maxHeight / l.height) ? c.maxWidth / l.width : c.maxHeight / l.height;
      final ox = (c.maxWidth - l.width * scale) / 2, oy = (c.maxHeight - l.height * scale) / 2;
      return Stack(children: [
        for (final g in l.gauges)
          Positioned(
            left: ox + g.x * scale,
            top: oy + g.y * scale,
            width: g.w * scale,
            height: g.h * scale,
            child: RepaintBoundary(child: g.type == 'glass' ? _glass(g) : CustomPaint(painter: _painterFor(g))),
          ),
      ]);
    });
  }

  Widget _glass(LayoutGauge g) {
    final id = '${g.options['display'] ?? ''}';
    final feed = widget.feedFor?.call(id);
    if (feed == null || id.isEmpty) return const ColoredBox(color: Colors.black);
    return GlassItemView(feed: feed, crop: glassCrop(g.options), fit: glassFit(g.options), name: widget.nameFor?.call(id));
  }
}

/// The part of the picture a glass item shows, as fractions (null: all of it).
Rect? glassCrop(Map<String, dynamic> o) {
  final c = o['crop'];
  if (c is! Map) return null;
  double v(String k, double d) => ((c[k] as num?)?.toDouble() ?? d).clamp(0.0, 1.0);
  final r = Rect.fromLTWH(v('x', 0), v('y', 0), v('w', 1), v('h', 1));
  return r.width < 0.01 || r.height < 0.01 ? null : r;
}

BoxFit glassFit(Map<String, dynamic> o) => switch (o['fit']) {
      'cover' => BoxFit.cover,
      'fill' => BoxFit.fill,
      _ => BoxFit.contain,
    };

class _UnknownGauge extends GaugePainter {
  _UnknownGauge(GaugeValues v, this.type, Listenable r) : super(v, const {}, r);
  final String type;

  @override
  void drawFace(Canvas c) {

    drawText(c, 'unknown gauge\n$type', Offset.zero, 22, color: kRed);
  }

  @override
  void drawDynamic(Canvas c) {}
}
