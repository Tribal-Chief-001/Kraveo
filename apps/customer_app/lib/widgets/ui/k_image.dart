import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Network image with a calm placeholder, fade-in and a branded fallback.
/// Fills whatever box it is given.
class KImage extends StatelessWidget {
  const KImage(this.url, {super.key, this.fit = BoxFit.cover, this.grayscale = false, this.fallbackIcon = LucideIcons.utensils});

  final String url;
  final BoxFit fit;
  final bool grayscale;
  final IconData fallbackIcon;

  static const _grayMatrix = <double>[
    0.2126, 0.7152, 0.0722, 0, 0, //
    0.2126, 0.7152, 0.0722, 0, 0,
    0.2126, 0.7152, 0.0722, 0, 0,
    0, 0, 0, 1, 0,
  ];

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    Widget fallback() => ColoredBox(
          color: k.brandSoft,
          child: Center(child: Icon(fallbackIcon, size: 30, color: k.brand.withValues(alpha: 0.4))),
        );

    Widget body;
    if (url.trim().isEmpty) {
      body = fallback();
    } else {
      body = Stack(fit: StackFit.expand, children: [
        ColoredBox(color: k.surfaceAlt),
        Image.network(
          url,
          fit: fit,
          width: double.infinity,
          height: double.infinity,
          frameBuilder: (context, child, frame, sync) {
            if (sync) return child;
            return AnimatedOpacity(opacity: frame == null ? 0 : 1, duration: KMotion.slow, curve: KMotion.emphasized, child: child);
          },
          errorBuilder: (context, error, stack) => fallback(),
        ),
      ]);
    }
    if (grayscale) body = ColorFiltered(colorFilter: const ColorFilter.matrix(_grayMatrix), child: body);
    return body;
  }
}
