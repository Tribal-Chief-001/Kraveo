import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/order_model.dart';

/// The small note on a part of a combined (multi-restaurant) order (Docs/22 section 7): "waiting for the other
/// restaurant(s) to accept" until every restaurant accepted, then "All restaurants accepted". It names nobody and shows
/// no number: the restaurant only ever learns `{ size, allAccepted }`. Draws nothing for a single-restaurant order and
/// for a finished one.
class GroupNote extends StatelessWidget {
  const GroupNote({super.key, required this.order});

  final OrderModel order;

  static const String waitingEnglish = 'Combined order - waiting for the other restaurant(s) to accept';
  static const String waitingHindi = 'कंबाइंड ऑर्डर - दूसरे रेस्टोरेंट के स्वीकार करने का इंतज़ार';
  static const String acceptedEnglish = 'All restaurants accepted';
  static const String acceptedHindi = 'सभी रेस्टोरेंट ने स्वीकार किया';

  @override
  Widget build(BuildContext context) {
    final g = order.group;
    if (g == null || order.status.isTerminal) return const SizedBox.shrink();
    final k = context.k;
    final waiting = !g.allAccepted;
    final color = waiting ? KraveoPalette.warning : k.brand;
    final english = waiting ? waitingEnglish : acceptedEnglish;
    final hindi = waiting ? waitingHindi : acceptedHindi;
    return Container(
      key: ValueKey('group-note-${order.id}'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Color.alphaBlend(color.withValues(alpha: 0.12), k.surface),
        borderRadius: BorderRadius.circular(KRadius.lg),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Semantics(
        label: english,
        excludeSemantics: true,
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(waiting ? LucideIcons.clock : LucideIcons.circleCheck, size: 20, color: waiting ? k.ink : k.brand),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(english, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 15, fontWeight: FontWeight.w700)),
              Text(hindi, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
            ]),
          ),
        ]),
      ),
    );
  }
}
