import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../../models/settlement.dart';

/// English and Hindi wording of a settlement's state.
({String english, String hindi}) settlementStatusWords(SettlementStatus status) => switch (status) {
      SettlementStatus.pending => (english: 'Pending', hindi: 'बाकी'),
      SettlementStatus.onHold => (english: 'On hold', hindi: 'रोका गया'),
      SettlementStatus.paid => (english: 'Paid', hindi: 'चुकाया गया'),
    };

/// Small status chip: amber while pending or on hold, green once paid. Text stays in the ink colour so it reads on every tint.
class VSettlementStatusChip extends StatelessWidget {
  const VSettlementStatusChip({super.key, required this.status});
  final SettlementStatus status;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final words = settlementStatusWords(status);
    final (Color color, IconData icon) = switch (status) {
      SettlementStatus.pending => (KraveoPalette.warning, LucideIcons.clock),
      SettlementStatus.onHold => (KraveoPalette.warning, LucideIcons.pause),
      SettlementStatus.paid => (k.brand, LucideIcons.circleCheck),
    };
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Semantics(
      container: true,
      label: 'Status: ${words.english}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(color: color.withValues(alpha: dark ? 0.22 : 0.14), borderRadius: BorderRadius.circular(KRadius.pill)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 16, color: status == SettlementStatus.paid ? color : (dark ? color : Color.alphaBlend(Colors.black.withValues(alpha: 0.25), color))),
          const SizedBox(width: 6),
          Flexible(
            child: Text(words.english, key: ValueKey('settlement-status-${status.name}'), maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.ink, fontSize: 13, fontWeight: FontWeight.w800)),
          ),
        ]),
      ),
    );
  }
}
