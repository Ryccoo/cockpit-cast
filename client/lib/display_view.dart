// Draws one display, fitted to its box with the aspect ratio kept (letterboxed).

import 'dart:ui' as ui;

import 'package:material_ui/material_ui.dart';

import 'host_connection.dart';

class DisplayView extends StatelessWidget {
  const DisplayView({super.key, required this.feed, required this.waitingText, this.showStats = false, this.name});

  final DisplayFeed feed;
  /// Shown while there is no picture (default: the id).
  final String? name;
  final String waitingText;
  final bool showStats;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: feed,
      builder: (context, _) {
        final img = feed.image;
        return Stack(
          fit: StackFit.expand,
          children: [
            if (img != null) CustomPaint(painter: _FramePainter(img)),
            if (img == null || feed.stale)
              Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  decoration: BoxDecoration(color: const Color(0xCC000000), borderRadius: BorderRadius.circular(6)),
                  child: Text('${name ?? feed.id.toUpperCase()}\n$waitingText', textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFFB0B0B0), fontSize: 16)),
                ),
              ),
            if (showStats && img != null)
              Positioned(
                left: 6,
                top: 6,
                child: Container(
                  color: const Color(0xAA000000),
                  padding: const EdgeInsets.all(4),
                  child: Text('${feed.id}  ${feed.width}x${feed.height}  ${feed.fps.toStringAsFixed(1)} fps', style: const TextStyle(color: Color(0xFF7CFC00), fontSize: 12, fontFamily: 'monospace')),
                ),
              ),
          ],
        );
      },
    );
  }
}

/// A glass item inside a gauge layout: part of a display, fitted to its box. Shows the last picture
/// while none arrive, and a dim name when there has never been one (display not in this cockpit).
class GlassItemView extends StatelessWidget {
  const GlassItemView({super.key, required this.feed, this.crop, this.fit = BoxFit.contain, this.name});
  final DisplayFeed feed;
  final String? name;
  final Rect? crop;
  final BoxFit fit;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: feed,
      builder: (context, _) {
        final img = feed.image;
        if (img == null) {
          return ColoredBox(
            color: Colors.black,
            child: Center(child: Text(name ?? feed.id.toUpperCase(), style: const TextStyle(color: Color(0xFF3A3F46), fontSize: 14))),
          );
        }
        return ColoredBox(color: Colors.black, child: ClipRect(child: CustomPaint(size: Size.infinite, painter: _FramePainter(img, crop: crop, fit: fit))));
      },
    );
  }
}

class _FramePainter extends CustomPainter {
  _FramePainter(this.image, {this.crop, this.fit = BoxFit.contain});
  final ui.Image image;
  final Rect? crop;
  final BoxFit fit;

  @override
  void paint(Canvas canvas, Size size) {
    final iw = image.width.toDouble(), ih = image.height.toDouble();
    final c = crop;
    final src = c == null ? Rect.fromLTWH(0, 0, iw, ih) : Rect.fromLTWH(c.left * iw, c.top * ih, c.width * iw, c.height * ih);
    final fitted = applyBoxFit(fit, src.size, size);
    final dst = Alignment.center.inscribe(fitted.destination, Offset.zero & size);
    final from = Alignment.center.inscribe(fitted.source, src);
    canvas.drawImageRect(image, from, dst, Paint()..filterQuality = FilterQuality.medium);
  }

  @override
  bool shouldRepaint(_FramePainter old) => old.image != image || old.crop != crop || old.fit != fit;
}
