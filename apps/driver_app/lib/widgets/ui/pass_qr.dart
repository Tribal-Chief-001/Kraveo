import 'dart:math' as math;
import 'package:flutter/material.dart';

/// Stylised QR-looking block for the runner pass, seeded from the runner ID so it is stable.
/// NOTE: this is a visual placeholder, not a scannable QR code (no QR package is allowed).
/// Swap for a real encoder when the gate-verification payload is defined.
class PassQr extends StatelessWidget {
  const PassQr({super.key, required this.seed, this.size = 168, this.ink = Colors.black});

  final String seed;
  final double size;
  final Color ink;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: CustomPaint(size: Size.square(size), painter: _QrPainter(seed, ink)),
    );
  }
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.seed, this.ink);
  final String seed;
  final Color ink;
  static const n = 25;

  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / n;
    final paint = Paint()..color = ink;
    var h = 0;
    for (final u in seed.codeUnits) {
      h = (h * 31 + u) & 0x7fffffff;
    }
    final rnd = math.Random(h);
    bool inFinder(int x, int y) => (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (inFinder(x, y)) continue;
        if (rnd.nextDouble() < 0.5) {
          canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(x * cell, y * cell, cell * 0.92, cell * 0.92), Radius.circular(cell * 0.2)), paint);
        }
      }
    }
    void finder(int ox, int oy) {
      final o = Offset(ox * cell, oy * cell);
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(o.dx, o.dy, cell * 7, cell * 7), Radius.circular(cell * 1.4)), paint);
      canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromLTWH(o.dx + cell, o.dy + cell, cell * 5, cell * 5), Radius.circular(cell * 0.9)), Paint()..color = Colors.white);
      canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromLTWH(o.dx + cell * 2, o.dy + cell * 2, cell * 3, cell * 3), Radius.circular(cell * 0.6)), paint);
    }

    finder(0, 0);
    finder(n - 7, 0);
    finder(0, n - 7);
  }

  @override
  bool shouldRepaint(_QrPainter old) => old.seed != seed || old.ink != ink;
}
