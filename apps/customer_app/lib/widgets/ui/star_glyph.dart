import 'dart:math' as math;
import 'package:flutter/material.dart';

/// Rating star that can be truly filled (the Lucide star is outline-only).
class KStarGlyph extends StatelessWidget {
  const KStarGlyph({super.key, required this.size, required this.filled, required this.color});

  final double size;
  final bool filled;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(size: Size.square(size), painter: _StarPainter(filled: filled, color: color));
  }
}

class _StarPainter extends CustomPainter {
  _StarPainter({required this.filled, required this.color});

  final bool filled;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final outer = size.width / 2 - 1.5;
    final inner = outer * 0.5;
    final path = Path();
    for (var i = 0; i < 10; i++) {
      final r = i.isEven ? outer : inner;
      final a = -math.pi / 2 + i * math.pi / 5;
      final p = Offset(c.dx + r * math.cos(a), c.dy + r * math.sin(a));
      if (i == 0) {
        path.moveTo(p.dx, p.dy);
      } else {
        path.lineTo(p.dx, p.dy);
      }
    }
    path.close();
    final stroke = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.2
      ..strokeJoin = StrokeJoin.round;
    if (filled) canvas.drawPath(path, Paint()..color = color);
    canvas.drawPath(path, stroke);
  }

  @override
  bool shouldRepaint(covariant _StarPainter old) => old.filled != filled || old.color != color;
}
