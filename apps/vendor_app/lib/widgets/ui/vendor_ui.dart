import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Shared helpers for the vendor app UI. Colours come from the Kraveo tokens
/// (`context.k`, `KraveoPalette`, `KStatus`) - never hex literals.

/// Content never gets wider than this, so tablets show a readable centred column.
const double kContentMaxWidth = 640;

/// A slightly deeper danger red so white text on solid red passes contrast.
final Color kDangerDeep = Color.alphaBlend(Colors.black.withValues(alpha: 0.18), KraveoPalette.danger);

/// Centres [child] and caps its width at [kContentMaxWidth].
class VMaxWidth extends StatelessWidget {
  const VMaxWidth({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: kContentMaxWidth), child: child),
      );
}

/// Indian-grouped rupee text: 1240 -> "₹1,240", 125000 -> "₹1,25,000".
String formatRupees(num value) {
  final n = value.round();
  final neg = n < 0;
  final digits = n.abs().toString();
  String grouped;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    final last3 = digits.substring(digits.length - 3);
    var rest = digits.substring(0, digits.length - 3);
    final parts = <String>[];
    while (rest.length > 2) {
      parts.insert(0, rest.substring(rest.length - 2));
      rest = rest.substring(0, rest.length - 2);
    }
    if (rest.isNotEmpty) parts.insert(0, rest);
    grouped = '${parts.join(',')},$last3';
  }
  return '${neg ? '-' : ''}₹$grouped';
}

/// Hindi name for the menu categories the app knows about (falls back to '').
String hindiCategory(String category) => switch (category) {
      'All' => 'सभी',
      'Main Course' => 'मुख्य खाना',
      'Breads' => 'रोटी',
      'Beverages' => 'पेय',
      'Snacks' => 'नाश्ता',
      'Fast Food' => 'फास्ट फूड',
      'Desserts' => 'मिठाई',
      _ => '',
    };

/// Small bilingual section label: "Cooking  बन रहे हैं   2".
class VSectionLabel extends StatelessWidget {
  const VSectionLabel({super.key, required this.english, required this.hindi, this.count, this.color});
  final String english;
  final String hindi;
  final int? count;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final c = color ?? k.ink;
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 8, 4, 12),
      child: Row(children: [
        Flexible(
          child: Text.rich(
            TextSpan(children: [
              TextSpan(text: english, style: KraveoType.headlineSm.copyWith(color: c)),
              TextSpan(text: '   $hindi', style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
            ]),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        if (count != null) ...[
          const SizedBox(width: 10),
          Container(
            constraints: const BoxConstraints(minWidth: 32),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.pill)),
            child: Text('$count', textAlign: TextAlign.center, style: KraveoType.titleMd.copyWith(color: k.brand, fontWeight: FontWeight.w800)),
          ),
        ],
      ]),
    );
  }
}

/// Highlighted "customer note" callout: red border + tint so a cook can't miss
/// "no onions" or "extra spicy". Used on the incoming-order screen and order cards.
class VNoteCallout extends StatelessWidget {
  const VNoteCallout({super.key, required this.note, this.compact = false});
  final String note;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      label: 'Customer note: $note',
      excludeSemantics: true,
      child: Container(
        width: double.infinity,
        padding: EdgeInsets.all(compact ? 14 : 16),
        decoration: BoxDecoration(
          color: Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.10), k.surface),
          borderRadius: BorderRadius.circular(KRadius.lg),
          border: Border.all(color: KraveoPalette.danger, width: 2),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(LucideIcons.messageSquareWarning, size: compact ? 24 : 28, color: kDangerDeep),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Customer note · ग्राहक नोट', style: KraveoType.label.copyWith(color: kDangerDeep, fontSize: 13)),
              const SizedBox(height: 4),
              Text(note, style: KraveoType.titleLg.copyWith(color: k.ink, fontSize: compact ? 19 : 21, height: 1.25, fontWeight: FontWeight.w800)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// Count-up money text with Indian grouping ("₹1,130"), like [KAnimatedNumber] but formatted.
class VMoneyCount extends StatelessWidget {
  const VMoneyCount({super.key, required this.value, required this.style});
  final num value;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: value.toDouble()),
      duration: KMotion.slow,
      curve: KMotion.emphasized,
      builder: (_, v, __) => Text(formatRupees(v), style: style),
    );
  }
}
