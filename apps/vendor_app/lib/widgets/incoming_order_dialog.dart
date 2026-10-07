import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/order_model.dart';
import '../services/failure_messages.dart';
import '../services/order_queue_controller.dart';
import 'group_note.dart';
import 'ui/ui.dart';

/// Quick reasons for rejecting an order. The English text is what the customer is shown.
class RejectReason {
  const RejectReason(this.english, this.hindi);
  final String english;
  final String hindi;

  static const List<RejectReason> quickPicks = [
    RejectReason('Item out of stock', 'सामान खत्म है'),
    RejectReason('Kitchen is too busy right now', 'अभी किचन में बहुत काम है'),
    RejectReason('Restaurant is closing', 'दुकान बंद हो रही है'),
    RejectReason('Cannot make this order', 'यह ऑर्डर नहीं बन सकता'),
  ];
}

enum _Panel { main, reject }

/// THE most important screen in the app: a full-screen takeover with a pulsing ring, the order total in
/// giant numerals, the 10-minute answer countdown, the customer's note, the items, prep-time picks and
/// two huge buttons. Everything shown comes from the server's copy of the order in [controller]; when the
/// server says the order is gone (cancelled, expired, answered on another phone) the screen says so plainly
/// and the alarm has already stopped.
class IncomingOrderDialog extends StatefulWidget {
  const IncomingOrderDialog({super.key, required this.orderId, required this.controller});

  final String orderId;
  final OrderQueueController controller;

  @override
  State<IncomingOrderDialog> createState() => _IncomingOrderDialogState();
}

class _IncomingOrderDialogState extends State<IncomingOrderDialog> with SingleTickerProviderStateMixin {
  late final AnimationController _pulseController = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400));
  final TextEditingController _otherReason = TextEditingController();
  Timer? _ticker;

  int _selectedPrepTimeMinutes = OrderQueueController.defaultPrepMinutes;
  _Panel _panel = _Panel.main;
  RejectReason? _reason;
  bool _otherSelected = false;
  OrderAction? _working;
  FailureText? _error;
  bool _closing = false;
  bool _askedAfterDeadline = false;

  /// The last copy we saw, so the "gone" screen can still name the order after the server dropped it.
  OrderModel? _lastSeen;

  OrderQueueController get _c => widget.controller;

  @override
  void initState() {
    super.initState();
    _lastSeen = _c.byId(widget.orderId);
    _c.addListener(_onControllerChanged);
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) => _onTick());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Honour the system "reduce motion" setting: hold the ring still instead of pulsing.
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) {
      _pulseController.stop();
      _pulseController.value = 0.25;
    } else if (!_pulseController.isAnimating) {
      _pulseController.repeat();
    }
  }

  @override
  void dispose() {
    _c.removeListener(_onControllerChanged);
    _ticker?.cancel();
    _pulseController.dispose();
    _otherReason.dispose();
    super.dispose();
  }

  void _onControllerChanged() {
    if (!mounted || _closing) return;
    final o = _c.byId(widget.orderId);
    if (o != null) _lastSeen = o;
    setState(() {});
  }

  void _onTick() {
    if (!mounted || _closing) return;
    // The screens behind this pop-up were torn down (session ended): never leave a dead full-screen over the login.
    if (_c.isDisposed) {
      _close();
      return;
    }
    final o = _c.byId(widget.orderId);
    if (o != null && o.isIncoming && !_askedAfterDeadline && !_c.now().isBefore(o.acceptDeadline)) {
      // Time is up: Kraveo cancels within about a minute. Ask now so the screen follows quickly.
      _askedAfterDeadline = true;
      _c.refresh();
    }
    setState(() {});
  }

  void _close({String? message}) {
    if (_closing) return;
    _closing = true;
    final messenger = ScaffoldMessenger.maybeOf(context);
    Navigator.of(context).pop();
    if (message != null) {
      messenger
        ?..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(message), duration: const Duration(seconds: 4)));
    }
  }

  Future<void> _handleAccept() async {
    if (_working != null) return;
    setState(() {
      _working = OrderAction.accept;
      _error = null;
    });
    final out = await _c.accept(widget.orderId, prepMinutes: _selectedPrepTimeMinutes);
    if (!mounted) return;
    setState(() => _working = null);
    if (out.ok) {
      _close(message: 'Order ${_lastSeen?.shortCode ?? ''} accepted  ·  ऑर्डर स्वीकार, किचन में जुड़ गया');
      return;
    }
    if (out.ignored) return;
    // If the order is gone or moved on, the "gone" panel explains it; otherwise show why and allow a retry.
    if (_c.byId(widget.orderId)?.isIncoming == true) setState(() => _error = failureText(out.failure!, serverMessage: out.message, code: out.code));
  }

  String? get _chosenReason {
    if (_otherSelected) {
      final t = _otherReason.text.trim();
      return t.length >= 3 && t.length <= 200 ? t : null;
    }
    return _reason?.english;
  }

  Future<void> _handleReject() async {
    final reason = _chosenReason;
    if (reason == null || _working != null) return;
    setState(() {
      _working = OrderAction.reject;
      _error = null;
    });
    final out = await _c.reject(widget.orderId, reason);
    if (!mounted) return;
    setState(() => _working = null);
    if (out.ok) {
      _close(message: 'Order ${_lastSeen?.shortCode ?? ''} rejected. The customer gets a refund.  ·  ऑर्डर मना किया');
      return;
    }
    if (out.ignored) return;
    if (_c.byId(widget.orderId)?.isIncoming == true) setState(() => _error = failureText(out.failure!, serverMessage: out.message, code: out.code));
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final live = _c.byId(widget.orderId);
    final order = live ?? _lastSeen;
    final gone = live == null || !live.isIncoming;

    return PopScope(
      canPop: false,
      child: Dialog.fullscreen(
        backgroundColor: k.bg,
        child: (order == null || (gone && _working == null))
            ? _GonePanel(order: live, lastSeen: _lastSeen, onOk: () => _close())
            : LayoutBuilder(builder: (context, c) {
                // On a short screen (phone held sideways) everything scrolls together so the
                // buttons can never be pushed off-screen; otherwise the buttons stay pinned.
                final compact = c.maxHeight < 540;
                if (compact) {
                  return SingleChildScrollView(
                    child: Column(children: [
                      _buildHeader(k, order),
                      Padding(padding: const EdgeInsets.fromLTRB(KSpace.gutter, 14, KSpace.gutter, 14), child: _buildBody(k, order)),
                      _buildActionPanel(k),
                    ]),
                  );
                }
                return Column(
                  children: [
                    _buildHeader(k, order),
                    Expanded(
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 14, KSpace.gutter, 14),
                        children: [_buildBody(k, order)],
                      ),
                    ),
                    _buildActionPanel(k),
                  ],
                );
              }),
      ),
    );
  }

  Widget _buildBody(KraveoTokens k, OrderModel order) {
    if (_panel == _Panel.reject) return _buildReasons(k);
    return VMaxWidth(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (order.isGrouped) ...[
          GroupNote(order: order),
          const SizedBox(height: 10),
        ],
        if (order.customerNote != null) ...[
          VNoteCallout(note: order.customerNote!, compact: true),
          const SizedBox(height: 10),
        ],
        VSectionLabel(english: 'Items', hindi: 'सामान', count: order.items.length),
        _buildItems(k, order),
      ]),
    );
  }

  // ---------------------------------------------------------------- header

  Widget _buildHeader(KraveoTokens k, OrderModel order) {
    final left = order.acceptDeadline.difference(_c.now());
    final late = left.inSeconds <= 0;
    final urgent = left.inSeconds <= 120;
    final mm = (late ? 0 : left.inMinutes).toString().padLeft(2, '0');
    final ss = (late ? 0 : left.inSeconds.remainder(60)).toString().padLeft(2, '0');
    return Semantics(
      liveRegion: true,
      label: 'New order ${order.shortCode}. You earn ${formatRupees(order.earned)}',
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 14),
        decoration: BoxDecoration(
          color: k.brand,
          borderRadius: const BorderRadius.vertical(bottom: Radius.circular(KRadius.xxl)),
        ),
        child: SafeArea(
          bottom: false,
          child: VMaxWidth(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Row(children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(color: k.onBrand.withValues(alpha: 0.16), shape: BoxShape.circle),
                  child: Icon(LucideIcons.bellRing, size: 24, color: k.onBrand),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('New order', maxLines: 1, style: KraveoType.headline.copyWith(color: k.onBrand)),
                      Text('नया ऑर्डर', maxLines: 1, style: KraveoType.titleMd.copyWith(color: k.onBrand.withValues(alpha: 0.9))),
                    ]),
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(color: k.onBrand.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(KRadius.pill)),
                  child: Text(order.shortCode, maxLines: 1, style: KraveoType.titleMd.copyWith(color: k.onBrand)),
                ),
              ]),
              SizedBox(
                height: 104,
                width: double.infinity,
                child: ClipRect(
                  child: Stack(alignment: Alignment.center, children: [
                    Positioned.fill(child: CustomPaint(painter: _RipplePainter(_pulseController, k.onBrand))),
                    AnimatedBuilder(
                      animation: _pulseController,
                      builder: (context, child) => Transform.scale(scale: 1 + 0.03 * math.sin(_pulseController.value * math.pi * 2), child: child),
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Column(mainAxisSize: MainAxisSize.min, children: [
                          Text('You earn  ·  आपकी कमाई', maxLines: 1, style: KraveoType.label.copyWith(color: k.onBrand.withValues(alpha: 0.9), fontSize: 13)),
                          Text(formatRupees(order.earned), key: const ValueKey('you-earn'), style: KraveoType.displayLg.copyWith(fontSize: 64, height: 1.05, color: k.accent)),
                        ]),
                      ),
                    ),
                  ]),
                ),
              ),
              FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  'At your prices  ·  आपके दाम पर',
                  key: const ValueKey('earn-help'),
                  maxLines: 1,
                  style: KraveoType.titleMd.copyWith(color: k.onBrand, fontSize: 15, fontWeight: FontWeight.w800),
                ),
              ),
              const SizedBox(height: 6),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                Icon(LucideIcons.mapPin, size: 18, color: k.onBrand.withValues(alpha: 0.9)),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    '${order.studentName} · ${order.studentLocation}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: KraveoType.titleMd.copyWith(color: k.onBrand.withValues(alpha: 0.95), fontSize: 15),
                  ),
                ),
              ]),
              const SizedBox(height: 10),
              // Paid + the 10-minute answer window, side by side.
              Row(children: [
                Expanded(
                  child: _HeaderChip(
                    icon: LucideIcons.badgeCheck,
                    text: 'Paid · पेमेंट हो गया',
                    bg: k.onBrand.withValues(alpha: 0.16),
                    fg: k.onBrand,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Semantics(
                    label: late ? 'Answer time is over' : 'Answer within $mm minutes $ss seconds',
                    excludeSemantics: true,
                    child: _HeaderChip(
                      key: const ValueKey('accept-countdown'),
                      icon: LucideIcons.timer,
                      text: late ? 'Time up · समय खत्म' : '$mm:$ss to answer',
                      bg: urgent ? kDangerDeep : k.accent,
                      fg: urgent ? Colors.white : k.onAccent,
                    ),
                  ),
                ),
              ]),
            ]),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- body

  Widget _buildItems(KraveoTokens k, OrderModel order) {
    return KCard(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      child: Column(children: [
        for (var i = 0; i < order.items.length; i++) ...[
          if (i > 0) Divider(height: 1, color: k.line),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(children: [
              Container(
                constraints: const BoxConstraints(minWidth: 64, minHeight: 52),
                padding: const EdgeInsets.symmetric(horizontal: 10),
                alignment: Alignment.center,
                decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.md)),
                child: Text('${order.items[i].quantity}×', style: KraveoType.headline.copyWith(fontSize: 30, color: k.brand)),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(order.items[i].name, maxLines: 3, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink, fontSize: 21, fontWeight: FontWeight.w700)),
              ),
              const SizedBox(width: 10),
              // A big line total shrinks a little instead of squeezing the dish name out of the row.
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 110),
                child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerRight, child: Text(formatRupees(order.items[i].totalPrice), maxLines: 1, style: KraveoType.titleMd.copyWith(color: k.inkMuted))),
              ),
            ]),
          ),
        ],
      ]),
    );
  }

  Widget _buildReasons(KraveoTokens k) {
    return VMaxWidth(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Why are you rejecting?', style: KraveoType.headlineSm.copyWith(color: k.ink)),
        Text('मना करने का कारण चुनें · ग्राहक को दिखेगा', style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
        const SizedBox(height: 12),
        for (final r in RejectReason.quickPicks) ...[
          _ReasonTile(
            english: r.english,
            hindi: r.hindi,
            selected: !_otherSelected && _reason == r,
            onTap: () => setState(() {
              _reason = r;
              _otherSelected = false;
            }),
          ),
          const SizedBox(height: 8),
        ],
        _ReasonTile(
          english: 'Other reason',
          hindi: 'कोई और कारण',
          selected: _otherSelected,
          onTap: () => setState(() {
            _otherSelected = true;
            _reason = null;
          }),
        ),
        if (_otherSelected) ...[
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('reject-other-field'),
            controller: _otherReason,
            maxLength: 200,
            minLines: 1,
            maxLines: 3,
            onChanged: (_) => setState(() {}),
            style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 18),
            decoration: const InputDecoration(hintText: 'Type the reason (at least 3 letters)'),
          ),
        ],
      ]),
    );
  }

  // ---------------------------------------------------------------- actions

  Widget _buildActionPanel(KraveoTokens k) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(KSpace.gutter, 10, KSpace.gutter, 12),
      decoration: BoxDecoration(
        color: k.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(KRadius.xxl)),
        boxShadow: KShadow.lift(k.shadowTint),
      ),
      child: SafeArea(
        top: false,
        child: VMaxWidth(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (_error != null) ...[
              _ErrorBanner(text: _error!),
              const SizedBox(height: 8),
            ],
            AnimatedSize(
              duration: KMotion.base,
              curve: KMotion.emphasized,
              alignment: Alignment.bottomCenter,
              child: AnimatedSwitcher(
                duration: KMotion.fast,
                child: _panel == _Panel.reject ? _buildRejectActions(k) : _buildMainActions(k),
              ),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _buildMainActions(KraveoTokens k) {
    final busy = _working != null;
    return Column(
      key: const ValueKey('main-actions'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 6),
          child: Text.rich(TextSpan(children: [
            TextSpan(text: 'Ready in', style: KraveoType.titleMd.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
            TextSpan(text: '   कितनी देर में', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
          ])),
        ),
        Row(children: [
          for (final t in const [10, 15, 20, 30]) ...[
            if (t != 10) const SizedBox(width: 8),
            Expanded(
              child: VChoiceChip(
                label: '$t',
                sublabel: 'min',
                numeral: true,
                selected: _selectedPrepTimeMinutes == t,
                semanticLabel: '$t minutes',
                onTap: () => setState(() => _selectedPrepTimeMinutes = t),
              ),
            ),
          ],
        ]),
        const SizedBox(height: 10),
        LayoutBuilder(builder: (context, c) {
          final wide = c.maxWidth >= 480;
          return Row(children: [
            Expanded(
              flex: wide ? 2 : 1,
              child: KButton(
                label: 'Decline',
                sublabel: 'मना करें',
                kind: KButtonKind.ghost,
                large: true,
                onPressed: busy
                    ? null
                    : () => setState(() {
                          _panel = _Panel.reject;
                          _error = null;
                        }),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: wide ? 3 : 1,
              child: KButton(
                label: 'Accept',
                sublabel: 'स्वीकार करें',
                large: true,
                loading: _working == OrderAction.accept,
                onPressed: busy ? null : _handleAccept,
              ),
            ),
          ]);
        }),
      ],
    );
  }

  Widget _buildRejectActions(KraveoTokens k) {
    final busy = _working != null;
    return Column(
      key: const ValueKey('decline-confirm'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Decline this order?', textAlign: TextAlign.center, style: KraveoType.headlineSm.copyWith(color: k.ink)),
        Text('क्या यह ऑर्डर मना करना है?', textAlign: TextAlign.center, style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: KButton(
              label: 'Go back',
              sublabel: 'वापस जाएं',
              large: true,
              onPressed: busy
                  ? null
                  : () => setState(() {
                        _panel = _Panel.main;
                        _error = null;
                      }),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: KButton(
              label: 'Yes, decline',
              sublabel: 'हाँ, मना करें',
              kind: KButtonKind.danger,
              large: true,
              loading: _working == OrderAction.reject,
              onPressed: (busy || _chosenReason == null) ? null : _handleReject,
            ),
          ),
        ]),
      ],
    );
  }
}

class _HeaderChip extends StatelessWidget {
  const _HeaderChip({super.key, required this.icon, required this.text, required this.bg, required this.fg});
  final IconData icon;
  final String text;
  final Color bg;
  final Color fg;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minHeight: 40),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(KRadius.pill)),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        Icon(icon, size: 18, color: fg),
        const SizedBox(width: 6),
        Flexible(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(text, maxLines: 1, style: KraveoType.titleMd.copyWith(color: fg, fontWeight: FontWeight.w800, fontSize: 16)),
          ),
        ),
      ]),
    );
  }
}

class _ReasonTile extends StatelessWidget {
  const _ReasonTile({required this.english, required this.hindi, required this.selected, required this.onTap});
  final String english;
  final String hindi;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      button: true,
      selected: selected,
      inMutuallyExclusiveGroup: true,
      label: '$english, $hindi',
      excludeSemantics: true,
      onTap: onTap,
      child: KPressable(
        onTap: onTap,
        scale: 0.985,
        child: AnimatedContainer(
          duration: KMotion.base,
          constraints: const BoxConstraints(minHeight: 64),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: selected ? Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.10), k.surface) : k.surface,
            borderRadius: BorderRadius.circular(KRadius.lg),
            border: Border.all(color: selected ? KraveoPalette.danger : k.line, width: selected ? 2 : 1.5),
          ),
          child: Row(children: [
            Icon(selected ? LucideIcons.circleCheck : LucideIcons.circle, size: 26, color: selected ? kDangerDeep : k.inkFaint),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(english, style: KraveoType.titleMd.copyWith(color: k.ink, fontWeight: FontWeight.w800, fontSize: 17)),
                Text(hindi, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.text});
  final FailureText text;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.10), k.surface),
          borderRadius: BorderRadius.circular(KRadius.md),
          border: Border.all(color: KraveoPalette.danger, width: 1.5),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(LucideIcons.triangleAlert, size: 22, color: kDangerDeep),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(text.english, style: KraveoType.titleMd.copyWith(color: k.ink, fontWeight: FontWeight.w700, fontSize: 15)),
              Text('${text.hindi}. Tap again to retry.', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// Shown when the order stopped waiting for us while the takeover was open.
class _GonePanel extends StatelessWidget {
  const _GonePanel({required this.order, required this.lastSeen, required this.onOk});
  final OrderModel? order;
  final OrderModel? lastSeen;
  final VoidCallback onOk;

  (String, String, String?) _text() {
    final o = order;
    if (o == null) return ('This order is no longer available.', 'यह ऑर्डर अब उपलब्ध नहीं है।', null);
    if (o.status == OrderStatus.cancelled) {
      switch (o.cancelledBy) {
        case CancelledBy.system:
          return ('Cancelled: not accepted within 10 minutes.', '10 मिनट में जवाब नहीं मिला, ऑर्डर रद्द हो गया।', 'The customer gets a full refund.');
        case CancelledBy.customer:
          return ('The customer cancelled this order.', 'ग्राहक ने ऑर्डर रद्द कर दिया।', o.cancelReason);
        case CancelledBy.vendor:
          return ('This order was declined.', 'यह ऑर्डर मना कर दिया गया।', o.cancelReason);
        case CancelledBy.admin:
          return ('Kraveo cancelled this order.', 'Kraveo ने ऑर्डर रद्द कर दिया।', o.cancelReason);
        default:
          return ('This order was cancelled.', 'यह ऑर्डर रद्द हो गया।', o.cancelReason);
      }
    }
    if (o.status.rank >= OrderStatus.accepted.rank) {
      return ('Already accepted (maybe on another phone).', 'यह ऑर्डर पहले ही स्वीकार हो चुका है।', 'It is in your Orders list.');
    }
    return ('This order changed.', 'यह ऑर्डर बदल गया।', 'Check the Orders list.');
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final (en, hi, extra) = _text();
    final code = (order ?? lastSeen)?.shortCode;
    return SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(KSpace.gutter),
          child: VMaxWidth(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Center(
                child: Container(
                  width: 84,
                  height: 84,
                  decoration: BoxDecoration(color: KraveoPalette.danger.withValues(alpha: 0.12), shape: BoxShape.circle),
                  child: Icon(LucideIcons.circleX, size: 40, color: kDangerDeep),
                ),
              ),
              const SizedBox(height: 16),
              if (code != null) Text('Order $code', textAlign: TextAlign.center, style: KraveoType.titleLg.copyWith(color: k.inkMuted)),
              Text(en, key: const ValueKey('gone-title'), textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
              const SizedBox(height: 4),
              Text(hi, textAlign: TextAlign.center, style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
              if (extra != null && extra.trim().isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(extra, textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.ink, fontSize: 17)),
              ],
              const SizedBox(height: 24),
              KButton(label: 'OK', sublabel: 'ठीक है', large: true, onPressed: onOk),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Three sonar rings that expand and fade behind the order total.
class _RipplePainter extends CustomPainter {
  _RipplePainter(this.animation, this.color) : super(repaint: animation);
  final Animation<double> animation;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final minR = size.height * 0.30;
    final maxR = math.max(size.width, size.height) * 0.55;
    for (var i = 0; i < 3; i++) {
      final t = (animation.value + i / 3) % 1.0;
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3
        ..color = color.withValues(alpha: (1 - t) * 0.30);
      canvas.drawCircle(center, minR + (maxR - minR) * Curves.easeOut.transform(t), paint);
    }
  }

  @override
  bool shouldRepaint(_RipplePainter old) => old.color != color || old.animation != animation;
}
