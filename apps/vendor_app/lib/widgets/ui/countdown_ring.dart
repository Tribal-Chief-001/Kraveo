import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Circular countdown: a track + a coloured arc that drains as time runs out.
/// [progress] is 1.0 (full time left) to 0.0 (time is up).
class VCountdownRing extends StatelessWidget {
  const VCountdownRing({super.key, required this.progress, required this.color, required this.child, this.size = 88, this.stroke = 9});
  final double progress;
  final Color color;
  final Widget child;
  final double size;
  final double stroke;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _RingPainter(progress.clamp(0.0, 1.0), color, k.surfaceAlt, stroke),
        child: Padding(padding: EdgeInsets.all(stroke + 4), child: Center(child: child)),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.progress, this.color, this.track, this.stroke);
  final double progress;
  final Color color, track;
  final double stroke;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final r = Rect.fromCircle(center: rect.center, radius: (size.shortestSide - stroke) / 2);
    final base = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = track;
    canvas.drawArc(r, 0, math.pi * 2, false, base);
    if (progress <= 0) return;
    final arc = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..color = color;
    canvas.drawArc(r, -math.pi / 2, math.pi * 2 * progress, false, arc);
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.progress != progress || old.color != color || old.track != track || old.stroke != stroke;
}
