import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../../models/dish_model.dart';
import 'vendor_ui.dart';

/// English and Hindi wording of a dish's approval state (Docs/21 section 7).
({String english, String hindi}) dishStatusWords(DishStatus status) => switch (status) {
      DishStatus.pending => (english: 'Pending approval', hindi: 'मंज़ूरी बाकी'),
      DishStatus.live => (english: 'Live', hindi: 'ग्राहकों को दिख रहा'),
      DishStatus.changePending => (english: 'Price change pending', hindi: 'नया दाम मंज़ूरी में'),
      DishStatus.rejected => (english: 'Rejected', hindi: 'मंज़ूर नहीं हुआ'),
    };

/// Small status chip for a dish: amber while Kraveo has not decided, green when live, red when rejected.
/// Text stays in the normal ink colour so it reads on every tint; only the icon and the tint carry the colour.
class VDishStatusChip extends StatelessWidget {
  const VDishStatusChip({super.key, required this.status});
  final DishStatus status;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final words = dishStatusWords(status);
    final (Color color, IconData icon) = switch (status) {
      DishStatus.pending => (KraveoPalette.warning, LucideIcons.clock),
      DishStatus.live => (k.brand, LucideIcons.circleCheck),
      DishStatus.changePending => (KraveoPalette.warning, LucideIcons.clock),
      DishStatus.rejected => (kDangerDeep, LucideIcons.circleX),
    };
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Semantics(
      container: true,
      label: 'Status: ${words.english}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: color.withValues(alpha: dark ? 0.22 : 0.14),
          borderRadius: BorderRadius.circular(KRadius.pill),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 16, color: status == DishStatus.live ? color : (dark ? color : Color.alphaBlend(Colors.black.withValues(alpha: 0.25), color))),
          const SizedBox(width: 6),
          Flexible(
            child: Text(words.english, key: ValueKey('dish-status-${status.name}'), maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.ink, fontSize: 13, fontWeight: FontWeight.w800)),
          ),
        ]),
      ),
    );
  }
}
