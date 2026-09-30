import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Veg / non-veg food marker (square outline with a dot or triangle), with a screen-reader label.
class VegMark extends StatelessWidget {
  const VegMark({super.key, required this.isVeg, this.size = 16});

  final bool isVeg;
  final double size;

  @override
  Widget build(BuildContext context) {
    final color = isVeg ? KraveoPalette.g500 : KraveoPalette.danger;
    return Semantics(
      label: isVeg ? 'Vegetarian' : 'Non-vegetarian',
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          border: Border.all(color: color, width: 1.6),
          borderRadius: BorderRadius.circular(size * 0.22),
        ),
        child: isVeg
            ? Container(width: size * 0.5, height: size * 0.5, decoration: BoxDecoration(color: color, shape: BoxShape.circle))
            : CustomPaint(size: Size(size * 0.5, size * 0.46), painter: _TrianglePainter(color)),
      ),
    );
  }
}

class _TrianglePainter extends CustomPainter {
  _TrianglePainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..moveTo(size.width / 2, 0)
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(path, Paint()..color = color);
  }

  @override
  bool shouldRepaint(covariant _TrianglePainter old) => old.color != color;
}
