import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/dish_model.dart';
import 'ui/ui.dart';

class StockCard extends StatelessWidget {
  final DishModel dish;
  final VoidCallback onToggleStock;
  final Function(double newPrice) onUpdatePrice;

  /// Sends a rejected dish to Kraveo again with this price. Without it, a rejected dish uses [onUpdatePrice].
  final Function(double price)? onResubmit;

  const StockCard({
    super.key,
    required this.dish,
    required this.onToggleStock,
    required this.onUpdatePrice,
    this.onResubmit,
  });

  void _resubmit(double price) => (onResubmit ?? onUpdatePrice)(price);

  void _showPriceEditSheet(BuildContext context) {
    showKSheet<void>(
      context,
      builder: (ctx) => _PriceEditSheet(dish: dish, onSave: dish.status == DishStatus.rejected ? _resubmit : onUpdatePrice),
    );
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final inStock = dish.inStock || !dish.isLive; // "sold out" only means something for a live dish
    final rejected = dish.status == DishStatus.rejected;
    final hindi = hindiCategory(dish.category);

    return AnimatedContainer(
      duration: KMotion.base,
      curve: KMotion.emphasized,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: inStock ? k.surface : Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.06), k.surface),
        borderRadius: KRadius.card,
        border: Border.all(color: (inStock && !rejected) ? k.line : KraveoPalette.danger.withValues(alpha: 0.55), width: (inStock && !rejected) ? 1.5 : 2),
        boxShadow: KShadow.soft(k.shadowTint),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
            _DishPhoto(imageUrl: dish.imageUrl, dimmed: !inStock || rejected),
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
                const SizedBox(height: 8),
                // Only a dish the server reported a status for gets a chip; an old server has no approval step.
                if (dish.statusKnown) VDishStatusChip(key: ValueKey('chip-${dish.id}'), status: dish.status),
              ]),
            ),
          ]),
          const SizedBox(height: 14),

          // Price stepper: big - / + around a tappable price (a rejected dish has no steppers: fix it, then send again)
          Row(children: [
            if (!rejected)
              _StepButton(
                key: const ValueKey('price-minus'),
                icon: LucideIcons.minus,
                semanticLabel: 'Lower price by 10 rupees',
                enabled: dish.editPrice > 10,
                onTap: () {
                  if (dish.editPrice > 10) {
                    onUpdatePrice(dish.editPrice - 10);
                  }
                },
              ),
            Expanded(
              child: Semantics(
                button: true,
                label: 'Your price ${formatRupees(dish.price)}. Double tap to type a new price.',
                excludeSemantics: true,
                child: KPressable(
                  onTap: () => _showPriceEditSheet(context),
                  scale: 0.97,
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 64),
                    alignment: Alignment.center,
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        Row(mainAxisSize: MainAxisSize.min, children: [
                          Text(formatRupees(dish.price), key: const ValueKey('your-price'), style: KraveoType.displayMd.copyWith(fontSize: 34, color: (inStock && !rejected) ? k.brand : k.inkMuted)),
                          const SizedBox(width: 8),
                          Icon(LucideIcons.pencil, size: 18, color: k.inkFaint),
                        ]),
                        Text('Your price · आपका दाम', maxLines: 1, style: KraveoType.caption.copyWith(color: k.inkMuted, fontSize: 12.5, fontWeight: FontWeight.w700)),
                      ]),
                    ),
                  ),
                ),
              ),
            ),
            if (!rejected)
              _StepButton(
                key: const ValueKey('price-plus'),
                icon: LucideIcons.plus,
                semanticLabel: 'Raise price by 10 rupees',
                onTap: () => onUpdatePrice(dish.editPrice + 10),
              ),
          ]),
          const SizedBox(height: 14),

          if (dish.statusKnown && dish.status != DishStatus.live) ...[
            _ApprovalNote(dish: dish, onResubmit: () => _resubmit(dish.price)),
            if (dish.isLive) const SizedBox(height: 14),
          ],

          // The one big IN STOCK / SOLD OUT switch (live dishes only; a dish customers cannot see has nothing to sell out)
          if (dish.isLive) VStockSwitch(inStock: inStock, onToggle: onToggleStock, dishName: dish.name),
        ],
      ),
    );
  }
}

/// What is happening with this dish at Kraveo: waiting, a price change waiting (old price stays live), or the
/// rejection reason with a button to send it again.
class _ApprovalNote extends StatelessWidget {
  const _ApprovalNote({required this.dish, required this.onResubmit});
  final DishModel dish;
  final VoidCallback onResubmit;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    switch (dish.status) {
      case DishStatus.changePending:
        return Container(
          key: const ValueKey('price-change-note'),
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Color.alphaBlend(KraveoPalette.warning.withValues(alpha: 0.14), k.surface), borderRadius: BorderRadius.circular(KRadius.lg)),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(LucideIcons.clock, size: 22, color: k.ink),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(
                  dish.pendingPrice == null ? 'New price sent for approval' : 'New price ${formatRupees(dish.pendingPrice!)} · Sent for approval',
                  key: const ValueKey('pending-price'),
                  style: KraveoType.titleMd.copyWith(color: k.ink, fontWeight: FontWeight.w800, fontSize: 16),
                ),
                Text(
                  'Customers still get the old price (${formatRupees(dish.price)}) until Kraveo approves.\nमंज़ूरी तक पुराना दाम चलेगा।',
                  style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13.5),
                ),
              ]),
            ),
          ]),
        );
      case DishStatus.pending:
        return Container(
          key: const ValueKey('pending-note'),
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Color.alphaBlend(KraveoPalette.warning.withValues(alpha: 0.14), k.surface), borderRadius: BorderRadius.circular(KRadius.lg)),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(LucideIcons.clock, size: 22, color: k.ink),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                'Waiting for Kraveo to approve. Customers cannot see this dish yet.\nKraveo की मंज़ूरी का इंतज़ार। ग्राहकों को अभी नहीं दिखेगा।',
                style: KraveoType.bodySm.copyWith(color: k.ink, fontSize: 14),
              ),
            ),
          ]),
        );
      case DishStatus.rejected:
        final reason = dish.rejectionReason;
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            key: const ValueKey('rejected-note'),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.08), k.surface), borderRadius: BorderRadius.circular(KRadius.lg)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Kraveo did not approve this dish · मंज़ूर नहीं हुआ', style: KraveoType.titleMd.copyWith(color: kDangerDeep, fontWeight: FontWeight.w800, fontSize: 16)),
              if (reason != null) Text('Reason: $reason', key: const ValueKey('rejection-reason'), style: KraveoType.body.copyWith(color: k.ink, fontSize: 15)),
              Text('Fix the price if needed, then send it again.\nदाम ठीक करके दोबारा भेजें।', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13.5)),
            ]),
          ),
          const SizedBox(height: 12),
          KButton(
            key: ValueKey('resubmit-${dish.id}'),
            label: 'Send again for approval',
            sublabel: 'फिर से भेजें',
            icon: LucideIcons.send,
            large: true,
            onPressed: onResubmit,
          ),
        ]);
      case DishStatus.live:
        return const SizedBox.shrink();
    }
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
  late final TextEditingController _controller = TextEditingController(text: priceFieldText(widget.dish.editPrice));
  String? _error;

  bool get _rejected => widget.dish.status == DishStatus.rejected;

  /// A live dish's price is a request: Kraveo approves it, and the old price stays live until then.
  bool get _asksApproval => widget.dish.statusKnown && widget.dish.isLive;

  String _helperText() {
    if (_rejected) return 'Kraveo will check the dish again.\nKraveo इसे दोबारा जाँचेगा।';
    if (_asksApproval) return 'The new price is sent to Kraveo. The old price stays live until it is approved.\nनया दाम Kraveo को जाएगा। मंज़ूरी तक पुराना दाम चलेगा।';
    if (widget.dish.statusKnown) return 'This dish is still waiting for approval, so the price changes at once.\nमंज़ूरी से पहले दाम सीधे बदल जाएगा।';
    return 'The price you receive for each portion.\nहर प्लेट पर आपको मिलने वाला दाम।';
  }

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
    // A rejected dish is sent again even with the same price; otherwise only a real change is saved.
    if (_rejected || parsed != widget.dish.editPrice) widget.onSave(parsed);
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(_rejected ? 'Fix price, send again' : 'Change price', style: KraveoType.headline.copyWith(color: k.ink)),
        Text(_rejected ? 'दाम ठीक करके फिर भेजें' : 'दाम बदलें', style: KraveoType.titleLg.copyWith(color: k.inkMuted)),
        const SizedBox(height: 6),
        Text(widget.dish.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
        const SizedBox(height: 6),
        Text(_helperText(), key: const ValueKey('price-helper'), style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
        const SizedBox(height: 16),
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 6),
          child: Text.rich(TextSpan(children: [
            TextSpan(text: 'Your price', style: KraveoType.titleMd.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
            TextSpan(text: '   आपका दाम', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
          ])),
        ),
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
        KButton(
          label: _rejected ? 'Send for approval' : (_asksApproval ? 'Send for approval' : 'Save price'),
          sublabel: _rejected || _asksApproval ? 'मंज़ूरी के लिए भेजें' : 'दाम सेव करें',
          icon: _rejected || _asksApproval ? LucideIcons.send : LucideIcons.check,
          large: true,
          onPressed: _save,
        ),
      ]),
    );
  }
}
