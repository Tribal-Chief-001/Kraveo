import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../models/drop_point.dart';
import 'sheet_chrome.dart';

/// Drop-off points offered by Kraveo on campus: the 11 canonical names, in contract order.
/// (Coordinates live in `kDropPoints`, lib/models/drop_point.dart.)
final List<String> kHostelBlocks = kDropPointNames;

/// Selectable drop points grouped Boys / Girls. Names that are not known drop points (only
/// possible when a caller passes its own list) are shown in one flat wrap instead.
class DropPointChips extends StatelessWidget {
  const DropPointChips({super.key, required this.blocks, required this.selected, required this.onSelected});

  final List<String> blocks;
  final String? selected;
  final ValueChanged<String> onSelected;

  Widget _wrap(List<String> names) => Wrap(
        spacing: 10,
        runSpacing: 10,
        children: [
          for (final name in names)
            KChoiceChip(
              label: name,
              icon: LucideIcons.mapPin,
              selected: name == selected,
              onTap: () => onSelected(name),
            ),
        ],
      );

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final known = blocks.every((b) => dropPointByName(b)?.name == b);
    if (!known) return _wrap(blocks);
    Widget group(DropGroup g) {
      final names = [for (final b in blocks) if (dropPointByName(b)!.group == g) b];
      if (names.isEmpty) return const SizedBox.shrink();
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Text(g.label.toUpperCase(), style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 0.8)),
        ),
        _wrap(names),
      ]);
    }

    final boys = group(DropGroup.boys);
    final girls = group(DropGroup.girls);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      boys,
      if (blocks.any((b) => dropPointByName(b)!.group == DropGroup.boys) && blocks.any((b) => dropPointByName(b)!.group == DropGroup.girls)) const SizedBox(height: 16),
      girls,
    ]);
  }
}

/// Opens the hostel picker sheet. Returns the chosen block, or null when dismissed.
Future<String?> showHostelPicker(BuildContext context, {required List<String> blocks, required String selected}) {
  return showKSheet<String>(
    context,
    builder: (ctx) => KSheetFrame(
      title: 'Where should we deliver?',
      subtitle: Text('Your runner meets you at this gate.', style: KraveoType.bodySm.copyWith(color: ctx.k.inkMuted)),
      children: [
        DropPointChips(blocks: blocks, selected: selected, onSelected: (block) => Navigator.of(ctx).pop(block)),
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
    this.placeholder = 'Choose drop point',
  });

  /// The chosen drop-off point, or null when none has been picked yet (non-students pick at
  /// checkout). A null value shows [placeholder] and a neutral caption.
  final String? selectedHostel;

  /// Shown instead of a block name while nothing is chosen.
  final String placeholder;
  final List<String> hostelBlocks;
  final ValueChanged<String> onChanged;
  final String caption;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final chosen = selectedHostel;
    final safeValue = chosen == null ? null : (hostelBlocks.contains(chosen) ? chosen : (hostelBlocks.isNotEmpty ? hostelBlocks.first : chosen));
    return KPressable(
      semanticLabel: safeValue == null ? 'Delivery point not chosen. Choose drop-off point' : 'Delivering to $safeValue. Change drop-off point',
      onTap: () async {
        final picked = await showHostelPicker(context, blocks: hostelBlocks, selected: safeValue ?? '');
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
              Text(safeValue == null ? 'DELIVERY POINT' : caption, maxLines: 1, style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 0.8)),
              Text(safeValue ?? placeholder, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: safeValue == null ? k.inkMuted : k.ink)),
            ]),
          ),
          const SizedBox(width: 6),
          Icon(LucideIcons.chevronDown, size: 18, color: k.inkMuted),
        ]),
      ),
    );
  }
}
