import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../services/failure_messages.dart';
import 'ui/ui.dart';

/// Content of the "Add dish" bottom sheet. Present it with `showKSheet` (it supplies the
/// rounded sheet + drag handle); this widget only lays out the form.
class AddDishModal extends StatefulWidget {
  /// Saves the dish on Kraveo. Resolves to null on success (the sheet closes) or to what went wrong
  /// (the sheet stays open with the message, nothing typed is lost).
  final Future<FailureText?> Function(String name, String category, double price, bool inStock) onSubmit;

  const AddDishModal({super.key, required this.onSubmit});

  @override
  State<AddDishModal> createState() => _AddDishModalState();
}

class _AddDishModalState extends State<AddDishModal> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _priceController = TextEditingController();
  String _selectedCategory = 'Main Course';
  bool _inStock = true;
  bool _saving = false;
  FailureText? _error;

  final List<String> _categories = [
    'Main Course',
    'Breads',
    'Beverages',
    'Snacks',
    'Desserts',
    'Fast Food',
  ];

  @override
  void dispose() {
    _nameController.dispose();
    _priceController.dispose();
    super.dispose();
  }

  Future<void> _submitForm() async {
    if (_saving || !_formKey.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final problem = await widget.onSubmit(_nameController.text.trim(), _selectedCategory, double.parse(_priceController.text.trim()), _inStock);
    if (!mounted) return;
    if (problem == null) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _saving = false;
      _error = problem;
    });
  }

  Widget _fieldLabel(KraveoTokens k, String en, String hi) => Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 8),
        child: Text.rich(TextSpan(children: [
          TextSpan(text: en, style: KraveoType.titleMd.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
          TextSpan(text: '   $hi', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
        ])),
      );

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Add a dish', style: KraveoType.headline.copyWith(color: k.ink)),
                  Text('नया व्यंजन जोड़ें', style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
                ]),
              ),
              Semantics(
                button: true,
                label: 'Close',
                excludeSemantics: true,
                child: KPressable(
                  onTap: () => Navigator.pop(context),
                  child: Container(
                    width: 56,
                    height: 56,
                    decoration: BoxDecoration(color: k.surfaceAlt, shape: BoxShape.circle),
                    child: Icon(LucideIcons.x, size: 26, color: k.ink),
                  ),
                ),
              ),
            ]),
            const SizedBox(height: 18),

            _fieldLabel(k, 'Dish name', 'नाम'),
            TextFormField(
              controller: _nameController,
              textCapitalization: TextCapitalization.words,
              style: KraveoType.titleLg.copyWith(color: k.ink, fontSize: 20),
              decoration: InputDecoration(
                hintText: 'e.g. Butter Chicken',
                prefixIcon: Icon(LucideIcons.utensils, color: k.brand),
              ),
              validator: (val) {
                if (val == null || val.trim().isEmpty) {
                  return 'Please enter dish name';
                }
                return null;
              },
            ),
            const SizedBox(height: 18),

            _fieldLabel(k, 'Category', 'प्रकार'),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final cat in _categories)
                VChoiceChip(
                  label: cat,
                  sublabel: hindiCategory(cat),
                  selected: _selectedCategory == cat,
                  onTap: () => setState(() => _selectedCategory = cat),
                ),
            ]),
            const SizedBox(height: 18),

            _fieldLabel(k, 'Price', 'दाम'),
            TextFormField(
              controller: _priceController,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              style: KraveoType.displayMd.copyWith(color: k.ink, fontSize: 30),
              decoration: InputDecoration(
                hintText: '180',
                prefixIcon: Padding(
                  padding: const EdgeInsets.only(left: 18, right: 6),
                  child: Icon(LucideIcons.indianRupee, size: 26, color: k.brand),
                ),
                prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
              ),
              validator: (val) {
                if (val == null || val.trim().isEmpty) {
                  return 'Please enter price';
                }
                final p = double.tryParse(val.trim());
                if (p == null || p <= 0) {
                  return 'Enter a valid price';
                }
                return null;
              },
            ),
            const SizedBox(height: 18),

            _fieldLabel(k, 'Available now?', 'अभी उपलब्ध है?'),
            VStockSwitch(inStock: _inStock, onToggle: () => setState(() => _inStock = !_inStock), dishName: 'New dish'),
            const SizedBox(height: 24),

            if (_error != null) ...[
              Text('Not saved: ${_error!.english}', key: const ValueKey('add-dish-error'), style: KraveoType.titleMd.copyWith(color: kDangerDeep, fontSize: 15)),
              Text(_error!.hindi, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
              const SizedBox(height: 10),
            ],
            KButton(label: 'Add to menu', sublabel: 'मेनू में जोड़ें', icon: LucideIcons.plus, large: true, loading: _saving, onPressed: _saving ? null : _submitForm),
          ],
        ),
      ),
    );
  }
}
