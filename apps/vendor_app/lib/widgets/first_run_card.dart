import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Shown on the Orders tab while the menu is empty or the store is closed: what to do before orders can arrive.
/// "1. Add a dish   2. Tap OPEN". A step turns green once it is done; tapping a step goes there.
class FirstRunCard extends StatelessWidget {
  const FirstRunCard({super.key, required this.hasDishes, required this.isOpen, required this.onAddDish, required this.onOpenStore, this.waitingApproval = false});

  final bool hasDishes;
  final bool isOpen;

  /// Dishes were added but none is live yet: customers see no menu until Kraveo approves one.
  final bool waitingApproval;
  final VoidCallback onAddDish;
  final VoidCallback onOpenStore;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: KCard(
        key: const ValueKey('first-run-card'),
        color: k.brandSoft,
        elevated: false,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Get ready for your first order', style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
          Text('पहले ऑर्डर की तैयारी करें', style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 15)),
          const SizedBox(height: 8),
          _Step(
            key: const ValueKey('first-run-add'),
            number: 1,
            done: hasDishes,
            label: 'Add a dish',
            hindi: 'मेनू में व्यंजन जोड़ें',
            note: waitingApproval ? 'Waiting for Kraveo to approve your dish.  ·  मंज़ूरी का इंतज़ार' : 'Kraveo approves each new dish first.  ·  पहले Kraveo मंज़ूर करेगा',
            onTap: onAddDish,
          ),
          _Step(key: const ValueKey('first-run-open'), number: 2, done: isOpen, label: 'Tap OPEN', hindi: 'दुकान खोलें', onTap: onOpenStore),
        ]),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({super.key, required this.number, required this.done, required this.label, required this.hindi, required this.onTap, this.note});

  final int number;
  final bool done;
  final String label;
  final String hindi;
  final String? note;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      button: true,
      label: 'Step $number: $label${done ? ', done' : ''}${note == null ? '' : '. $note'}',
      excludeSemantics: true,
      onTap: onTap,
      child: KPressable(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Row(children: [
            Container(
              width: 36,
              height: 36,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: done ? k.brand : k.surface, shape: BoxShape.circle, border: Border.all(color: k.brand, width: 2)),
              child: done ? Icon(LucideIcons.check, size: 20, color: k.onBrand) : Text('$number', style: KraveoType.titleMd.copyWith(color: k.brand, fontWeight: FontWeight.w800)),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text.rich(
                TextSpan(children: [
                  TextSpan(text: label, style: KraveoType.titleLg.copyWith(color: k.ink, fontSize: 19, fontWeight: FontWeight.w800)),
                  TextSpan(text: '   $hindi', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
                  if (note != null) TextSpan(text: '\n$note', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
                ]),
                key: note == null ? null : const ValueKey('first-run-approval-help'),
              ),
            ),
            Icon(LucideIcons.chevronRight, size: 22, color: k.inkFaint),
          ]),
        ),
      ),
    );
  }
}
