import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Three expanding, fading rings. Subtle "scanning for orders" motion.
/// Respects the system "reduce motion" setting by freezing on a static ring.
class RadarPulse extends StatefulWidget {
  const RadarPulse({super.key, this.size = 220, this.color});

  final double size;
  final Color? color;

  @override
  State<RadarPulse> createState() => _RadarPulseState();
}

class _RadarPulseState extends State<RadarPulse> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 3200));
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduce) {
      _c.stop();
      _started = false;
    } else if (!_started) {
      _c.repeat();
      _started = true;
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? context.k.brand;
    return IgnorePointer(
      child: ExcludeSemantics(
        child: SizedBox(
          width: widget.size,
          height: widget.size,
          child: AnimatedBuilder(
            animation: _c,
            builder: (_, __) => CustomPaint(painter: _RadarPainter(_c.value, color)),
          ),
        ),
      ),
    );
  }
}

class _RadarPainter extends CustomPainter {
  _RadarPainter(this.t, this.color);
  final double t;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final maxR = size.shortestSide / 2;
    for (var i = 0; i < 3; i++) {
      final p = (t + i / 3) % 1.0;
      final r = maxR * (0.25 + 0.75 * Curves.easeOut.transform(p));
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = color.withValues(alpha: 0.5 * (1 - p));
      canvas.drawCircle(center, r, paint);
    }
  }

  @override
  bool shouldRepaint(_RadarPainter old) => old.t != t || old.color != color;
}
