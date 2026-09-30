import 'package:flutter/material.dart';
import '../tokens/colors.dart';
import '../tokens/typography.dart';

/// Order status chip. Same colour + wording on customer, vendor, driver and admin.
class KStatusPill extends StatefulWidget {
  const KStatusPill({super.key, required this.status, this.label, this.compact = false});
  final KStatus status;
  final String? label;
  final bool compact;

  @override
  State<KStatusPill> createState() => _KStatusPillState();
}

class _KStatusPillState extends State<KStatusPill> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  bool get _live => widget.status != KStatus.delivered && widget.status != KStatus.cancelled;

  @override
  Widget build(BuildContext context) {
    final col = widget.status.color;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: widget.compact ? 10 : 12, vertical: widget.compact ? 5 : 7),
      decoration: BoxDecoration(
        color: col.withValues(alpha: dark ? 0.18 : 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        AnimatedBuilder(
          animation: _c,
          builder: (_, __) => Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: col,
              shape: BoxShape.circle,
              boxShadow: _live ? [BoxShadow(color: col.withValues(alpha: 0.5 * _c.value), blurRadius: 8, spreadRadius: 3 * _c.value)] : null,
            ),
          ),
        ),
        const SizedBox(width: 7),
        Text(widget.label ?? widget.status.label,
            style: KraveoType.label.copyWith(color: dark ? col : Color.alphaBlend(Colors.black.withValues(alpha: 0.35), col))),
      ]),
    );
  }
}
