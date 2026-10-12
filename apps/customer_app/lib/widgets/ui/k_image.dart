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

  /// The most pixels (longest side) a photo is ever decoded at. Photos on this app are shown in boxes
  /// of at most a phone screen, so a 4000 px upload is never held in memory at full size.
  static const int maxDecodePixels = 1200;

  /// Decode size (longest side, physical pixels) for a box of [logicalWidth] x [logicalHeight]:
  /// the larger side x [devicePixelRatio], rounded up to a multiple of 100 (so a collapsing header
  /// does not re-decode on every frame), at least 100 and at most [maxDecodePixels].
  static int decodeSize(double logicalWidth, double logicalHeight, double devicePixelRatio) {
    final longest = [logicalWidth, logicalHeight].where((v) => v.isFinite && v > 0).fold<double>(0, (a, b) => b > a ? b : a);
    final px = longest * (devicePixelRatio.isFinite && devicePixelRatio > 0 ? devicePixelRatio : 1);
    if (px <= 0) return maxDecodePixels;
    return ((px / 100).ceil() * 100).clamp(100, maxDecodePixels);
  }

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
      body = LayoutBuilder(builder: (context, constraints) {
        final screen = MediaQuery.sizeOf(context);
        final size = decodeSize(
          constraints.hasBoundedWidth ? constraints.maxWidth : screen.width,
          constraints.hasBoundedHeight ? constraints.maxHeight : screen.width,
          MediaQuery.devicePixelRatioOf(context),
        );
        return Stack(fit: StackFit.expand, children: [
          ColoredBox(color: k.surfaceAlt),
          Image(
            // Decode no larger than the box needs (aspect ratio kept, never upscaled).
            image: ResizeImage(NetworkImage(url), width: size, height: size, policy: ResizeImagePolicy.fit),
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
      });
    }
    if (grayscale) body = ColorFiltered(colorFilter: const ColorFilter.matrix(_grayMatrix), child: body);
    return body;
  }
}
