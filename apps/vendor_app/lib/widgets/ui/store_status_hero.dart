import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'vendor_ui.dart';

/// The store OPEN / CLOSED control. Huge, bilingual, one tap. Open = glowing forest
/// green with a breathing halo; closed = calm muted red. The parent decides what a tap
/// does (opening is instant, closing asks for confirmation).
class VStoreStatusHero extends StatefulWidget {
  const VStoreStatusHero({super.key, required this.isOpen, required this.onTap, this.storeName});
  final bool isOpen;
  final VoidCallback onTap;
  final String? storeName;

  @override
  State<VStoreStatusHero> createState() => _VStoreStatusHeroState();
}

class _VStoreStatusHeroState extends State<VStoreStatusHero> with SingleTickerProviderStateMixin {
  late final AnimationController _breath = AnimationController(vsync: this, duration: const Duration(milliseconds: 2200));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (still) {
      _breath.stop();
    } else if (!_breath.isAnimating) {
      _breath.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _breath.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final open = widget.isOpen;
    final closedBg = Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.10), k.surface);
    final bg = open ? k.brand : closedBg;
    final fg = open ? k.onBrand : k.ink;
    final sub = open ? k.onBrand.withValues(alpha: 0.9) : k.inkMuted;

    return Semantics(
      button: true,
      excludeSemantics: true,
      label: open ? 'Store is open. Double tap to close the store.' : 'Store is closed. Double tap to open the store.',
      onTap: widget.onTap,
      child: KPressable(
        onTap: widget.onTap,
        scale: 0.985,
        child: AnimatedBuilder(
          animation: _breath,
          builder: (context, child) {
            final glow = open ? 0.25 + 0.25 * _breath.value : 0.0;
            return AnimatedContainer(
              duration: KMotion.slow,
              curve: KMotion.emphasized,
              constraints: const BoxConstraints(minHeight: 88),
              padding: const EdgeInsets.fromLTRB(20, 10, 14, 10),
              decoration: BoxDecoration(
                color: bg,
                borderRadius: BorderRadius.circular(KRadius.xl + 4),
                border: Border.all(color: open ? k.brand : KraveoPalette.danger.withValues(alpha: 0.45), width: 2),
                boxShadow: open
                    ? [BoxShadow(color: k.brand.withValues(alpha: glow), blurRadius: 18 + 18 * _breath.value, spreadRadius: 1 + 3 * _breath.value, offset: const Offset(0, 6))]
                    : KShadow.soft(k.shadowTint),
              ),
              child: child,
            );
          },
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                    Text(open ? 'OPEN' : 'CLOSED', style: KraveoType.displayLg.copyWith(fontSize: 42, color: open ? fg : kDangerDeep, height: 1.1)),
                    const SizedBox(width: 12),
                    Text(open ? 'खुला' : 'बंद', style: KraveoType.headline.copyWith(fontSize: 26, color: fg, height: 1.2)),
                  ]),
                ),
                Text(
                  open ? 'Tap to close store' : 'Tap to open store',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: KraveoType.bodySm.copyWith(color: sub, fontSize: 14),
                ),
              ]),
            ),
            const SizedBox(width: 12),
            _PowerKnob(open: open),
          ]),
        ),
      ),
    );
  }
}

class _PowerKnob extends StatelessWidget {
  const _PowerKnob({required this.open});
  final bool open;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return AnimatedContainer(
      duration: KMotion.base,
      curve: KMotion.emphasized,
      width: 60,
      height: 60,
      decoration: BoxDecoration(
        color: open ? k.onBrand : kDangerDeep,
        shape: BoxShape.circle,
      ),
      child: Icon(LucideIcons.power, size: 30, color: open ? k.brand : k.onBrand),
    );
  }
}
