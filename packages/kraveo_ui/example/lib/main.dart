import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

void main() => runApp(const Gallery());

class Gallery extends StatefulWidget {
  const Gallery({super.key});
  @override
  State<Gallery> createState() => _GalleryState();
}

class _GalleryState extends State<Gallery> {
  int mode = int.tryParse(Uri.base.queryParameters['mode'] ?? '') ?? 0;
  int nav = 0;
  @override
  Widget build(BuildContext context) {
    final theme = [KraveoTheme.customer(), KraveoTheme.vendor(), KraveoTheme.driver()][mode];
    return MaterialApp(debugShowCheckedModeBanner: false, theme: theme, home: Builder(builder: (context) {
      final k = context.k;
      return Scaffold(
        extendBody: true,
        bottomNavigationBar: KGlassNav(index: nav, onChanged: (i) => setState(() => nav = i), items: const [
          KNavItem(LucideIcons.house, 'Home'), KNavItem(LucideIcons.search, 'Search'), KNavItem(LucideIcons.receipt, 'Orders', badge: 2), KNavItem(LucideIcons.user, 'Me'),
        ]),
        body: ListView(padding: const EdgeInsets.only(bottom: 120), children: [
          SafeArea(bottom: false, child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
            child: Row(children: [
              const KBrandMark(height: 44), const Spacer(),
              for (var i = 0; i < 3; i++) Padding(padding: const EdgeInsets.only(left: 6), child: KChoiceChip(label: ['Customer', 'Vendor', 'Driver'][i], selected: mode == i, onTap: () => setState(() => mode = i))),
            ]),
          )),
          Padding(padding: const EdgeInsets.fromLTRB(20, 24, 20, 0), child: Text('Late night\ncravings, sorted.', style: KraveoType.displayLg.copyWith(color: k.ink))),
          Padding(padding: const EdgeInsets.fromLTRB(20, 10, 20, 0), child: Text('Hot food from highway dhabas to your hostel gate.', style: KraveoType.body.copyWith(color: k.inkMuted))),
          const KSectionHeader('Buttons', action: 'See all'),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: Column(children: [
            KButton(label: 'Place order · ₹289', icon: LucideIcons.arrowRight, onPressed: () {}),
            const SizedBox(height: 12),
            KButton(label: 'Add to cart', kind: KButtonKind.accent, icon: LucideIcons.shoppingBag, onPressed: () {}),
            const SizedBox(height: 12),
            Row(children: [Expanded(child: KButton(label: 'Decline', sublabel: 'मना करें', kind: KButtonKind.danger, large: true, onPressed: () {})), const SizedBox(width: 12), Expanded(child: KButton(label: 'Accept', sublabel: 'स्वीकार करें', large: true, onPressed: () {}))]),
            const SizedBox(height: 12),
            Row(children: [Expanded(child: KButton(label: 'Details', kind: KButtonKind.ghost, onPressed: () {})), const SizedBox(width: 12), Expanded(child: KButton(label: 'Reorder', kind: KButtonKind.tonal, onPressed: () {}))]),
          ])),
          const KSectionHeader('Order status'),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: Wrap(spacing: 8, runSpacing: 8, children: [for (final s in KStatus.values) KStatusPill(status: s)])),
          const KSectionHeader('Stats'),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: Row(children: [
            Expanded(child: KStatTile(label: 'Today', icon: LucideIcons.wallet, value: KAnimatedNumber(value: 1240, prefix: '₹'), hint: '+18% vs yesterday')),
            const SizedBox(width: 12),
            Expanded(child: KStatTile(label: 'Deliveries', icon: LucideIcons.bike, tint: const Color(0xFF3B82F6), value: const KAnimatedNumber(value: 14), hint: 'avg 17 min')),
          ])),
          const KSectionHeader('Gate OTP'),
          const KOtpDisplay(code: '4829'),
          const KSectionHeader('Card + chips'),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: KCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [Expanded(child: Text('Sharma Highway Dhaba', style: KraveoType.titleLg.copyWith(color: k.ink))), const KStatusPill(status: KStatus.preparing, compact: true)]),
            const SizedBox(height: 6),
            Text('North Indian · Thalis · 25-30 min', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
            const SizedBox(height: 14),
            Wrap(spacing: 8, children: const [KSkeleton(width: 90, height: 14), KSkeleton(width: 60, height: 14)]),
          ]))),
          const SizedBox(height: 24),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: KSlideToConfirm(label: 'Slide to accept · ₹40', onConfirmed: () {})),
        ]),
      );
    }));
  }
}
