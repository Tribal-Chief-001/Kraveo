import 'package:flutter/material.dart';
import '../theme/tokens.dart';
import '../tokens/foundation.dart';

/// Shimmer placeholder - shown while real data loads (no more blank / fake data flashes).
class KSkeleton extends StatefulWidget {
  const KSkeleton({super.key, this.width, this.height = 16, this.radius = KRadius.sm});
  final double? width;
  final double height;
  final double radius;

  @override
  State<KSkeleton> createState() => _KSkeletonState();
}

class _KSkeletonState extends State<KSkeleton> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1300))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final base = k.surfaceAlt;
    final hi = k.isDark ? k.line : Colors.white.withValues(alpha: 0.85);
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) => Container(
        width: widget.width,
        height: widget.height,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(widget.radius),
          gradient: LinearGradient(
            begin: Alignment(-1.5 + 3 * _c.value, 0),
            end: Alignment(-0.5 + 3 * _c.value, 0),
            colors: [base, hi, base],
            stops: const [0.25, 0.5, 0.75],
          ),
        ),
      ),
    );
  }
}
