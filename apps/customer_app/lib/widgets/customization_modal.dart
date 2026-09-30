// ignore_for_file: sort_child_properties_last
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/customization.dart';
import '../models/menu_item.dart';
import 'ui/format.dart';
import 'ui/sheet_chrome.dart';
import 'ui/veg_mark.dart';

class CustomizationModal extends StatefulWidget {
  final MenuItemModel item;
  final Function(List<CustomizationOption> selectedOptions, String? notes) onAddToCart;

  const CustomizationModal({
    super.key,
    required this.item,
    required this.onAddToCart,
  });

  static Future<void> show(
    BuildContext context, {
    required MenuItemModel item,
    required Function(List<CustomizationOption> selectedOptions, String? notes) onAddToCart,
  }) {
    return showKSheet<void>(context, builder: (_) => CustomizationModal(item: item, onAddToCart: onAddToCart));
  }

  @override
  State<CustomizationModal> createState() => _CustomizationModalState();
}

class _CustomizationModalState extends State<CustomizationModal> {
  final Map<String, CustomizationOption> _singleSelections = {};
  final Map<String, Set<CustomizationOption>> _multiSelections = {};
  final TextEditingController _notesController = TextEditingController();
  String? _missingGroupId;

  @override
  void initState() {
    super.initState();
    for (final group in widget.item.customizationGroups) {
      if (group.maxSelection == 1 && group.options.isNotEmpty) {
        // Pre-select first option for single choice
        _singleSelections[group.id] = group.options.first;
      } else {
        _multiSelections[group.id] = {};
      }
    }
  }

  @override
  void dispose() {
    _notesController.dispose();
    super.dispose();
  }

  double get calculateTotalPrice {
    double total = widget.item.price;
    for (final opt in _singleSelections.values) {
      total += opt.price;
    }
    for (final set in _multiSelections.values) {
      for (final opt in set) {
        total += opt.price;
      }
    }
    return total;
  }

  List<CustomizationOption> get allSelectedOptions {
    final List<CustomizationOption> result = [];
    result.addAll(_singleSelections.values);
    for (final set in _multiSelections.values) {
      result.addAll(set);
    }
    return result;
  }

  void _submit() {
    for (final group in widget.item.customizationGroups) {
      if (group.isRequired) {
        final hasSingle = _singleSelections.containsKey(group.id);
        final hasMulti = (_multiSelections[group.id] ?? {}).isNotEmpty;
        if (!hasSingle && !hasMulti) {
          setState(() => _missingGroupId = group.id);
          return;
        }
      }
    }
    final notes = _notesController.text.trim();
    widget.onAddToCart(allSelectedOptions, notes.isEmpty ? null : notes);
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KSheetFrame(
      title: widget.item.name,
      subtitle: Row(children: [
        VegMark(isVeg: widget.item.isVeg, size: 14),
        const SizedBox(width: 8),
        Text('Base price ${rupee(widget.item.price)}', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
      ]),
      children: [
        for (final group in widget.item.customizationGroups) _buildGroup(context, group),
        Text('Note for the kitchen', style: KraveoType.titleMd.copyWith(color: k.ink)),
        const SizedBox(height: 8),
        TextField(
          controller: _notesController,
          maxLines: 2,
          textInputAction: TextInputAction.done,
          decoration: const InputDecoration(hintText: 'e.g. less spicy, extra green chutney (optional)'),
        ),
        const SizedBox(height: 8),
      ],
      footer: KButton(
        label: 'Add to cart · ${rupee(calculateTotalPrice)}',
        icon: LucideIcons.plus,
        onPressed: _submit,
      ),
    );
  }

  Widget _buildGroup(BuildContext context, CustomizationGroup group) {
    final k = context.k;
    final isSingleChoice = group.maxSelection == 1;
    final missing = _missingGroupId == group.id;
    final multiSet = _multiSelections[group.id] ?? <CustomizationOption>{};
    return Padding(
      padding: const EdgeInsets.only(bottom: 22),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(group.title, style: KraveoType.titleMd.copyWith(color: k.ink))),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: group.isRequired ? k.brandSoft : k.surfaceAlt,
              borderRadius: BorderRadius.circular(KRadius.pill),
            ),
            child: Text(
              group.isRequired ? 'Required' : (isSingleChoice ? 'Optional' : 'Optional · up to ${group.maxSelection}'),
              style: KraveoType.caption.copyWith(color: group.isRequired ? k.brand : k.inkMuted, fontSize: 11.5),
            ),
          ),
        ]),
        if (missing) ...[
          const SizedBox(height: 6),
          Row(children: [
            Icon(LucideIcons.circleAlert, size: 14, color: kDangerInk),
            const SizedBox(width: 6),
            Text('Pick at least one to continue', style: KraveoType.bodySm.copyWith(color: kDangerInk, fontWeight: FontWeight.w600)),
          ]),
        ],
        const SizedBox(height: 10),
        for (final option in group.options)
          if (isSingleChoice)
            _OptionTile(
              label: option.name,
              price: option.price,
              selected: _singleSelections[group.id]?.id == option.id,
              radio: true,
              onTap: () => setState(() {
                _singleSelections[group.id] = option;
                _missingGroupId = null;
              }),
            )
          else
            _OptionTile(
              label: option.name,
              price: option.price,
              selected: multiSet.any((o) => o.id == option.id),
              radio: false,
              onTap: () {
                final selected = multiSet.any((o) => o.id == option.id);
                if (!selected && multiSet.length >= group.maxSelection) {
                  setState(() => _missingGroupId = null);
                  ScaffoldMessenger.of(context)
                    ..hideCurrentSnackBar()
                    ..showSnackBar(SnackBar(content: Text('You can pick up to ${group.maxSelection} for ${group.title}')));
                  return;
                }
                setState(() {
                  final set = _multiSelections[group.id] ?? <CustomizationOption>{};
                  if (selected) {
                    set.removeWhere((o) => o.id == option.id);
                  } else {
                    set.add(option);
                  }
                  _multiSelections[group.id] = set;
                  _missingGroupId = null;
                });
              },
            ),
      ]),
    );
  }
}

class _OptionTile extends StatelessWidget {
  const _OptionTile({required this.label, required this.price, required this.selected, required this.radio, required this.onTap});

  final String label;
  final double price;
  final bool selected;
  final bool radio;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: KPressable(
        onTap: onTap,
        scale: 0.985,
        semanticLabel: '$label${price > 0 ? ', plus ${rupee(price)}' : ''}${selected ? ', selected' : ''}',
        child: AnimatedContainer(
          duration: KMotion.base,
          curve: KMotion.emphasized,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          decoration: BoxDecoration(
            color: selected ? k.brandSoft : k.surface,
            borderRadius: BorderRadius.circular(KRadius.md),
            border: Border.all(color: selected ? k.brand : k.line, width: selected ? 1.6 : 1.2),
          ),
          child: Row(children: [
            AnimatedContainer(
              duration: KMotion.fast,
              width: 22,
              height: 22,
              decoration: BoxDecoration(
                color: selected ? k.brand : Colors.transparent,
                shape: radio ? BoxShape.circle : BoxShape.rectangle,
                borderRadius: radio ? null : BorderRadius.circular(7),
                border: Border.all(color: selected ? k.brand : k.inkFaint, width: 1.6),
              ),
              child: selected
                  ? (radio
                      ? Center(child: Container(width: 8, height: 8, decoration: BoxDecoration(color: k.onBrand, shape: BoxShape.circle)))
                      : Icon(LucideIcons.check, size: 14, color: k.onBrand))
                  : null,
            ),
            const SizedBox(width: 12),
            Expanded(child: Text(price > 0 ? label.replaceAll(RegExp(r'\s*\(\+\s*\u20B9\s*\d+\)'), '') : label, style: KraveoType.body.copyWith(color: k.ink, fontWeight: FontWeight.w600))),
            if (price > 0) ...[
              const SizedBox(width: 8),
              Text('+${rupee(price)}', style: KraveoType.body.copyWith(color: k.brand, fontWeight: FontWeight.w700)),
            ],
          ]),
        ),
      ),
    );
  }
}
