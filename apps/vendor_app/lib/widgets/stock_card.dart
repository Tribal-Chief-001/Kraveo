import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/dish_model.dart';
import 'ui/ui.dart';

class StockCard extends StatelessWidget {
  final DishModel dish;
  final VoidCallback onToggleStock;
  final Function(double newPrice) onUpdatePrice;

  const StockCard({
    super.key,
    required this.dish,
    required this.onToggleStock,
    required this.onUpdatePrice,
  });

  void _showPriceEditSheet(BuildContext context) {
    showKSheet<void>(
      context,
      builder: (ctx) => _PriceEditSheet(dish: dish, onSave: onUpdatePrice),
    );
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final inStock = dish.inStock;
    final hindi = hindiCategory(dish.category);

    return AnimatedContainer(
      duration: KMotion.base,
      curve: KMotion.emphasized,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: inStock ? k.surface : Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.06), k.surface),
        borderRadius: KRadius.card,
        border: Border.all(color: inStock ? k.line : KraveoPalette.danger.withValues(alpha: 0.55), width: inStock ? 1.5 : 2),
        boxShadow: KShadow.soft(k.shadowTint),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
            _DishPhoto(imageUrl: dish.imageUrl, dimmed: !inStock),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(
                  dish.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: KraveoType.titleLg.copyWith(
                    fontSize: 21,
                    fontWeight: FontWeight.w800,
                    height: 1.2,
                    color: inStock ? k.ink : k.inkMuted,
                    decoration: inStock ? null : TextDecoration.lineThrough,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  hindi.isEmpty ? dish.category : '${dish.category} · $hindi',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14),
                ),
              ]),
            ),
          ]),
          const SizedBox(height: 14),

          // Price stepper: big - / + around a tappable price
          Row(children: [
            _StepButton(
              key: const ValueKey('price-minus'),
              icon: LucideIcons.minus,
              semanticLabel: 'Lower price by 10 rupees',
              enabled: dish.price > 10,
              onTap: () {
                if (dish.price > 10) {
                  onUpdatePrice(dish.price - 10);
                }
              },
            ),
            Expanded(
              child: Semantics(
                button: true,
                label: 'Price ${formatRupees(dish.price)}. Double tap to type a new price.',
                excludeSemantics: true,
                child: KPressable(
                  onTap: () => _showPriceEditSheet(context),
                  scale: 0.97,
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 64),
                    alignment: Alignment.center,
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Text(formatRupees(dish.price), style: KraveoType.displayMd.copyWith(fontSize: 34, color: inStock ? k.brand : k.inkMuted)),
                        const SizedBox(width: 8),
                        Icon(LucideIcons.pencil, size: 18, color: k.inkFaint),
                      ]),
                    ),
                  ),
                ),
              ),
            ),
            _StepButton(
              key: const ValueKey('price-plus'),
              icon: LucideIcons.plus,
              semanticLabel: 'Raise price by 10 rupees',
              onTap: () => onUpdatePrice(dish.price + 10),
            ),
          ]),
          const SizedBox(height: 14),

          // The one big IN STOCK / SOLD OUT switch
          VStockSwitch(inStock: inStock, onToggle: onToggleStock, dishName: dish.name),
        ],
      ),
    );
  }
}

class _StepButton extends StatelessWidget {
  const _StepButton({super.key, required this.icon, required this.semanticLabel, required this.onTap, this.enabled = true});
  final IconData icon;
  final String semanticLabel;
  final VoidCallback onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      button: true,
      enabled: enabled,
      label: semanticLabel,
      excludeSemantics: true,
      onTap: enabled ? onTap : null,
      child: Opacity(
        opacity: enabled ? 1 : 0.4,
        child: KPressable(
          onTap: enabled ? onTap : null,
          child: Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: k.brandSoft,
              borderRadius: BorderRadius.circular(KRadius.lg),
              border: Border.all(color: k.brand.withValues(alpha: 0.35), width: 1.5),
            ),
            child: Icon(icon, size: 30, color: k.brand),
          ),
        ),
      ),
    );
  }
}

class _DishPhoto extends StatelessWidget {
  const _DishPhoto({required this.imageUrl, required this.dimmed});
  final String? imageUrl;
  final bool dimmed;

  // Luminance-only colour matrix -> black & white for sold-out dishes.
  static const _grey = ColorFilter.matrix(<double>[
    0.2126, 0.7152, 0.0722, 0, 0,
    0.2126, 0.7152, 0.0722, 0, 0,
    0.2126, 0.7152, 0.0722, 0, 0,
    0, 0, 0, 1, 0,
  ]);

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final placeholder = Container(
      color: k.brandSoft,
      alignment: Alignment.center,
      child: Icon(LucideIcons.utensils, size: 32, color: k.brand),
    );
    final url = imageUrl;
    Widget photo = (url == null || url.isEmpty)
        ? placeholder
        : Image.network(url, fit: BoxFit.cover, errorBuilder: (_, __, ___) => placeholder);
    if (dimmed) {
      photo = Opacity(opacity: 0.55, child: ColorFiltered(colorFilter: _grey, child: photo));
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(KRadius.lg),
      child: SizedBox(width: 76, height: 76, child: photo),
    );
  }
}

class _PriceEditSheet extends StatefulWidget {
  const _PriceEditSheet({required this.dish, required this.onSave});
  final DishModel dish;
  final Function(double newPrice) onSave;

  @override
  State<_PriceEditSheet> createState() => _PriceEditSheetState();
}

/// Highest price the server accepts for a dish.
const double kMaxDishPrice = 10000;

/// What the owner typed in the price box as a number, or null when it is not a usable price. Accepts Devanagari
/// digits (a Hindi keyboard), a comma as the decimal mark, a leading rupee sign and spaces; at most 2 decimals are kept.
double? parseDishPrice(String raw) {
  final buf = StringBuffer();
  for (final unit in raw.trim().runes) {
    if (unit >= 0x0966 && unit <= 0x096F) {
      buf.writeCharCode(0x30 + unit - 0x0966); // Devanagari digit -> ASCII
    } else if (unit == 0x20 || unit == 0xA0 || unit == 0x20B9) {
      continue; // space, no-break space, rupee sign
    } else if (unit == 0x2C) {
      buf.write('.');
    } else {
      buf.writeCharCode(unit);
    }
  }
  final text = buf.toString();
  if (!RegExp(r'^\d+(\.\d*)?$|^\.\d+$').hasMatch(text)) return null;
  final value = double.tryParse(text);
  if (value == null || !value.isFinite) return null;
  return (value * 100).round() / 100;
}

/// "49" for a whole price, "49.50" when it has paise, so opening the sheet never silently rounds a price.
String priceFieldText(double price) => price == price.roundToDouble() ? price.toStringAsFixed(0) : price.toStringAsFixed(2);

class _PriceEditSheetState extends State<_PriceEditSheet> {
  late final TextEditingController _controller = TextEditingController(text: priceFieldText(widget.dish.price));
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _save() {
    final parsed = parseDishPrice(_controller.text);
    if (parsed == null || parsed <= 0 || parsed > kMaxDishPrice) {
      setState(() => _error = 'Enter a price from ₹1 to ₹10,000, like 120 or 49.50.\nसही दाम डालें, जैसे 120 या 49.50');
      return;
    }
    if (parsed != widget.dish.price) widget.onSave(parsed);
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Change price', style: KraveoType.headline.copyWith(color: k.ink)),
        Text('दाम बदलें', style: KraveoType.titleLg.copyWith(color: k.inkMuted)),
        const SizedBox(height: 6),
        Text(widget.dish.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
        const SizedBox(height: 16),
        TextField(
          key: const ValueKey('price-field'),
          controller: _controller,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          style: KraveoType.displayMd.copyWith(color: k.ink, fontSize: 36),
          onChanged: (_) {
            if (_error != null) setState(() => _error = null);
          },
          onSubmitted: (_) => _save(),
          decoration: InputDecoration(
            errorText: _error,
            errorMaxLines: 3,
            prefixIcon: Padding(
              padding: const EdgeInsets.only(left: 18, right: 6),
              child: Icon(LucideIcons.indianRupee, size: 30, color: k.brand),
            ),
            prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
            hintText: '0',
          ),
        ),
        const SizedBox(height: 20),
        KButton(label: 'Save price', sublabel: 'दाम सेव करें', icon: LucideIcons.check, large: true, onPressed: _save),
      ]),
    );
  }
}
