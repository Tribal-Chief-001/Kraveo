import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/menu_item.dart';
import '../models/customization.dart';

class CustomizationModal extends StatefulWidget {
  final MenuItemModel item;
  final Function(List<CustomizationOption> selectedOptions, String? notes) onAddToCart;

  const CustomizationModal({
    super.key,
    required this.item,
    required this.onAddToCart,
  });

  @override
  State<CustomizationModal> createState() => _CustomizationModalState();
}

class _CustomizationModalState extends State<CustomizationModal> {
  final Map<String, CustomizationOption> _singleSelections = {};
  final Map<String, Set<CustomizationOption>> _multiSelections = {};
  final TextEditingController _notesController = TextEditingController();

  @override
  void initState() {
    super.initState();
    for (final group in widget.item.customizationGroups) {
      if (group.maxSelection == 1 && group.options.isNotEmpty) {
        // Pre-select first option for required single choice
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

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.85,
      ),
      decoration: const BoxDecoration(
        color: AppTheme.surfaceBackground,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Drag handle indicator
          Center(
            child: Container(
              margin: const EdgeInsets.only(top: 12, bottom: 8),
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: AppTheme.borderLight,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          
          // Header Item Info
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(
                            widget.item.isVeg ? Icons.radio_button_checked : Icons.crop_square,
                            color: widget.item.isVeg ? Colors.green : Colors.red,
                            size: 16,
                          ),
                          const SizedBox(width: 6),
                          Text(
                            widget.item.isVeg ? 'VEG' : 'NON-VEG',
                            style: TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.bold,
                              color: widget.item.isVeg ? Colors.green : Colors.red,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        widget.item.name,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                          color: AppTheme.textDark,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Base Price: ₹${widget.item.price.toInt()}',
                        style: const TextStyle(
                          color: AppTheme.textMuted,
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close, color: AppTheme.textMuted),
                  onPressed: () => Navigator.pop(context),
                ),
              ],
            ),
          ),
          const Divider(height: 1, color: AppTheme.borderLight),

          // Scrollable Customization Groups
          Flexible(
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
              children: [
                ...widget.item.customizationGroups.map((group) {
                  final isSingleChoice = group.maxSelection == 1;

                  return Padding(
                    padding: const EdgeInsets.only(bottom: 20.0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              group.title,
                              style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.bold,
                                color: AppTheme.textDark,
                              ),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: group.isRequired
                                    ? AppTheme.secondaryGold.withValues(alpha: 0.3)
                                    : AppTheme.surfaceVariant,
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                group.isRequired ? 'REQUIRED' : 'OPTIONAL',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.bold,
                                  color: group.isRequired
                                      ? AppTheme.secondaryTextGold
                                      : AppTheme.textMuted,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        ...group.options.map((option) {
                          if (isSingleChoice) {
                            final isSelected = _singleSelections[group.id]?.id == option.id;
                            return ListTile(
                              dense: true,
                              contentPadding: EdgeInsets.zero,
                              onTap: () {
                                setState(() {
                                  _singleSelections[group.id] = option;
                                });
                              },
                              leading: Icon(
                                isSelected ? Icons.radio_button_checked : Icons.radio_button_off,
                                color: isSelected ? AppTheme.primaryEmerald : AppTheme.textMuted,
                                size: 20,
                              ),
                              title: Text(
                                option.name,
                                style: const TextStyle(
                                  fontWeight: FontWeight.w600,
                                  fontSize: 14,
                                  color: AppTheme.textDark,
                                ),
                              ),
                              trailing: option.price > 0
                                  ? Text(
                                      '+₹${option.price.toInt()}',
                                      style: const TextStyle(
                                        color: AppTheme.primaryEmerald,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    )
                                  : null,
                            );
                          } else {
                            final set = _multiSelections[group.id] ?? {};
                            final isSelected = set.any((o) => o.id == option.id);
                            return CheckboxListTile(
                              dense: true,
                              activeColor: AppTheme.primaryEmerald,
                              contentPadding: EdgeInsets.zero,
                              title: Text(
                                option.name,
                                style: const TextStyle(
                                  fontWeight: FontWeight.w600,
                                  fontSize: 14,
                                  color: AppTheme.textDark,
                                ),
                              ),
                              secondary: option.price > 0
                                  ? Text(
                                      '+₹${option.price.toInt()}',
                                      style: const TextStyle(
                                        color: AppTheme.primaryEmerald,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    )
                                  : null,
                              value: isSelected,
                              onChanged: (checked) {
                                setState(() {
                                  if (checked == true) {
                                    set.add(option);
                                  } else {
                                    set.removeWhere((o) => o.id == option.id);
                                  }
                                  _multiSelections[group.id] = set;
                                });
                              },
                            );
                          }
                        }),
                      ],
                    ),
                  );
                }),

                // Special Notes Field
                const Text(
                  'Cooking Notes / Request',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                    color: AppTheme.textDark,
                  ),
                ),
                const SizedBox(height: 6),
                TextField(
                  controller: _notesController,
                  decoration: InputDecoration(
                    hintText: 'e.g. Less spicy, extra green chutney...',
                    hintStyle: const TextStyle(color: AppTheme.textMuted, fontSize: 13),
                    filled: true,
                    fillColor: Colors.white,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: const BorderSide(color: AppTheme.borderLight),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: const BorderSide(color: AppTheme.primaryEmerald, width: 1.5),
                    ),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  ),
                ),
                const SizedBox(height: 20),
              ],
            ),
          ),

          // Bottom Action Button
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.white,
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.08),
                  blurRadius: 10,
                  offset: const Offset(0, -4),
                )
              ],
            ),
            child: SafeArea(
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () {
                    for (final group in widget.item.customizationGroups) {
                      if (group.isRequired) {
                        final hasSingle = _singleSelections.containsKey(group.id);
                        final hasMulti = (_multiSelections[group.id] ?? {}).isNotEmpty;
                        if (!hasSingle && !hasMulti) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text('Please select required options for "${group.title}"'),
                              backgroundColor: Colors.red,
                            ),
                          );
                          return;
                        }
                      }
                    }
                    final notes = _notesController.text.trim();
                    widget.onAddToCart(allSelectedOptions, notes.isEmpty ? null : notes);
                    Navigator.pop(context);
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryEmerald,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Text(
                        'ADD ITEM',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                      ),
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: AppTheme.secondaryGold,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Text(
                          '₹${calculateTotalPrice.toInt()}',
                          style: const TextStyle(
                            color: AppTheme.secondaryTextGold,
                            fontWeight: FontWeight.w800,
                            fontSize: 14,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
