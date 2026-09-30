import 'package:flutter/material.dart';
import 'avatar_art/registry.dart';
import '../theme/tokens.dart';
import '../tokens/foundation.dart';

/// Number of built-in profile avatars (ids 1..kAvatarCount). The server stores only the id.
const int kAvatarCount = 15;

/// Profile avatar drawn entirely in code (no image files, no network, zero server load).
///
/// Ids 1..[kAvatarCount] are mythical creatures; anything else (null, 0, out of range)
/// renders a neutral silhouette placeholder. [ring] adds a 3px accent ring inside [size].
class KAvatar extends StatelessWidget {
  const KAvatar({super.key, required this.id, this.size = 56, this.ring = false});
  final int? id;
  final double size;
  final bool ring;

  static bool isValid(int? id) => id != null && id >= 1 && id <= kAvatarCount;

  /// Human name of avatar [id] ("Garuda", ...), or null for an invalid id.
  static String? nameOf(int? id) => isValid(id) ? kAvatarSpecs[id! - 1].name : null;

  @override
  Widget build(BuildContext context) {
    final label = isValid(id) ? '${kAvatarSpecs[id! - 1].name} avatar' : 'Avatar placeholder';
    const ringWidth = 3.0, ringGap = 2.0;
    final inset = ring ? ringWidth + ringGap : 0.0;
    Widget art = SizedBox(
      width: size - inset * 2,
      height: size - inset * 2,
      child: ClipOval(child: CustomPaint(painter: _AvatarPainter(isValid(id) ? id : null), isComplex: true)),
    );
    if (ring) {
      art = DecoratedBox(
        decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: context.k.accent, width: ringWidth)),
        child: Padding(padding: const EdgeInsets.all(ringGap), child: art),
      );
    }
    return Semantics(
      label: label,
      image: true,
      excludeSemantics: true,
      child: SizedBox(width: size, height: size, child: RepaintBoundary(child: art)),
    );
  }
}

/// Paints badge background + creature on a virtual 100x100 canvas scaled to the widget size.
class _AvatarPainter extends CustomPainter {
  const _AvatarPainter(this.id);
  final int? id;

  @override
  void paint(Canvas canvas, Size size) {
    paintAvatar(canvas, size, id);
  }

  @override
  bool shouldRepaint(_AvatarPainter old) => old.id != id;
}

/// 5 x 3 grid to choose an avatar. Reports the chosen id (1..kAvatarCount).
class KAvatarPicker extends StatelessWidget {
  const KAvatarPicker({super.key, required this.selectedId, required this.onChanged});
  final int? selectedId;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final selectColor = k.isDark ? k.accent : k.brand;
    return LayoutBuilder(builder: (context, c) {
      const cols = 5;
      const gap = 10.0;
      final cell = (c.maxWidth - gap * (cols - 1)) / cols;
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: [
          for (var i = 1; i <= kAvatarCount; i++)
            Semantics(
              button: true,
              selected: selectedId == i,
              label: '${kAvatarSpecs[i - 1].name} avatar',
              excludeSemantics: true,
              onTap: () => onChanged(i),
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => onChanged(i),
                child: AnimatedScale(
                  duration: KMotion.base,
                  curve: KMotion.spring,
                  scale: selectedId == i ? 1.0 : 0.94,
                  child: AnimatedContainer(
                    duration: KMotion.base,
                    curve: KMotion.emphasized,
                    width: cell,
                    height: cell,
                    padding: const EdgeInsets.all(2),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: selectedId == i ? selectColor : Colors.transparent, width: 3),
                    ),
                    child: KAvatar(id: i, size: cell - 10),
                  ),
                ),
              ),
            ),
        ],
      );
    });
  }
}
