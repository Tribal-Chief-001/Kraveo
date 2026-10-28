import 'dart:math' as math;
import 'dart:ui';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import '../theme/tokens.dart';
import '../tokens/foundation.dart';
import '../tokens/typography.dart';
import 'glass_nav.dart' show KNavItem;
import 'pressable.dart';

const double _kIcon = 22;
const double _kGap = 8; // icon to label
final TextStyle _kLabel = KraveoType.label.copyWith(fontSize: 13);

/// A [PageController]'s page as a [ValueListenable] (0 when nothing is attached yet), so a
/// widget can follow a pager without knowing about it.
class KPagePosition extends ChangeNotifier implements ValueListenable<double> {
  KPagePosition(this.controller) {
    _value = _read();
    controller.addListener(_changed);
  }

  final PageController controller;
  late double _value;

  @override
  double get value => _value;

  double _read() {
    if (!controller.hasClients || controller.positions.length != 1 || !controller.position.hasPixels) {
      return controller.initialPage.toDouble();
    }
    return controller.page ?? controller.initialPage.toDouble();
  }

  void _changed() {
    final v = _read();
    if (v == _value) return;
    _value = v;
    notifyListeners();
  }

  @override
  void dispose() {
    controller.removeListener(_changed);
    super.dispose();
  }
}

/// Fluid bottom navigation: a floating blurred pill with ONE brand highlight that glides with
/// the pager (the page position, not the tapped index), so it follows a swipe finger-for-finger.
///
/// * The highlight stretches a little while it moves fast and settles with a spring.
/// * Icons tint and scale by how close the page position is; the selected label slides in beside
///   its icon. A label that does not fit (large text, narrow screen) is dropped: icon only.
/// * The selected icon pops, the badge pops in, a press scales the item to 0.94, and a light
///   haptic ticks when the selected tab changes (the tap's own haptic is not doubled).
/// * `MediaQuery.disableAnimations` removes the stretch, spring, pops and badge animation; the
///   highlight still follows the pager, because that is the finger (or an instant jump).
///
/// No business logic: pass either the pager's [controller] or any [position] (a page index as a
/// double) and handle [onTap]. Does not replace [KGlassNav], which other apps still use.
class KFluidNav extends StatefulWidget {
  KFluidNav({super.key, required this.items, required this.onTap, this.controller, this.position, this.height = 68})
      : assert((controller == null) != (position == null), 'Pass exactly one of controller or position'),
        assert(items.length >= 2, 'A navigation needs at least two items');

  final List<KNavItem> items;
  final ValueChanged<int> onTap;
  final PageController? controller;
  final ValueListenable<double>? position;
  final double height;

  @override
  State<KFluidNav> createState() => _KFluidNavState();
}

class _KFluidNavState extends State<KFluidNav> with TickerProviderStateMixin {
  static const double _pad = 6; // pill inner padding
  static const double _slotMargin = 3; // gap between a slot and the highlight
  static const double _vInset = 9; // highlight inset from the pill's top and bottom
  static const double _labelPad = 10; // inside the highlight, left and right of icon + label

  KPagePosition? _own;
  late ValueListenable<double> _pos;
  final ValueNotifier<double> _stretch = ValueNotifier(0);
  late final AnimationController _pop = AnimationController(vsync: this, duration: const Duration(milliseconds: 420));
  late final Ticker _ticker = createTicker(_tick);

  late int _selected;
  int _popIndex = -1;
  int? _tapTarget;
  bool _reduce = false;

  // Stretch spring state.
  double _x = 0, _v = 0, _seen = 0, _prev = 0;
  Duration _last = Duration.zero;

  int get _n => widget.items.length;

  void _bind() {
    _own?.dispose();
    _own = widget.controller == null ? null : KPagePosition(widget.controller!);
    _pos = _own ?? widget.position!;
    _pos.addListener(_onPos);
    _seen = _prev = _pos.value;
  }

  @override
  void initState() {
    super.initState();
    _bind();
    _selected = _pos.value.round().clamp(0, _n - 1);
  }

  @override
  void didUpdateWidget(KFluidNav old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller || old.position != widget.position) {
      _pos.removeListener(_onPos);
      _bind();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduce = MediaQuery.disableAnimationsOf(context);
    if (_reduce && _ticker.isActive) {
      _ticker.stop();
      _x = _v = 0;
      _stretch.value = 0;
    }
  }

  @override
  void dispose() {
    _pos.removeListener(_onPos);
    _own?.dispose();
    _ticker.dispose();
    _pop.dispose();
    _stretch.dispose();
    super.dispose();
  }

  void _onPos() {
    final p = _pos.value;
    final sel = p.round().clamp(0, _n - 1);
    if (sel != _selected) {
      _selected = sel;
      if (_tapTarget != sel) HapticFeedback.selectionClick();
      _tapTarget = null;
      _popIcon(sel);
    }
    if (_reduce) return;
    if (!_ticker.isActive) {
      _prev = _seen;
      _last = Duration.zero;
      _ticker.start();
    }
    _seen = p;
  }

  void _popIcon(int index) {
    if (_reduce) return;
    _popIndex = index;
    _pop.forward(from: 0);
  }

  /// Highlight stretch: proportional to the page speed, driven by a lightly under-damped spring
  /// so it overshoots a hair and settles when the motion stops.
  void _tick(Duration elapsed) {
    final dt = (elapsed - _last).inMicroseconds / Duration.microsecondsPerSecond;
    _last = elapsed;
    if (dt <= 0) return;
    final speed = (_seen - _prev) / dt; // pages per second
    _prev = _seen;
    final target = (speed.abs() * 0.10).clamp(0.0, 0.35);
    final h = math.min(dt, 1 / 30);
    _v += (-380 * (_x - target) - 22 * _v) * h;
    _x += _v * h;
    if (speed == 0 && _x.abs() < 0.002 && _v.abs() < 0.02) {
      _x = _v = 0;
      _ticker.stop();
    }
    _stretch.value = _x;
  }

  void _tap(int i) {
    if (i == _selected) {
      _popIcon(i);
    } else {
      _tapTarget = i;
      HapticFeedback.selectionClick();
    }
    widget.onTap(i);
  }

  double _labelWidth(String text, TextScaler scaler) {
    final tp = TextPainter(text: TextSpan(text: text, style: _kLabel), textDirection: TextDirection.ltr, textScaler: scaler, maxLines: 1)..layout();
    final w = tp.width;
    tp.dispose();
    return w;
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final tint = k.shadowTint;
    return SafeArea(
      minimum: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: SizedBox(
        height: widget.height,
        child: DecoratedBox(
          // Shadows live outside the clip (inside it they would be cut off).
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(KRadius.pill),
            boxShadow: [
              BoxShadow(color: tint.withValues(alpha: k.isDark ? 0.40 : 0.07), blurRadius: 6, offset: const Offset(0, 2)),
              BoxShadow(color: tint.withValues(alpha: k.isDark ? 0.45 : 0.14), blurRadius: 34, offset: const Offset(0, 16)),
            ],
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(KRadius.pill),
            child: BackdropFilter(
              filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: (k.isDark ? k.surfaceAlt : k.surface).withValues(alpha: k.isDark ? 0.80 : 0.82),
                  borderRadius: BorderRadius.circular(KRadius.pill),
                  border: Border.all(color: k.line.withValues(alpha: 0.5)),
                ),
                position: DecorationPosition.background,
                child: Stack(children: [
                  // The 1 px inner highlight ("glass edge"), painted over the fill.
                  Positioned.fill(
                    child: IgnorePointer(
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(KRadius.pill),
                          border: Border.all(color: Colors.white.withValues(alpha: k.isDark ? 0.07 : 0.7)),
                        ),
                      ),
                    ),
                  ),
                  Positioned.fill(child: LayoutBuilder(builder: _buildTrack)),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildTrack(BuildContext context, BoxConstraints box) {
    final k = context.k;
    final n = _n;
    final inner = box.maxWidth - 2 * _pad;
    final scaler = MediaQuery.textScalerOf(context);

    // The selected slot is `extra` slots wider than the others, but the others keep >= 52 dp.
    // Which labels fit inside it? None -> icon only and a smaller bulge.
    double extra = math.min(1.5, math.max(0.25, inner / 52 - n));
    final selW = inner * (1 + extra) / (n + extra) - 2 * _slotMargin;
    final fits = [for (final it in widget.items) _kIcon + _kGap + _labelWidth(it.label, scaler) + 2 * _labelPad <= selW];
    if (!fits.contains(true)) extra = 0.25;

    return AnimatedBuilder(
      animation: Listenable.merge([_pos, _stretch, _pop]),
      builder: (context, _) {
        final p = _pos.value.clamp(0.0, n - 1.0);
        final weights = [for (var i = 0; i < n; i++) 1 + extra * math.max(0.0, 1 - (p - i).abs())];
        final total = weights.fold<double>(0, (a, b) => a + b);
        final lefts = <double>[];
        final widths = <double>[];
        var x = _pad;
        for (final w in weights) {
          lefts.add(x);
          widths.add(inner * w / total);
          x += widths.last;
        }
        final lo = p.floor().clamp(0, n - 1);
        final hi = math.min(lo + 1, n - 1);
        final t = p - lo;
        final stretch = _reduce ? 0.0 : _stretch.value.clamp(-0.12, 0.45);
        final slotW = lerpDouble(widths[lo], widths[hi], t)!;
        final blobW = (slotW - 2 * _slotMargin) * (1 + stretch);
        final center = lerpDouble(lefts[lo] + widths[lo] / 2, lefts[hi] + widths[hi] / 2, t)!;
        final blobH = (box.maxHeight - 2 * _vInset) * (1 - stretch * 0.12);

        final lighter = Color.lerp(k.brand, Colors.white, k.isDark ? 0.10 : 0.16)!;
        return Stack(clipBehavior: Clip.none, children: [
          Positioned(
            left: center - blobW / 2,
            width: blobW,
            top: (box.maxHeight - blobH) / 2,
            height: blobH,
            child: IgnorePointer(
              child: DecoratedBox(
                key: const ValueKey('k-fluid-nav-blob'),
                decoration: BoxDecoration(
                  gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [lighter, k.brand]),
                  borderRadius: BorderRadius.circular(KRadius.pill),
                  border: Border.all(color: Colors.white.withValues(alpha: 0.16)),
                  boxShadow: [BoxShadow(color: k.brand.withValues(alpha: k.isDark ? 0.30 : 0.34), blurRadius: 16, offset: const Offset(0, 6))],
                ),
              ),
            ),
          ),
          for (var i = 0; i < n; i++)
            Positioned(
              left: lefts[i],
              width: widths[i],
              top: 0,
              bottom: 0,
              child: _FluidNavItem(
                item: widget.items[i],
                index: i,
                count: n,
                presence: math.max(0.0, 1 - (p - i).abs()),
                selected: p.round() == i,
                showLabel: fits[i],
                bump: i == _popIndex && !_reduce ? math.sin(math.pi * Curves.easeOut.transform(_pop.value)) * 0.22 : 0,
                reduce: _reduce,
                onTap: () => _tap(i),
              ),
            ),
        ]);
      },
    );
  }
}

class _FluidNavItem extends StatelessWidget {
  const _FluidNavItem({
    required this.item,
    required this.index,
    required this.count,
    required this.presence,
    required this.selected,
    required this.showLabel,
    required this.bump,
    required this.reduce,
    required this.onTap,
  });

  final KNavItem item;
  final int index, count;
  final double presence, bump;
  final bool selected, showLabel, reduce;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final color = Color.lerp(k.inkFaint, k.onBrand, Curves.easeOut.transform(presence))!;
    final scale = 1 + 0.08 * presence + bump;
    final badge = item.badge;
    final label = '${item.label}${badge > 0 ? ', ${badge > 99 ? '99+' : badge} new' : ''}, tab ${index + 1} of $count';
    return Semantics(
      container: true,
      role: SemanticsRole.tab,
      label: label,
      selected: selected,
      onTap: onTap,
      child: ExcludeSemantics(
        child: KPressable(
          haptic: false,
          scale: 0.94,
          onTap: onTap,
          child: Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Transform.scale(
                  scale: scale,
                  child: Stack(clipBehavior: Clip.none, children: [
                    Icon(item.icon, size: _kIcon, color: color),
                    Positioned(top: -6, right: -10, child: _PopBadge(count: badge, reduce: reduce)),
                  ]),
                ),
                if (showLabel && presence > 0.01)
                  ClipRect(
                    child: Align(
                      alignment: Alignment.centerLeft,
                      widthFactor: Curves.easeOut.transform(presence),
                      child: Opacity(
                        opacity: Curves.easeIn.transform(presence),
                        child: Transform.translate(
                          offset: Offset(-8 * (1 - presence), 0),
                          child: Padding(
                            padding: const EdgeInsets.only(left: _kGap),
                            child: Text(item.label, maxLines: 1, softWrap: false, overflow: TextOverflow.clip, style: _kLabel.copyWith(color: k.onBrand)),
                          ),
                        ),
                      ),
                    ),
                  ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Count bubble: pops in (and bumps when the number changes); instant under reduce-motion.
class _PopBadge extends StatelessWidget {
  const _PopBadge({required this.count, required this.reduce});
  final int count;
  final bool reduce;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return AnimatedSwitcher(
      duration: reduce ? Duration.zero : const Duration(milliseconds: 320),
      switchInCurve: Curves.easeOutBack,
      switchOutCurve: Curves.easeIn,
      transitionBuilder: (child, anim) => ScaleTransition(scale: anim, child: child),
      child: count <= 0
          ? const SizedBox.shrink(key: ValueKey(0))
          : Container(
              key: ValueKey(count),
              constraints: const BoxConstraints(minWidth: 16, minHeight: 16),
              padding: const EdgeInsets.symmetric(horizontal: 4),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: k.accent,
                borderRadius: BorderRadius.circular(KRadius.pill),
                border: Border.all(color: (k.isDark ? k.surfaceAlt : k.surface).withValues(alpha: 0.9), width: 1.5),
              ),
              child: Text(count > 99 ? '99+' : '$count', style: KraveoType.caption.copyWith(color: k.onAccent, fontSize: 10, height: 1.1, fontWeight: FontWeight.w800)),
            ),
    );
  }
}
