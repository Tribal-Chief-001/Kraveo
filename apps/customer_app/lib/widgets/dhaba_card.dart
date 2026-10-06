import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/dhaba.dart';
import 'ui/format.dart';
import 'ui/info_chip.dart';
import 'ui/k_icon_button.dart';
import 'ui/k_image.dart';

/// Image-led kitchen card: photo with scrim, rating + ETA overlaid, name and cuisine on the image,
/// open / closed state in the footer.
class DhabaCard extends StatelessWidget {
  final Dhaba dhaba;
  final VoidCallback onTap;
  final VoidCallback? onFavoriteToggle;

  const DhabaCard({
    super.key,
    required this.dhaba,
    required this.onTap,
    this.onFavoriteToggle,
  });

  static String heroTag(String dhabaId) => 'dhaba-image-$dhabaId';

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final open = dhaba.isAcceptingOrders;
    return KPressable(
      onTap: onTap,
      scale: 0.98,
      semanticLabel: '${dhaba.name}, ${open ? 'open' : 'closed'}, rated ${dhaba.rating}, ${dhaba.eta}',
      child: Container(
        margin: const EdgeInsets.only(bottom: 18),
        decoration: BoxDecoration(
          color: k.surface,
          borderRadius: BorderRadius.circular(KRadius.xl),
          boxShadow: KShadow.soft(k.shadowTint),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(KRadius.xl),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            AspectRatio(
              aspectRatio: 1.42,
              child: Stack(fit: StackFit.expand, children: [
                Hero(tag: heroTag(dhaba.id), child: KImage(dhaba.bannerUrl, grayscale: !open)),
                // Warm scrims: top for chip legibility, bottom for the title.
                DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [
                        KraveoPalette.g950.withValues(alpha: 0.35),
                        Colors.transparent,
                        KraveoPalette.g950.withValues(alpha: 0.9),
                      ],
                      stops: const [0, 0.42, 1],
                    ),
                  ),
                ),
                Positioned(
                  top: 12,
                  left: 12,
                  child: open
                      ? KInfoChip(icon: LucideIcons.star, label: dhaba.rating.toStringAsFixed(1), glass: true, iconColor: kStarColor)
                      : const KInfoChip(icon: LucideIcons.moon, label: 'Closed now', glass: true),
                ),
                if (onFavoriteToggle != null)
                  Positioned(
                    top: 8,
                    right: 8,
                    child: KIconButton(
                      icon: LucideIcons.heart,
                      semanticLabel: dhaba.isFavorite ? 'Remove ${dhaba.name} from favourites' : 'Save ${dhaba.name} to favourites',
                      onTap: onFavoriteToggle,
                      background: k.surface.withValues(alpha: 0.94),
                      bordered: false,
                      color: dhaba.isFavorite ? KraveoPalette.danger : k.inkMuted,
                    ),
                  ),
                Positioned(
                  left: 16,
                  right: 16,
                  bottom: 14,
                  child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                        Text(dhaba.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.headlineSm.copyWith(color: Colors.white)),
                        const SizedBox(height: 2),
                        Text(dhaba.category, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: Colors.white.withValues(alpha: 0.85))),
                      ]),
                    ),
                    const SizedBox(width: 10),
                    KInfoChip(icon: LucideIcons.clock, label: dhaba.eta, glass: true),
                  ]),
                ),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              child: Row(children: [
                Container(
                  width: 9,
                  height: 9,
                  decoration: BoxDecoration(color: open ? KraveoPalette.g500 : k.inkFaint, shape: BoxShape.circle),
                ),
                const SizedBox(width: 8),
                Text(open ? 'Open' : 'Closed', style: KraveoType.label.copyWith(color: open ? k.brand : k.inkMuted, fontSize: 12.5)),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'Delivery ${rupee(dhaba.deliveryFee)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.end,
                    style: KraveoType.bodySm.copyWith(color: k.inkMuted),
                  ),
                ),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
