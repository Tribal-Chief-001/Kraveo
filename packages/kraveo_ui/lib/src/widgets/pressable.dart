import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../tokens/foundation.dart';

/// Every tappable surface in Kraveo: springy scale-down + haptic tick.
class KPressable extends StatefulWidget {
  const KPressable({super.key, required this.child, this.onTap, this.onLongPress, this.scale = 0.96, this.haptic = true, this.semanticLabel});
  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final double scale;
  final bool haptic;
  final String? semanticLabel;

  @override
  State<KPressable> createState() => _KPressableState();
}

class _KPressableState extends State<KPressable> {
  bool _down = false;

  void _set(bool v) {
    if (widget.onTap == null && widget.onLongPress == null) return;
    if (_down != v) setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: widget.semanticLabel,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => _set(true),
        onTapCancel: () => _set(false),
        onTapUp: (_) => _set(false),
        onTap: widget.onTap == null
            ? null
            : () {
                if (widget.haptic) HapticFeedback.selectionClick();
                widget.onTap!();
              },
        onLongPress: widget.onLongPress,
        child: AnimatedScale(
          scale: _down ? widget.scale : 1,
          duration: _down ? KMotion.fast : KMotion.base,
          curve: _down ? Curves.easeOut : KMotion.spring,
          child: widget.child,
        ),
      ),
    );
  }
}
