import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

// The four Google brand colours. Third-party trademark colours, not Kraveo design tokens: the
// "G" must keep these exact values to be a recognisable Google mark, so they live here only.
const Color _gBlue = Color(0xFF4285F4);
const Color _gRed = Color(0xFFEA4335);
const Color _gYellow = Color(0xFFFBBC05);
const Color _gGreen = Color(0xFF34A853);

/// The multicolour Google "G", drawn with paths (no image asset).
class GoogleGMark extends StatelessWidget {
  const GoogleGMark({super.key, this.size = 24});

  final double size;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(child: CustomPaint(size: Size.square(size), painter: const _GPainter()));
  }
}

class _GPainter extends CustomPainter {
  const _GPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width;
    final stroke = s * 0.205;
    final radius = (s - stroke) / 2;
    final center = Offset(s / 2, s / 2);
    final rect = Rect.fromCircle(center: center, radius: radius);

    double rad(double deg) => deg * math.pi / 180;
    Paint ring(Color c) => Paint()
      ..color = c
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.butt
      ..isAntiAlias = true;

    // Angles are degrees clockwise from 3 o'clock; the G opens on the right between 320 and 360.
    canvas.drawArc(rect, rad(210), rad(110.5), false, ring(_gRed)); // top
    canvas.drawArc(rect, rad(135), rad(75.5), false, ring(_gYellow)); // left
    canvas.drawArc(rect, rad(45), rad(90.5), false, ring(_gGreen)); // bottom
    canvas.drawArc(rect, rad(0), rad(45.5), false, ring(_gBlue)); // lower right

    // Blue crossbar of the G.
    final bar = Paint()
      ..color = _gBlue
      ..style = PaintingStyle.fill;
    canvas.drawRect(Rect.fromLTRB(s * 0.5, s / 2 - stroke / 2, s, s / 2 + stroke / 2), bar);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Large "Continue with Google" button: white surface, Google mark, label. Shows a spinner while
/// the sign-in is in flight and ignores taps until it finishes.
class GoogleContinueButton extends StatelessWidget {
  const GoogleContinueButton({super.key, required this.onPressed, this.loading = false});

  final VoidCallback? onPressed;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final enabled = onPressed != null && !loading;
    return KPressable(
      onTap: enabled ? onPressed : null,
      semanticLabel: loading ? 'Signing in with Google' : 'Continue with Google',
      child: Opacity(
        opacity: onPressed == null && !loading ? 0.5 : 1,
        child: AnimatedContainer(
          duration: KMotion.base,
          constraints: const BoxConstraints(minHeight: 60),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
          decoration: BoxDecoration(
            color: k.surface,
            borderRadius: BorderRadius.circular(KRadius.xl),
            border: Border.all(color: k.line, width: 1.4),
            boxShadow: KShadow.soft(k.shadowTint),
          ),
          child: ExcludeSemantics(
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              if (loading)
                SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.6, color: k.brand))
              else ...[
                const GoogleGMark(size: 26),
                const SizedBox(width: 14),
                Flexible(child: FittedBox(fit: BoxFit.scaleDown, child: Text('Continue with Google', maxLines: 1, style: KraveoType.titleLg.copyWith(color: k.ink)))),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}
