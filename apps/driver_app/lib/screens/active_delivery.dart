import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/geo.dart';
import '../models/order_view.dart';
import '../services/navigation.dart';
import '../state/rider_controller.dart';
import '../widgets/gate_otp_dialog.dart';
import '../widgets/map/delivery_map_card.dart';
import '../widgets/map/map_view.dart';
import '../widgets/pipeline_stepper.dart';
import '../widgets/support_sheet.dart';
import '../widgets/swipe_accept_card.dart' show OfferCard;
import '../widgets/ui/screen_header.dart';

/// The delivery the rider is carrying, driven only by the order's real status on the server:
/// go to restaurant -> wait for READY_FOR_PICKUP -> Picked up -> ride to the drop point ->
/// Arrived -> enter the customer's code -> delivered. Also shows how a delivery ended
/// (delivered / cancelled / moved by Kraveo) until the rider acknowledges it.
class ActiveDeliveryScreen extends StatelessWidget {
  const ActiveDeliveryScreen({super.key, required this.controller, required this.onGoHome, this.mapFactory, this.navigationLauncher});

  final RiderController controller;
  final VoidCallback onGoHome;

  /// Test seams. Production: the real Google map and the real "open Google Maps" launcher.
  final MapViewFactory? mapFactory;
  final NavigationLauncher? navigationLauncher;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final notice = controller.notice;
        final order = controller.active;
        final Widget body;
        if (notice != null) {
          body = _NoticeView(
            notice: notice,
            onDone: () {
              controller.dismissNotice();
              if (controller.active == null) onGoHome();
            },
          );
        } else if (order != null) {
          body = _DeliveryView(controller: controller, order: order, mapFactory: mapFactory, navigationLauncher: navigationLauncher);
        } else if (!controller.activeChecked) {
          body = const Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3)),
              SizedBox(height: 16),
              Text('Checking for a delivery in progress…'),
            ]),
          );
        } else {
          body = KEmptyState(
            icon: LucideIcons.bike,
            title: 'No active delivery',
            message: 'Accept an order from Home to start step-by-step guidance.',
            action: KButton(label: 'Go to home', icon: LucideIcons.house, large: true, expand: false, onPressed: onGoHome),
          );
        }
        return Scaffold(body: SafeArea(bottom: false, child: body));
      },
    );
  }
}

class _DeliveryView extends StatefulWidget {
  const _DeliveryView({required this.controller, required this.order, this.mapFactory, this.navigationLauncher});
  final RiderController controller;
  final OrderView order;
  final MapViewFactory? mapFactory;
  final NavigationLauncher? navigationLauncher;

  @override
  State<_DeliveryView> createState() => _DeliveryViewState();
}

class _DeliveryViewState extends State<_DeliveryView> {
  bool _detailsOpen = false;

  RiderController get c => widget.controller;
  OrderView get o => widget.order;

  Future<void> _openCodeEntry({bool retry = false}) async {
    final orderId = o.id;
    final ref = o.shortRef;
    final customer = o.customer?.name ?? 'the customer';
    final gate = o.dropLabel;
    final locked = c.activeLocked && !retry;
    BuildContext? dialogContext;

    // The keypad must not stay on top of an order that was cancelled or moved away: close it as soon as
    // the delivery on screen is no longer this one at the drop point. (A delivered order closes it itself.)
    void closeIfGone() {
      final ctx = dialogContext;
      if (ctx == null || !ctx.mounted) return;
      final cur = c.active;
      final gone = cur == null || cur.id != orderId || cur.status != OrderStatus.arrivedAtGate;
      final delivered = c.notice?.kind == NoticeKind.delivered && c.notice?.order.id == orderId;
      if (gone && !delivered) {
        dialogContext = null;
        Navigator.of(ctx).pop(false);
      }
    }

    c.addListener(closeIfGone);
    try {
      await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) {
          dialogContext = ctx;
          return GateOtpDialog(
            orderRef: ref,
            customerName: customer,
            gateName: gate,
            initiallyLocked: locked,
            onSubmit: c.verifyOtp,
          );
        },
      );
    } finally {
      dialogContext = null;
      c.removeListener(closeIfGone);
    }
  }

  /// Opens Google Maps navigation to [point]; says so when no maps app or browser can.
  Future<void> _navigate(GeoPoint point, String label) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final opened = await openNavigation(point, label: label, launcher: widget.navigationLauncher ?? const UrlNavigationLauncher());
    if (!opened && mounted) {
      messenger
        ?..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Could not open Google Maps. Install it, or follow the address on this screen.')));
    }
  }

  /// The Navigate button for the leg the rider is on: to the restaurant before pickup (disabled
  /// with the reason when the restaurant has no real pin), to the drop point afterwards (hidden
  /// when the drop point is not a known campus point: the name stays on screen as text).
  Widget? _navigateButton(BuildContext context) {
    final k = context.k;
    if (o.status.isBeforePickup) {
      final pin = o.vendor?.point;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        KButton(
          key: const ValueKey('navigate-restaurant'),
          label: 'Navigate to restaurant',
          icon: LucideIcons.navigation,
          kind: KButtonKind.tonal,
          onPressed: pin == null ? null : () => _navigate(pin, o.restaurantName),
        ),
        if (pin == null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text('Restaurant location not set - call the restaurant', key: const ValueKey('restaurant-location-missing'), style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          ),
      ]);
    }
    final drop = o.dropPlace;
    if (drop == null) return null;
    return KButton(
      key: const ValueKey('navigate-drop'),
      label: 'Navigate to ${drop.name}',
      icon: LucideIcons.navigation,
      kind: KButtonKind.tonal,
      onPressed: () => _navigate(drop.point, drop.name),
    );
  }

  Future<void> _confirmRelease() async {
    final yes = await showKSheet<bool>(
      context,
      builder: (ctx) {
        final k = ctx.k;
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text('Release this job?', textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
            const SizedBox(height: 8),
            Text('Order ${o.shortRef} goes back to other riders. Only do this if you cannot pick it up.',
                textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
            const SizedBox(height: 24),
            KButton(label: 'Keep the job', large: true, onPressed: () => Navigator.of(ctx).pop(false)),
            const SizedBox(height: 12),
            KButton(
              key: const ValueKey('confirm-release-button'),
              label: 'Yes, release it',
              kind: KButtonKind.danger,
              large: true,
              onPressed: () => Navigator.of(ctx).pop(true),
            ),
          ]),
        );
      },
    );
    if (yes == true) await c.release();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final status = o.status;
    final step = PipelineStepper.stepFor(status);
    final locked = c.activeLocked;
    final bottomInset = MediaQuery.paddingOf(context).bottom;
    final phone = o.customer?.phone;

    final (String headline, String where, IconData whereIcon) = switch (status) {
      OrderStatus.pickedUp => ('Ride to the drop point', o.dropLabel, LucideIcons.mapPin),
      OrderStatus.arrivedAtGate => ('Hand over the order', o.dropLabel, LucideIcons.mapPin),
      _ => ('Go to the restaurant', o.restaurantName, LucideIcons.store),
    };

    final Widget? banner = switch (status) {
      _ when locked => const _Banner(
          icon: LucideIcons.lock,
          color: KraveoPalette.danger,
          title: RiderController.supportMessage,
          message: 'Too many wrong codes. Do not hand over the food until Kraveo support unlocks it.',
        ),
      OrderStatus.accepted || OrderStatus.preparing => _Banner(
          icon: LucideIcons.chefHat,
          color: KStatus.preparing.color,
          title: 'Restaurant is still preparing',
          message: 'You can mark it picked up once the restaurant marks it ready.',
        ),
      OrderStatus.readyForPickup => _Banner(
          icon: LucideIcons.packageCheck,
          color: KStatus.ready.color,
          title: 'Food is ready',
          message: 'Collect it from the counter and check the items.',
        ),
      OrderStatus.pickedUp => _Banner(
          icon: LucideIcons.wallet,
          color: KStatus.pickedUp.color,
          title: 'Prepaid order',
          message: 'The customer already paid online. Do not collect cash.',
        ),
      OrderStatus.arrivedAtGate => _Banner(
          icon: LucideIcons.hash,
          color: KStatus.atGate.color,
          title: 'Ask the customer for their 4-digit code',
          message: 'Only the customer has it. Type it in to finish the delivery.',
        ),
      _ => null,
    };

    final Widget action;
    if (c.actionBusy) {
      action = const KButton(label: 'Saving…', large: true, loading: true);
    } else if (locked) {
      action = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        KButton(
          key: const ValueKey('locked-support-button'),
          label: 'Email Kraveo support',
          icon: LucideIcons.mail,
          kind: KButtonKind.danger,
          large: true,
          onPressed: () => showSupportSheet(context,
              note: 'Delivery ${o.shortRef} is locked after too many wrong codes.', subject: 'Locked delivery ${o.shortRef}'),
        ),
        const SizedBox(height: 10),
        // A wrong guess here costs nothing: Kraveo answers a locked order without counting an attempt,
        // and after support unlocks it the same button finishes the delivery.
        KButton(
          key: const ValueKey('retry-code-button'),
          label: 'Try the code again',
          icon: LucideIcons.hash,
          kind: KButtonKind.ghost,
          large: true,
          onPressed: () => _openCodeEntry(retry: true),
        ),
      ]);
    } else {
      action = switch (status) {
        OrderStatus.readyForPickup => Semantics(
            label: 'Slide to confirm picked up',
            button: true,
            excludeSemantics: true,
            onTap: () => c.advance(OrderStatus.pickedUp),
            child: KSlideToConfirm(key: const ValueKey('slide-picked-up'), label: 'Slide · picked up', icon: LucideIcons.package, onConfirmed: () => c.advance(OrderStatus.pickedUp)),
          ),
        OrderStatus.pickedUp => Semantics(
            label: 'Slide to confirm arrived at the drop point',
            button: true,
            excludeSemantics: true,
            onTap: () => c.advance(OrderStatus.arrivedAtGate),
            child: KSlideToConfirm(key: const ValueKey('slide-arrived'), label: 'Slide · arrived', icon: LucideIcons.mapPin, onConfirmed: () => c.advance(OrderStatus.arrivedAtGate)),
          ),
        OrderStatus.arrivedAtGate => KButton(
            key: const ValueKey('enter-code-button'),
            label: 'Enter customer\'s code',
            icon: LucideIcons.hash,
            kind: KButtonKind.accent,
            large: true,
            onPressed: _openCodeEntry,
          ),
        _ => const KButton(key: ValueKey('picked-up-disabled'), label: 'Picked up', icon: LucideIcons.package, large: true, onPressed: null),
      };
    }

    final navigateButton = _navigateButton(context);
    final showMap = o.vendor?.point != null || o.dropPlace != null;

    return RefreshIndicator(
      onRefresh: c.pollNow,
      child: ListView(
        padding: EdgeInsets.only(bottom: bottomInset + 24),
        children: [
          ScreenHeader(
            title: 'Delivery',
            subtitle: 'Order ${o.shortRef}',
            trailing: Semantics(
              label: 'Delivery fee ${OfferCard.rupees(o.deliveryFee)}',
              excludeSemantics: true,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.pill), border: Border.all(color: k.brand.withValues(alpha: 0.5))),
                child: Text(OfferCard.rupees(o.deliveryFee), style: KraveoType.headlineSm.copyWith(color: k.brand)),
              ),
            ),
          ),
          if (c.activeStale)
            const _Inline(icon: LucideIcons.wifiOff, text: 'Can\'t reach Kraveo – showing the last known status. Retrying…'),
          if (c.otherActiveCount > 0)
            _Inline(icon: LucideIcons.info, text: 'Kraveo gave you ${c.otherActiveCount} more order(s). They appear after this one.'),
          Padding(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 0),
            child: PipelineStepper(currentStep: step),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 24, KSpace.gutter, 0),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('STEP ${step + 1} OF 4', style: KraveoType.label.copyWith(color: k.brand, letterSpacing: 1.2)),
              const SizedBox(height: 4),
              Text(headline, style: KraveoType.displayMd.copyWith(color: k.ink)),
              const SizedBox(height: 4),
              Row(children: [
                Icon(whereIcon, size: 18, color: k.inkMuted),
                const SizedBox(width: 8),
                Expanded(child: Text(where, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.inkMuted))),
              ]),
              if (status.isBeforePickup && (o.vendor?.address ?? '').isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(left: 26, top: 2),
                  child: Text(o.vendor!.address!, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkFaint)),
                ),
              if (!status.isBeforePickup && (o.dropoffNotes ?? '').isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(left: 26, top: 2),
                  child: Text(o.dropoffNotes!, maxLines: 3, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkFaint)),
                ),
            ]),
          ),
          if (banner != null) Padding(padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0), child: banner),
          Padding(padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0), child: action),
          if (c.actionError != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 10, KSpace.gutter, 0),
              child: Text(c.actionError!, key: const ValueKey('action-error'), style: KraveoType.titleMd.copyWith(color: KraveoPalette.danger)),
            ),
          if (navigateButton != null) Padding(padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0), child: navigateButton),
          if (showMap)
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0),
              child: DeliveryMapCard(key: const ValueKey('delivery-map-card'), order: o, rider: c.myPosition, factory: widget.mapFactory),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0),
            child: phone != null
                ? KCard(
                    padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                    child: Row(children: [
                      Icon(LucideIcons.user, size: 22, color: k.inkMuted),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(o.customer?.name ?? 'Customer', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.ink)),
                          Text(phone, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                        ]),
                      ),
                      const SizedBox(width: 8),
                      KButton(
                        key: const ValueKey('call-customer-button'),
                        label: 'Call',
                        icon: LucideIcons.phone,
                        kind: KButtonKind.tonal,
                        expand: false,
                        onPressed: () => callNumber(context, number: phone),
                      ),
                    ]),
                  )
                : Text('The customer\'s number appears here when Kraveo shares it (at the drop point at the latest).',
                    style: KraveoType.bodySm.copyWith(color: k.inkFaint)),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0),
            child: _OrderDetails(open: _detailsOpen, onToggle: () => setState(() => _detailsOpen = !_detailsOpen), order: o),
          ),
          if (status.isBeforePickup && !c.actionBusy)
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0),
              child: KButton(
                key: const ValueKey('release-button'),
                label: 'Release this job',
                icon: LucideIcons.undo2,
                kind: KButtonKind.ghost,
                large: true,
                onPressed: _confirmRelease,
              ),
            ),
          if (c.lastSync != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 14, KSpace.gutter, 0),
              child: Text('Status from Kraveo · updated ${OfferCard.ago(c.lastSync, c.services.now())}',
                  style: KraveoType.caption.copyWith(color: k.inkFaint)),
            ),
        ],
      ),
    );
  }
}

class _NoticeView extends StatelessWidget {
  const _NoticeView({required this.notice, required this.onDone});
  final DeliveryNotice notice;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final o = notice.order;
    final (IconData icon, Color color, String title, String message, String button) = switch (notice.kind) {
      NoticeKind.delivered => (
          LucideIcons.check,
          k.brand,
          'Delivered',
          'Order ${o.shortRef} is complete. Delivery fee ${OfferCard.rupees(o.deliveryFee)}.',
          'Back to home',
        ),
      NoticeKind.cancelled => (
          LucideIcons.octagonX,
          KraveoPalette.danger,
          'Stop – this order was cancelled',
          [
            'Order ${o.shortRef} was cancelled${_by(o.cancelledBy)}.',
            if (o.cancelReason != null) 'Reason: ${o.cancelReason}.',
            if (o.isRefunded) 'The customer has been refunded.',
            o.pickedUpAt != null
                ? 'Do not hand over the food. Email Kraveo support to ask what to do with it.'
                : 'Do not go to the restaurant for this order.',
          ].join(' '),
          'OK, got it',
        ),
      NoticeKind.reassigned => (
          LucideIcons.arrowLeftRight,
          KStatus.placed.color,
          'This delivery was moved',
          'Kraveo moved order ${o.shortRef} away from you (another rider or support has it now). You do not need to do anything more for it.',
          'OK, got it',
        ),
    };
    return ListView(
      padding: const EdgeInsets.fromLTRB(KSpace.gutter, 32, KSpace.gutter, 32),
      children: [
        Center(
          child: Container(
            width: 88,
            height: 88,
            decoration: BoxDecoration(color: color.withValues(alpha: 0.16), shape: BoxShape.circle),
            child: Icon(icon, color: color, size: 46),
          ),
        ),
        const SizedBox(height: 18),
        Text(title, textAlign: TextAlign.center, style: KraveoType.displayMd.copyWith(color: k.ink)),
        const SizedBox(height: 10),
        Text(message, textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
        const SizedBox(height: 24),
        KButton(key: const ValueKey('notice-done'), label: button, large: true, onPressed: onDone),
        if (notice.kind == NoticeKind.cancelled) ...[
          const SizedBox(height: 12),
          KButton(
            key: const ValueKey('notice-support-button'),
            label: 'Email Kraveo support',
            icon: LucideIcons.mail,
            kind: KButtonKind.ghost,
            large: true,
            onPressed: () => showSupportSheet(context, subject: 'Cancelled delivery ${o.shortRef}'),
          ),
        ],
      ],
    );
  }

  static String _by(String? who) => switch (who) {
        'CUSTOMER' => ' by the customer',
        'VENDOR' => ' by the restaurant',
        'ADMIN' => ' by Kraveo',
        'SYSTEM' => ' automatically',
        _ => '',
      };
}

class _Banner extends StatelessWidget {
  const _Banner({required this.icon, required this.color, required this.title, required this.message});
  final IconData icon;
  final Color color;
  final String title, message;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(KRadius.lg),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, color: color, size: 24),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: KraveoType.titleMd.copyWith(color: k.ink)),
            const SizedBox(height: 2),
            Text(message, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          ]),
        ),
      ]),
    );
  }
}

class _Inline extends StatelessWidget {
  const _Inline({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, 4),
      child: Row(children: [
        Icon(icon, size: 18, color: k.inkMuted),
        const SizedBox(width: 8),
        Expanded(child: Text(text, style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
      ]),
    );
  }
}

class _OrderDetails extends StatelessWidget {
  const _OrderDetails({required this.open, required this.onToggle, required this.order});

  final bool open;
  final VoidCallback onToggle;
  final OrderView order;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final o = order;
    return KCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          KPressable(
            semanticLabel: open ? 'Hide order details' : 'Show order details',
            onTap: onToggle,
            scale: 0.99,
            child: Container(
              constraints: const BoxConstraints(minHeight: 64),
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
              color: Colors.transparent,
              child: ExcludeSemantics(
                child: Row(children: [
                  Icon(LucideIcons.receipt, size: 22, color: k.inkMuted),
                  const SizedBox(width: 12),
                  Expanded(child: Text('Order details', style: KraveoType.titleLg.copyWith(color: k.ink))),
                  Text('${o.itemCount} items', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                  const SizedBox(width: 8),
                  Icon(open ? LucideIcons.chevronUp : LucideIcons.chevronDown, size: 22, color: k.inkFaint),
                ]),
              ),
            ),
          ),
          AnimatedSize(
            duration: KMotion.base,
            curve: KMotion.emphasized,
            alignment: Alignment.topCenter,
            child: open
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(18, 0, 18, 18),
                    child: Column(children: [
                      Divider(color: k.line, height: 1),
                      const SizedBox(height: 12),
                      _Line(icon: LucideIcons.store, label: 'Restaurant', value: o.restaurantName),
                      if (o.customer?.name != null) _Line(icon: LucideIcons.user, label: 'Customer', value: o.customer!.name!),
                      _Line(icon: LucideIcons.mapPin, label: 'Drop', value: o.dropLabel),
                      for (final item in o.items) _Line(icon: LucideIcons.package, label: '${item.quantity} ×', value: item.name),
                      _Line(icon: LucideIcons.wallet, label: 'Delivery fee', value: OfferCard.rupees(o.deliveryFee)),
                      _Line(icon: LucideIcons.receipt, label: 'Order total', value: '${OfferCard.rupees(o.totalAmount)} (prepaid)'),
                    ]),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.icon, required this.label, required this.value});
  final IconData icon;
  final String label, value;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 18, color: k.inkFaint),
        const SizedBox(width: 10),
        Text(label, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
        const SizedBox(width: 12),
        Expanded(child: Text(value, textAlign: TextAlign.right, style: KraveoType.titleMd.copyWith(color: k.ink))),
      ]),
    );
  }
}
