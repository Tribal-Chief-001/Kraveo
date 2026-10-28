import 'dart:async';

import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../models/home_banner.dart';
import '../providers/banner_provider.dart';
import '../services/external_links.dart';
import 'ui/k_image.dart';
import 'ui/snack.dart';

/// The Home promo slideshow (Docs/25 section 4). Takes no space until the [BannerProvider] has
/// banners (and nothing at all when the app has no such provider), so Home is unchanged without them.
///
/// Finite on purpose (no endless loop): the first and last card then hand a further swipe to the
/// tab pager ([KTabPagerHandoff]), and tap targets, dots and indices stay trivially right.
class HomeBannerCarousel extends StatelessWidget {
  const HomeBannerCarousel({super.key});

  @override
  Widget build(BuildContext context) {
    final provider = Provider.of<BannerProvider?>(context, listen: false);
    if (provider == null) return const SizedBox.shrink();
    final reduce = MediaQuery.disableAnimationsOf(context);
    return ListenableBuilder(
      listenable: provider,
      builder: (context, _) {
        final banners = provider.banners;
        final child = banners.isEmpty ? const SizedBox(width: double.infinity) : BannerStrip(provider: provider, banners: banners);
        if (reduce) return child; // no size animation (a zero-length AnimatedSize is not allowed to lay out)
        // Zero height (but full width, so only the height animates) until there is something to show.
        return AnimatedSize(
          duration: KMotion.slow,
          curve: KMotion.emphasized,
          alignment: Alignment.topCenter,
          clipBehavior: Clip.none, // the cards' shadows reach outside
          child: child,
        );
      },
    );
  }
}

/// The cards, the dots and the auto-advance. Public for tests.
class BannerStrip extends StatefulWidget {
  const BannerStrip({super.key, required this.provider, required this.banners});

  final BannerProvider provider;
  final List<HomeBanner> banners;

  static const double viewportFraction = 0.9;
  static const Duration interval = Duration(seconds: 5);
  static const Duration idleResume = Duration(seconds: 3);

  @override
  State<BannerStrip> createState() => _BannerStripState();
}

class _BannerStripState extends State<BannerStrip> with WidgetsBindingObserver {
  late final PageController _controller = PageController(viewportFraction: BannerStrip.viewportFraction);
  Timer? _timer;
  int _current = 0;
  int _touches = 0;
  bool _appResumed = true;
  bool _tabShown = true;
  bool _reduceMotion = false;
  int _decodeWidth = KImage.maxDecodePixels;

  List<HomeBanner> get _banners => widget.banners;

  /// Auto-advance runs only when something could change and nobody (finger, hidden tab, background
  /// app, "reduce motion") is against it.
  bool get _running => _banners.length > 1 && _tabShown && _appResumed && !_reduceMotion && _touches == 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final s = WidgetsBinding.instance.lifecycleState;
    _appResumed = s == null || s == AppLifecycleState.resumed;
    _sync();
    WidgetsBinding.instance.addPostFrameCallback((_) => _onShown());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final shown = TickerMode.valuesOf(context).enabled; // the shell turns tickers off on every tab but the resting one
    final reduce = MediaQuery.disableAnimationsOf(context);
    final changed = shown != _tabShown || reduce != _reduceMotion;
    _tabShown = shown;
    _reduceMotion = reduce;
    if (changed) {
      _sync(wait: BannerStrip.idleResume);
      _reportView();
    }
  }

  @override
  void didUpdateWidget(BannerStrip old) {
    super.didUpdateWidget(old);
    if (_current >= _banners.length) {
      _current = _banners.length - 1;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _controller.hasClients) _controller.jumpToPage(_current);
      });
    }
    _sync();
    _onShown();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _appResumed = state == AppLifecycleState.resumed;
    if (!_appResumed) unawaited(widget.provider.flushEvents());
    _sync(wait: BannerStrip.idleResume);
    _reportView();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  /// Starts or stops the timer to match [_running]; [wait] restarts it with that delay.
  void _sync({Duration? wait}) {
    if (!_running) {
      _timer?.cancel();
      _timer = null;
    } else if (wait != null || _timer == null) {
      _timer?.cancel();
      _timer = Timer(wait ?? BannerStrip.interval, _advance);
    }
  }

  void _advance() {
    _timer = null;
    if (!mounted || !_running || !_controller.hasClients) return _sync();
    final page = _controller.page?.round() ?? _current;
    unawaited(_controller.animateToPage((page + 1) % _banners.length, duration: const Duration(milliseconds: 750), curve: Curves.easeInOutCubicEmphasized));
    _sync(wait: BannerStrip.interval);
  }

  void _touch(int delta) {
    _touches = (_touches + delta).clamp(0, 10);
    _sync(wait: _touches == 0 ? BannerStrip.idleResume : null);
  }

  void _onShown() {
    if (!mounted) return;
    _reportView();
    _precacheNeighbours();
  }

  /// The card in front counts as one view per app session (the provider dedupes), while Home is the shown tab.
  void _reportView() {
    if (!mounted || !_tabShown || !_appResumed || _banners.isEmpty) return;
    widget.provider.recordView(_banners[_current.clamp(0, _banners.length - 1)].id);
  }

  void _precacheNeighbours() {
    for (final i in [_current - 1, _current + 1]) {
      if (i < 0 || i >= _banners.length) continue;
      precacheImage(_imageFor(_banners[i], _decodeWidth), context, onError: (_, __) {});
    }
  }

  void _onPage(int i) {
    _current = i;
    _onShown();
  }

  Future<void> _open(HomeBanner b) async {
    final uri = b.linkUri;
    if (uri == null || !uri.isScheme('https')) return; // never anything but https, whatever the server said
    widget.provider.recordClick(b.id);
    final opened = await ExternalLinks.open(uri);
    if (!opened && mounted) showKSnack(context, 'Couldn\'t open this link', error: true);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return LayoutBuilder(builder: (context, constraints) {
      final cardW = constraints.maxWidth * BannerStrip.viewportFraction - 8;
      // 2:1 at normal text size; a little taller for big text (the text block also scales down to fit).
      final grow = (MediaQuery.textScalerOf(context).scale(14) / 14 - 1).clamp(0.0, 1.0) * 0.25;
      final cardH = cardW / 2 * (1 + grow);
      _decodeWidth = KImage.decodeSize(cardW * 1.2, cardH, MediaQuery.devicePixelRatioOf(context));
      final reduce = MediaQuery.disableAnimationsOf(context);
      return TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: 1),
        duration: reduce ? Duration.zero : KMotion.slow,
        curve: KMotion.emphasized,
        builder: (context, v, child) => Opacity(opacity: v, child: Transform.translate(offset: Offset(0, (1 - v) * 14), child: child)),
        child: Padding(
          padding: const EdgeInsets.only(top: 18),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            SizedBox(
              height: cardH,
              child: Listener(
                behavior: HitTestBehavior.translucent,
                onPointerDown: (_) => _touch(1),
                onPointerUp: (_) => _touch(-1),
                onPointerCancel: (_) => _touch(-1),
                child: KTabPagerHandoff(
                  child: PageView.builder(
                    controller: _controller,
                    physics: KTabPagerHandoff.pagePhysics,
                    clipBehavior: Clip.none, // shadows
                    itemCount: _banners.length,
                    onPageChanged: _onPage,
                    itemBuilder: (context, i) => Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: _BannerCard(
                        key: ValueKey(_banners[i].id),
                        banner: _banners[i],
                        index: i,
                        controller: _controller,
                        width: cardW,
                        height: cardH,
                        decodeWidth: _decodeWidth,
                        onTap: () => _open(_banners[i]),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            if (_banners.length > 1)
              ExcludeSemantics(
                child: Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: _Dots(controller: _controller, count: _banners.length, active: k.brand, inactive: k.inkFaint.withValues(alpha: 0.35)),
                ),
              ),
          ]),
        ),
      );
    });
  }
}

ImageProvider _imageFor(HomeBanner b, int decodeWidth) => ResizeImage.resizeIfNeeded(decodeWidth, null, NetworkImage(b.imageUrl));

/// The page position (fractional while swiping), also before the first layout.
double _pageOf(PageController c) => (c.hasClients ? c.page : null) ?? c.initialPage.toDouble();

class _Dots extends StatelessWidget {
  const _Dots({required this.controller, required this.count, required this.active, required this.inactive});

  final PageController controller;
  final int count;
  final Color active, inactive;

  @override
  Widget build(BuildContext context) {
    // Driven by the page position: the active dot stretches into a pill as the pages move.
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final page = _pageOf(controller);
        return Row(mainAxisSize: MainAxisSize.min, children: [
          for (var i = 0; i < count; i++)
            Builder(builder: (context) {
              final t = (1 - (page - i).abs()).clamp(0.0, 1.0);
              return Container(
                key: ValueKey('banner-dot-$i'),
                width: 6 + 16 * t,
                height: 6,
                margin: const EdgeInsets.symmetric(horizontal: 3),
                decoration: BoxDecoration(color: Color.lerp(inactive, active, t), borderRadius: BorderRadius.circular(KRadius.pill)),
              );
            }),
        ]);
      },
    );
  }
}

class _BannerCard extends StatefulWidget {
  const _BannerCard({
    super.key,
    required this.banner,
    required this.index,
    required this.controller,
    required this.width,
    required this.height,
    required this.decodeWidth,
    required this.onTap,
  });

  final HomeBanner banner;
  final int index;
  final PageController controller;
  final double width, height;
  final int decodeWidth;
  final VoidCallback onTap;

  @override
  State<_BannerCard> createState() => _BannerCardState();
}

class _BannerCardState extends State<_BannerCard> {
  bool _imageFailed = false;

  void _onImageFailed() {
    if (mounted && !_imageFailed) setState(() => _imageFailed = true);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final b = widget.banner;
    final w = widget.width, h = widget.height;
    // A card without its photo shows the brand gradient, whatever the theme: light text on it.
    final darkTheme = _imageFailed || b.theme == BannerTheme.dark;
    final fg = darkTheme ? Colors.white : KraveoPalette.ink;
    final overlay = darkTheme ? Colors.black : Colors.white;
    final ext = w * 0.08; // the photo is a little wider than the card, so it can drift
    // Built once per card state, reused by every animation frame below.
    final photo = SizedBox(
      width: w + 2 * ext,
      child: _BannerImage(provider: _imageFor(b, widget.decodeWidth), onFailed: _onImageFailed),
    );
    final visual = AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final delta = _pageOf(widget.controller) - widget.index;
        final away = delta.abs().clamp(0.0, 1.0);
        final near = 1 - away;
        Widget stage(double from, double to, Widget child) {
          final p = Interval(from, to, curve: Curves.easeOutCubic).transform(near);
          return Opacity(opacity: p, child: Transform.translate(offset: Offset(0, (1 - p) * 12), child: child));
        }

        return Transform.scale(
          scale: 1 - 0.06 * away,
          child: Container(
            width: w,
            height: h,
            decoration: BoxDecoration(borderRadius: KRadius.card, boxShadow: KShadow.soft(k.shadowTint)),
            foregroundDecoration: BoxDecoration(borderRadius: KRadius.card, border: Border.all(color: k.line)),
            child: ClipRRect(
              borderRadius: KRadius.card,
              child: Stack(fit: StackFit.expand, children: [
                Transform.translate(offset: Offset(delta.clamp(-1.0, 1.0) * ext, 0), child: OverflowBox(minWidth: w + 2 * ext, maxWidth: w + 2 * ext, child: photo)),
                DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [overlay.withValues(alpha: 0.0), overlay.withValues(alpha: darkTheme ? 0.78 : 0.9)],
                      stops: const [0.2, 1.0],
                    ),
                  ),
                ),
                if (away > 0) ColoredBox(color: k.bg.withValues(alpha: 0.4 * away)),
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Align(
                    alignment: Alignment.bottomLeft,
                    // Big text shrinks the block instead of overflowing the card.
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.bottomLeft,
                      child: SizedBox(
                        width: (w - 32) * 0.85,
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                          stage(0.45, 0.8, Text(b.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.headlineSm.copyWith(color: fg, fontSize: 20, height: 1.15))),
                          if (b.subtitle != null)
                            stage(0.55, 0.9, Padding(
                              padding: const EdgeInsets.only(top: 4),
                              child: Text(b.subtitle!, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: fg.withValues(alpha: 0.9))),
                            )),
                          if (b.hasLink && b.ctaLabel != null)
                            stage(0.65, 1.0, Padding(
                              padding: const EdgeInsets.only(top: 10),
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                                decoration: BoxDecoration(color: darkTheme ? k.accent : k.brand, borderRadius: BorderRadius.circular(KRadius.pill)),
                                child: Row(mainAxisSize: MainAxisSize.min, children: [
                                  Flexible(child: Text(b.ctaLabel!, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: darkTheme ? k.onAccent : k.onBrand, fontSize: 13))),
                                  const SizedBox(width: 6),
                                  Icon(LucideIcons.arrowRight, size: 14, color: darkTheme ? k.onAccent : k.onBrand),
                                ]),
                              ),
                            )),
                        ]),
                      ),
                    ),
                  ),
                ),
              ]),
            ),
          ),
        );
      },
    );

    // One spoken label per card ("Title, subtitle. Opens link"); a button only when it opens something.
    return b.hasLink
        ? KPressable(semanticLabel: b.semanticLabel, scale: 0.97, onTap: widget.onTap, child: ExcludeSemantics(child: visual))
        : Semantics(container: true, label: b.semanticLabel, child: ExcludeSemantics(child: visual));
  }
}

/// The photo over a soft shimmer; the brand gradient when it cannot be loaded.
class _BannerImage extends StatelessWidget {
  const _BannerImage({required this.provider, required this.onFailed});

  final ImageProvider provider;
  final VoidCallback onFailed;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Image(
      image: provider,
      fit: BoxFit.cover,
      width: double.infinity,
      height: double.infinity,
      frameBuilder: (context, child, frame, sync) {
        if (sync) return child;
        final loading = frame == null;
        return Stack(fit: StackFit.expand, children: [
          // The shimmer stops ticking once the photo is there and fades out under it.
          TickerMode(
            enabled: loading,
            child: AnimatedOpacity(
              opacity: loading ? 1 : 0,
              duration: KMotion.slow,
              curve: KMotion.emphasized,
              child: LayoutBuilder(builder: (context, c) => KSkeleton(width: c.maxWidth, height: c.maxHeight, radius: 0)),
            ),
          ),
          AnimatedOpacity(opacity: loading ? 0 : 1, duration: KMotion.slow, curve: KMotion.emphasized, child: child),
        ]);
      },
      errorBuilder: (context, error, stack) {
        WidgetsBinding.instance.addPostFrameCallback((_) => onFailed());
        return DecoratedBox(
          decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [k.brand, KraveoPalette.g600])),
        );
      },
    );
  }
}
