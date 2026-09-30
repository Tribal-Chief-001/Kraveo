import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/tokens.dart';
import '../tokens/foundation.dart';
import '../tokens/typography.dart';

/// Slide-to-confirm (accept job, mark picked up). Forgiving: 78% threshold, snaps back smoothly.
class KSlideToConfirm extends StatefulWidget {
  const KSlideToConfirm({super.key, required this.label, required this.onConfirmed, this.icon = Icons.arrow_forward_rounded, this.color});
  final String label;
  final VoidCallback onConfirmed;
  final IconData icon;
  final Color? color;

  @override
  State<KSlideToConfirm> createState() => _KSlideToConfirmState();
}

class _KSlideToConfirmState extends State<KSlideToConfirm> {
  double _x = 0;
  bool _done = false;
  bool _dragging = false;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final track = widget.color ?? k.accent;
    const h = 72.0, thumb = 60.0;
    return LayoutBuilder(builder: (context, c) {
      final max = c.maxWidth - thumb - 12;
      final progress = max <= 0 ? 0.0 : (_x / max).clamp(0.0, 1.0);
      return Container(
        height: h,
        decoration: BoxDecoration(color: track.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(KRadius.pill), border: Border.all(color: track.withValues(alpha: 0.5))),
        child: Stack(alignment: Alignment.centerLeft, children: [
          Positioned.fill(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(KRadius.pill),
              child: Align(alignment: Alignment.centerLeft, child: FractionallySizedBox(widthFactor: (_x + thumb + 6) / c.maxWidth, child: Container(color: track.withValues(alpha: 0.35)))),
            ),
          ),
          Center(
            child: Opacity(
              opacity: 1 - progress * 0.8,
              child: Padding(
                padding: const EdgeInsets.only(left: 40),
                child: Text(_done ? 'Confirmed' : widget.label, style: KraveoType.button.copyWith(color: k.ink, fontSize: 17)),
              ),
            ),
          ),
          AnimatedPositioned(
            duration: _dragging ? Duration.zero : KMotion.base,
            curve: KMotion.spring,
            left: 6 + _x,
            child: GestureDetector(
              onHorizontalDragStart: (_) => setState(() => _dragging = true),
              onHorizontalDragUpdate: (d) => setState(() => _x = (_x + d.delta.dx).clamp(0, max)),
              onHorizontalDragEnd: (_) {
                setState(() => _dragging = false);
                if (progress >= 0.78 && !_done) {
                  HapticFeedback.heavyImpact();
                  setState(() {
                    _x = max;
                    _done = true;
                  });
                  widget.onConfirmed();
                } else {
                  setState(() => _x = 0);
                }
              },
              child: Container(
                width: thumb,
                height: thumb,
                decoration: BoxDecoration(color: track, shape: BoxShape.circle, boxShadow: KShadow.glow(track).map((s) => s.copyWith(color: s.color.withValues(alpha: 0.3))).toList()),
                child: Icon(_done ? Icons.check_rounded : widget.icon, color: k.onAccent, size: 28),
              ),
            ),
          ),
        ]),
      );
    });
  }
}
