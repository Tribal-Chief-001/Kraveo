import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'sheet_chrome.dart';

/// Drop-off points offered by Kraveo on campus.
const List<String> kHostelBlocks = [
  'Block 1',
  'Block 2',
  'Block 3',
  'Block 4',
  'Block 5',
  'Block 6',
  'Girls Gate 1',
  'Girls Gate 2',
  'VIT Main Gate',
];

/// Opens the hostel picker sheet. Returns the chosen block, or null when dismissed.
Future<String?> showHostelPicker(BuildContext context, {required List<String> blocks, required String selected}) {
  return showKSheet<String>(
    context,
    builder: (ctx) => KSheetFrame(
      title: 'Where should we deliver?',
      subtitle: Text('Your runner meets you at this gate.', style: KraveoType.bodySm.copyWith(color: ctx.k.inkMuted)),
      children: [
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            for (final block in blocks)
              KChoiceChip(
                label: block,
                icon: LucideIcons.mapPin,
                selected: block == selected,
                onTap: () => Navigator.of(ctx).pop(block),
              ),
          ],
        ),
        const SizedBox(height: 8),
      ],
    ),
  );
}

/// Always-visible drop-off selector. Tapping opens the picker sheet.
class HostelPill extends StatelessWidget {
  const HostelPill({
    super.key,
    required this.selectedHostel,
    required this.hostelBlocks,
    required this.onChanged,
    this.caption = 'DELIVERING TO',
  });

  final String selectedHostel;
  final List<String> hostelBlocks;
  final ValueChanged<String> onChanged;
  final String caption;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final safeValue = hostelBlocks.contains(selectedHostel) ? selectedHostel : (hostelBlocks.isNotEmpty ? hostelBlocks.first : selectedHostel);
    return KPressable(
      semanticLabel: 'Delivering to $safeValue. Change drop-off point',
      onTap: () async {
        final picked = await showHostelPicker(context, blocks: hostelBlocks, selected: safeValue);
        if (picked != null) onChanged(picked);
      },
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 8, 14, 8),
        decoration: BoxDecoration(
          color: k.surface,
          borderRadius: BorderRadius.circular(KRadius.pill),
          border: Border.all(color: k.line.withValues(alpha: 0.9)),
          boxShadow: KShadow.soft(k.shadowTint),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
            child: Icon(LucideIcons.mapPin, size: 17, color: k.brand),
          ),
          const SizedBox(width: 10),
          Flexible(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(caption, maxLines: 1, style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 0.8)),
              Text(safeValue, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.ink)),
            ]),
          ),
          const SizedBox(width: 6),
          Icon(LucideIcons.chevronDown, size: 18, color: k.inkMuted),
        ]),
      ),
    );
  }
}
