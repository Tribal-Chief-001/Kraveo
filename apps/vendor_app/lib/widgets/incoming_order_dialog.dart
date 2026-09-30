import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/order_model.dart';
import '../services/audio_alert_service.dart';
import 'ui/ui.dart';

/// THE most important screen in the app: a full-screen takeover with a pulsing ring, the
/// order total in giant numerals, the customer's note, the items, prep-time picks and
/// two huge buttons. Alarm/audio and the accept/decline callbacks are unchanged.
class IncomingOrderDialog extends StatefulWidget {
  final OrderModel? order;
  final Function(OrderModel acceptedOrder) onAccept;
  final VoidCallback onDecline;

  const IncomingOrderDialog({
    super.key,
    this.order,
    required this.onAccept,
    required this.onDecline,
  });

  @override
  State<IncomingOrderDialog> createState() => _IncomingOrderDialogState();
}

class _IncomingOrderDialogState extends State<IncomingOrderDialog> with SingleTickerProviderStateMixin {
  late AnimationController _pulseController;

  int _selectedPrepTimeMinutes = 15;
  bool _confirmingDecline = false;
  late OrderModel _order;

  @override
  void initState() {
    super.initState();

    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 2400),
    );

    // Initialize order data or use mock fallback with unique timestamp ID
    _order = widget.order ?? OrderModel(
      id: '#ord-${(DateTime.now().millisecondsSinceEpoch % 10000).toString().padLeft(4, '0')}',
      studentName: 'Aarav Sharma',
      studentLocation: 'Hostel Block A, R-304',
      items: [
        OrderItem(name: 'Special Shahi Paneer Thali', quantity: 2, unitPrice: 180),
        OrderItem(name: 'Kulhad Sweet Lassi', quantity: 2, unitPrice: 50),
      ],
      totalAmount: 460,
      prepTimeMinutes: 15,
      createdAt: DateTime.now(),
      customerNote: 'Make it extra spicy with extra curd please!',
      status: OrderStatus.placed,
    );
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
    _pulseController.dispose();
    super.dispose();
  }

  void _handleAccept() {
    AudioAlertService.stopAlarm();
    _order.prepTimeMinutes = _selectedPrepTimeMinutes;
    _order.status = OrderStatus.preparing;
    widget.onAccept(_order);
    Navigator.of(context).pop();
  }

  void _handleDecline() {
    AudioAlertService.stopAlarm();
    widget.onDecline();
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return PopScope(
      canPop: false,
      child: Dialog.fullscreen(
        backgroundColor: k.bg,
        child: LayoutBuilder(builder: (context, c) {
          // On a short screen (phone held sideways) everything scrolls together so the
          // buttons can never be pushed off-screen; otherwise the buttons stay pinned.
          final compact = c.maxHeight < 540;
          if (compact) {
            return SingleChildScrollView(
              child: Column(children: [
                _buildHeader(k),
                Padding(padding: const EdgeInsets.fromLTRB(KSpace.gutter, 14, KSpace.gutter, 14), child: _buildBody(k)),
                _buildActionPanel(k),
              ]),
            );
          }
          return Column(
            children: [
              _buildHeader(k),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(KSpace.gutter, 14, KSpace.gutter, 14),
                  children: [_buildBody(k)],
                ),
              ),
              _buildActionPanel(k),
            ],
          );
        }),
      ),
    );
  }

  Widget _buildBody(KraveoTokens k) {
    return VMaxWidth(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (_order.customerNote != null && _order.customerNote!.isNotEmpty) ...[
          VNoteCallout(note: _order.customerNote!, compact: true),
          const SizedBox(height: 10),
        ],
        VSectionLabel(english: 'Items', hindi: 'सामान', count: _order.items.length),
        _buildItems(k),
      ]),
    );
  }

  // ---------------------------------------------------------------- header

  Widget _buildHeader(KraveoTokens k) {
    return Semantics(
      liveRegion: true,
      label: 'New order ${_order.id}, total ${formatRupees(_order.totalAmount)}',
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 14),
        decoration: BoxDecoration(
          color: k.brand,
          borderRadius: const BorderRadius.vertical(bottom: Radius.circular(KRadius.xxl)),
        ),
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
                child: Text(_order.id, maxLines: 1, style: KraveoType.titleMd.copyWith(color: k.onBrand)),
              ),
            ]),
            SizedBox(
              height: 112,
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
                        Text('Order total  ·  कुल राशि', maxLines: 1, style: KraveoType.label.copyWith(color: k.onBrand.withValues(alpha: 0.9), fontSize: 13)),
                        Text(formatRupees(_order.totalAmount), style: KraveoType.displayLg.copyWith(fontSize: 68, height: 1.05, color: k.accent)),
                      ]),
                    ),
                  ),
                ]),
              ),
            ),
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              Icon(LucideIcons.mapPin, size: 18, color: k.onBrand.withValues(alpha: 0.9)),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  '${_order.studentName} · ${_order.studentLocation}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: KraveoType.titleMd.copyWith(color: k.onBrand.withValues(alpha: 0.95), fontSize: 15),
                ),
              ),
            ]),
          ]),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- body

  Widget _buildItems(KraveoTokens k) {
    return KCard(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      child: Column(children: [
        for (var i = 0; i < _order.items.length; i++) ...[
          if (i > 0) Divider(height: 1, color: k.line),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(children: [
              Container(
                constraints: const BoxConstraints(minWidth: 64, minHeight: 52),
                padding: const EdgeInsets.symmetric(horizontal: 10),
                alignment: Alignment.center,
                decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.md)),
                child: Text('${_order.items[i].quantity}×', style: KraveoType.headline.copyWith(fontSize: 30, color: k.brand)),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(_order.items[i].name, maxLines: 3, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink, fontSize: 21, fontWeight: FontWeight.w700)),
              ),
              const SizedBox(width: 10),
              Text(formatRupees(_order.items[i].totalPrice), style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
            ]),
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
      child: VMaxWidth(
        child: AnimatedSize(
          duration: KMotion.base,
          curve: KMotion.emphasized,
          alignment: Alignment.bottomCenter,
          child: AnimatedSwitcher(
            duration: KMotion.fast,
            child: _confirmingDecline ? _buildDeclineConfirm(k) : _buildMainActions(k),
          ),
        ),
      ),
    );
  }

  Widget _buildMainActions(KraveoTokens k) {
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
                onPressed: () => setState(() => _confirmingDecline = true),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: wide ? 3 : 1,
              child: KButton(
                label: 'Accept',
                sublabel: 'स्वीकार करें',
                large: true,
                onPressed: _handleAccept,
              ),
            ),
          ]);
        }),
      ],
    );
  }

  Widget _buildDeclineConfirm(KraveoTokens k) {
    return Column(
      key: const ValueKey('decline-confirm'),
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('Decline this order?', textAlign: TextAlign.center, style: KraveoType.headlineSm.copyWith(color: k.ink)),
        Text('क्या यह ऑर्डर मना करना है?', textAlign: TextAlign.center, style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
        const SizedBox(height: 14),
        KButton(label: 'Go back', sublabel: 'वापस जाएं', large: true, onPressed: () => setState(() => _confirmingDecline = false)),
        const SizedBox(height: 10),
        KButton(label: 'Yes, decline', sublabel: 'हाँ, मना करें', kind: KButtonKind.danger, large: true, onPressed: _handleDecline),
      ],
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
