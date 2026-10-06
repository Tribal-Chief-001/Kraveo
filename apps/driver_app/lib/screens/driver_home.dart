import 'dart:async';
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/order_view.dart';
import '../state/rider_controller.dart';
import '../widgets/duty_toggle.dart';
import '../widgets/earnings_card.dart';
import '../widgets/support_sheet.dart';
import '../widgets/swipe_accept_card.dart';
import '../widgets/pipeline_stepper.dart';
import '../widgets/ui/icon_action.dart';
import '../widgets/ui/radar_pulse.dart';
import '../widgets/ui/screen_header.dart';
import '../services/driver_api_service.dart';
import '../services/push/push_controller.dart';
import '../services/push/push_payload.dart';
import '../widgets/notifications_banner.dart';
import '../session/session_controller.dart';
import '../widgets/account_sheet.dart';
import '../models/partner_session.dart';
import 'active_delivery.dart';
import 'earnings_history.dart';
import 'trip_logs.dart';
import 'runner_id_card_screen.dart';

/// The rider's home: duty switch, GPS state, real offers from the pool, the delivery in progress,
/// and today's delivery fees. All order data comes from [RiderController] (server truth).
class DriverHomeScreen extends StatefulWidget {
  /// Network, socket and GPS. Null means the real ones; tests pass fakes.
  const DriverHomeScreen({super.key, this.services});

  final RiderServices? services;

  @override
  State<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends State<DriverHomeScreen> with WidgetsBindingObserver implements PushUiHandler {
  late final RiderController _rider;
  PushController? _push;
  bool _explaining = false;
  StreamSubscription<String>? _messages;
  SessionController? _sessionCtl;
  DutyReading? _lastDutyReading;
  int selectedTab = 0;

  @override
  void initState() {
    super.initState();
    final partner = context.getInheritedWidgetOfExactType<SessionScope>()?.notifier?.session;
    _rider = RiderController(
      widget.services ?? RiderServices.real(),
      myIds: {if (partner != null) partner.userId, if (partner?.driverId != null) partner!.driverId!},
    );
    _messages = _rider.messages.listen(_showMessage);
    WidgetsBinding.instance.addObserver(this);
    // Kraveo's own idea of this rider's duty (second phone, logout elsewhere, a restore that failed on a weak
    // network) is mirrored once the controller has started and whenever a fresh profile answer arrives.
    _sessionCtl = context.getInheritedWidgetOfExactType<SessionScope>()?.notifier;
    _sessionCtl?.dutyReading.addListener(_syncDutyFromSession);
    unawaited(_rider.start().then((_) => _syncDutyFromSession()));
    // Push is optional: null when the app runs without it (tests, or Firebase unavailable).
    _push = context.getInheritedWidgetOfExactType<PushScope>()?.notifier;
    _push?.addListener(_maybeExplainNotifications);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _push?.attachUi(this);
      _maybeExplainNotifications();
    });
  }

  void _syncDutyFromSession() {
    final reading = _sessionCtl?.dutyReading.value;
    if (!mounted || reading == null || identical(reading, _lastDutyReading)) return;
    _lastDutyReading = reading;
    unawaited(_rider.reconcileDuty(reading.status, asOf: reading.asOf));
  }

  /// The duty switch. Going off duty with a delivery in hand asks first.
  Future<void> _onDutyChanged(bool on) async {
    if (!on && _rider.active != null) {
      final stay = await _confirmOffDutyWithOrder();
      if (stay != false || !mounted) return;
    }
    await _rider.setDuty(on);
  }

  /// true = stay on duty (also when the sheet is dismissed), false = go off duty anyway.
  Future<bool?> _confirmOffDutyWithOrder() {
    return showKSheet<bool>(
      context,
      builder: (ctx) {
        final k = ctx.k;
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text('Stay on duty?', textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
            const SizedBox(height: 8),
            Text(
              'You are carrying an order. Going off duty stops new orders, but your live location keeps going to the customer until this delivery is finished or released. Stay on duty?',
              textAlign: TextAlign.center,
              style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16),
            ),
            const SizedBox(height: 24),
            KButton(key: const ValueKey('stay-on-duty-button'), label: 'Stay on duty', large: true, onPressed: () => Navigator.of(ctx).pop(true)),
            const SizedBox(height: 12),
            KButton(
              key: const ValueKey('go-off-duty-anyway-button'),
              label: 'Go off duty anyway',
              kind: KButtonKind.ghost,
              large: true,
              onPressed: () => Navigator.of(ctx).pop(false),
            ),
          ]),
        );
      },
    );
  }

  // ---- push (Docs/18) ----

  @override
  void onPushForeground(PushPayload payload) {
    if (!mounted) return;
    // The app is open and already updates over the socket: no banner, just one refresh. An off-duty rider has no pool.
    if (payload.event == PushEvent.newDelivery && !_rider.onDuty) return;
    unawaited(_rider.pollNow());
  }

  @override
  void onPushTap(PushPayload payload) {
    if (!mounted) return;
    // Close pushed pages (runner pass, ...) but leave any open dialog alone.
    Navigator.of(context).popUntil((route) => route.isFirst || route is! PageRoute);
    switch (payload.event) {
      case PushEvent.newDelivery:
        _goTab(0);
        if (_rider.onDuty) unawaited(_rider.pollNow());
      case PushEvent.deliveryAssigned:
        _goTab(0);
        _rider.pollNow().then((_) {
          if (mounted && _rider.active != null) _goTab(1);
        });
      case PushEvent.deliveryCancelled:
        _goTab(0);
        unawaited(_rider.pollNow());
    }
  }

  /// Explain-then-ask, once per phone, right after an approved rider is signed in.
  Future<void> _maybeExplainNotifications() async {
    final push = _push;
    if (push == null || !mounted || _explaining || !push.needsExplanation) return;
    _explaining = true;
    try {
      final agreed = await showNotificationsExplainSheet(context);
      await push.markExplained();
      if (agreed) await push.requestPermission();
    } finally {
      _explaining = false;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _messages?.cancel();
    _push?.removeListener(_maybeExplainNotifications);
    _push?.detachUi(this);
    _sessionCtl?.dutyReading.removeListener(_syncDutyFromSession);
    _rider.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _rider.resume();
      unawaited(_push?.onAppResumed());
    } else if (state == AppLifecycleState.paused) {
      _rider.pause();
    }
  }

  void _showMessage(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 3)));
  }

  Future<void> _claim(OrderView offer) async {
    final ok = await _rider.claim(offer);
    if (ok && mounted) setState(() => selectedTab = 1);
  }

  void _openRunnerPass() {
    final partner = SessionScope.maybeOf(context)?.session;
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => RunnerIdCardScreen(
          name: (partner == null || partner.name.isEmpty) ? 'Runner' : partner.name,
          runnerId: (partner?.runnerCode ?? '').isEmpty ? '-' : partner!.runnerCode!,
        ),
      ),
    );
  }

  void _openAccountSheet() {
    final partner = SessionScope.maybeOf(context)?.session;
    if (partner == null) return;
    showAccountSheet(context, partner: partner, onOpenPass: _openRunnerPass, onLogout: _confirmLogout);
  }

  /// Asks first, then signs out. Going off duty on the server is part of the sign-out, so a
  /// logged-out phone never keeps receiving jobs. The session gate swaps to the login screen
  /// once the controller reports signed-out.
  Future<void> _confirmLogout() async {
    final controller = SessionScope.maybeOf(context);
    if (controller == null) return;
    final confirmed = await showLogoutConfirm(context, hasActiveJob: _rider.active != null);
    if (!confirmed || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Logging out...'), duration: Duration(seconds: 6)));
    await _rider.stopForLogout();
    await controller.logout(beforeClear: () => DriverApiService.toggleDutyStatus(false));
    messenger.hideCurrentSnackBar();
  }

  void _goTab(int i) => setState(() => selectedTab = i);

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _push == null ? _rider : Listenable.merge([_rider, _push]),
      builder: (context, _) => Scaffold(
        extendBody: true,
        body: IndexedStack(
          index: selectedTab,
          children: [
            _buildHomeDutyTab(),
            ActiveDeliveryScreen(controller: _rider, onGoHome: () => _goTab(0)),
            EarningsHistoryScreen(controller: _rider),
            TripLogsScreen(controller: _rider),
          ],
        ),
        bottomNavigationBar: KGlassNav(
          index: selectedTab,
          onChanged: _goTab,
          items: [
            const KNavItem(LucideIcons.house, 'Home'),
            KNavItem(LucideIcons.bike, 'Active', badge: (_rider.active != null || _rider.notice != null) ? 1 : 0),
            const KNavItem(LucideIcons.wallet, 'Earnings'),
            const KNavItem(LucideIcons.history, 'Trips'),
          ],
        ),
      ),
    );
  }

  Widget _buildHomeDutyTab() {
    final k = context.k;
    final partner = SessionScope.maybeOf(context)?.session;
    final r = _rider;
    final now = r.services.now();
    final active = r.active;
    final notice = r.notice;
    return SafeArea(
      bottom: false,
      child: Builder(builder: (context) {
        final bottomInset = MediaQuery.paddingOf(context).bottom;
        return RefreshIndicator(
          onRefresh: r.pollNow,
          child: ListView(
            padding: EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, bottomInset + 24),
            children: [
              // Header: brand + ID pass + support
              Row(
                children: [
                  const KBrandMark(height: 40),
                  const Spacer(),
                  KIconButton(icon: LucideIcons.badgeCheck, semanticLabel: 'Open runner ID pass', onTap: _openRunnerPass),
                  const SizedBox(width: 10),
                  KIconButton(icon: LucideIcons.siren, semanticLabel: 'Contact Kraveo support', tint: KraveoPalette.danger, onTap: () => showSupportSheet(context)),
                ],
              ),
              if (partner != null) ...[
                const SizedBox(height: 16),
                _GreetingRow(partner: partner, onTap: _openAccountSheet),
              ],
              const SizedBox(height: 20),

              // Notifications blocked: a rider must not go on duty unaware that a locked phone will stay silent.
              if (_push?.showBlockedBanner ?? false) ...[
                NotificationsBlockedBanner(
                  key: const ValueKey('push-blocked-banner'),
                  opensSettings: _push!.mustOpenSettings,
                  onFix: () => unawaited(_push!.fixPermission()),
                ),
                const SizedBox(height: 16),
              ],

              // Hero duty control (truthful: ON only after Kraveo confirmed it)
              DutyToggle(isOnline: r.onDuty, busy: r.dutyBusy, alertsOff: _push?.showBlockedBanner ?? false, onChanged: _onDutyChanged),
              if (r.sharingLocation) _LocationLine(state: r.location, postFailed: r.lastLocationPostFailed, onFix: r.fixLocation),
              const SizedBox(height: 16),

              KReveal(
                child: EarningsCard(
                  todayEarnings: RiderController.feesOf(r.deliveredToday),
                  completedTrips: r.deliveredToday.length,
                  weekFees: RiderController.feesOf(r.deliveredThisWeek),
                  onTap: () => _goTab(2),
                  unavailable: r.historyError && !r.historyLoaded,
                  onRetry: () => unawaited(r.loadHistory()),
                ),
              ),
              const SizedBox(height: 8),

              // Job area
              if (notice != null) ...[
                const SectionLabel('Update', padding: EdgeInsets.fromLTRB(4, 16, 4, 8)),
                KCard(
                  key: const ValueKey('home-notice'),
                  onTap: () => _goTab(1),
                  borderColor: notice.kind == NoticeKind.cancelled ? KraveoPalette.danger : k.brand.withValues(alpha: 0.55),
                  padding: const EdgeInsets.all(18),
                  child: Row(children: [
                    Icon(notice.kind == NoticeKind.delivered ? LucideIcons.circleCheck : LucideIcons.triangleAlert,
                        color: notice.kind == NoticeKind.cancelled ? KraveoPalette.danger : k.brand),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        switch (notice.kind) {
                          NoticeKind.delivered => 'Order ${notice.order.shortRef} delivered',
                          NoticeKind.cancelled => 'Stop – order ${notice.order.shortRef} was cancelled',
                          NoticeKind.reassigned => 'Order ${notice.order.shortRef} was moved away from you',
                        },
                        style: KraveoType.titleLg.copyWith(color: k.ink),
                      ),
                    ),
                    Icon(LucideIcons.chevronRight, color: k.inkFaint),
                  ]),
                ),
              ],
              if (active != null) ...[
                const SectionLabel('In progress', padding: EdgeInsets.fromLTRB(4, 16, 4, 8)),
                KCard(
                  padding: const EdgeInsets.all(20),
                  borderColor: k.brand.withValues(alpha: 0.55),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Order ${active.shortRef} · ${active.restaurantName}',
                          maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.headlineSm.copyWith(color: k.ink)),
                      const SizedBox(height: 16),
                      PipelineStepper(currentStep: PipelineStepper.stepFor(active.status)),
                      const SizedBox(height: 20),
                      KButton(
                        label: 'Open active delivery',
                        icon: LucideIcons.arrowRight,
                        kind: KButtonKind.accent,
                        large: true,
                        onPressed: () => _goTab(1),
                      ),
                    ],
                  ),
                ),
              ] else if (!r.onDuty) ...[
                const SectionLabel('Orders', padding: EdgeInsets.fromLTRB(4, 16, 4, 8)),
                KCard(
                  child: KEmptyState(
                    icon: LucideIcons.wifiOff,
                    title: 'You are off duty',
                    message: 'Go on duty to start receiving campus orders.',
                    action: KButton(
                      label: 'Go on duty',
                      icon: LucideIcons.power,
                      large: true,
                      expand: false,
                      loading: r.dutyBusy,
                      onPressed: () => r.setDuty(true),
                    ),
                  ),
                ),
              ] else ...[
                SectionLabel(r.offers.isEmpty ? 'Orders' : 'New orders (${r.offers.length})', padding: const EdgeInsets.fromLTRB(4, 16, 4, 8)),
                if (r.offersStale)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Row(children: [
                      Icon(LucideIcons.wifiOff, size: 18, color: k.inkMuted),
                      const SizedBox(width: 8),
                      Expanded(child: Text('Can\'t reach Kraveo – retrying. Orders below may be out of date.', style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
                    ]),
                  ),
                if (!r.offersLoaded)
                  const KCard(
                    child: Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Center(child: SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))),
                    ),
                  )
                else if (r.offers.isEmpty)
                  const KCard(
                    padding: EdgeInsets.zero,
                    clip: true,
                    child: Stack(
                      clipBehavior: Clip.hardEdge,
                      alignment: Alignment.topCenter,
                      children: [
                        // Radar rings are centred on the KEmptyState icon circle (32px padding + 42px radius).
                        Positioned(top: 74 - 130, left: 0, right: 0, child: Center(child: RadarPulse(size: 260))),
                        KEmptyState(
                          icon: LucideIcons.radar,
                          title: 'You\'re online - waiting for orders',
                          message: 'Stay near the campus gate. New orders appear here.',
                        ),
                      ],
                    ),
                  )
                else
                  for (final offer in r.offers)
                    Padding(
                      key: ValueKey('offer-${offer.id}'),
                      padding: const EdgeInsets.only(bottom: 12),
                      child: OfferCard(
                        order: offer,
                        now: now,
                        claiming: r.claimingId == offer.id,
                        disabled: r.claimingId != null && r.claimingId != offer.id,
                        onAccepted: () => _claim(offer),
                        onDeclined: () => r.dismissOffer(offer.id),
                      ),
                    ),
              ],

              // Runner pass entry
              const SizedBox(height: 16),
              KCard(
                onTap: _openRunnerPass,
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
                child: Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.md)),
                      child: Icon(LucideIcons.badgeCheck, color: k.brand, size: 24),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Runner ID pass', style: KraveoType.titleLg.copyWith(color: k.ink)),
                          Text('Show at the hostel gate', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                        ],
                      ),
                    ),
                    Icon(LucideIcons.chevronRight, color: k.inkFaint),
                  ],
                ),
              ),
              if (partner != null) ...[
                const SizedBox(height: 12),
                KCard(
                  key: const ValueKey('logout-card'),
                  onTap: _confirmLogout,
                  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
                  child: Semantics(
                    label: 'Log out',
                    excludeSemantics: true,
                    child: Row(
                      children: [
                        Container(
                          width: 44,
                          height: 44,
                          decoration: BoxDecoration(color: KraveoPalette.danger.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(KRadius.md)),
                          child: const Icon(LucideIcons.logOut, color: KraveoPalette.danger, size: 24),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Log out', style: KraveoType.titleLg.copyWith(color: k.ink)),
                              Text('End your shift on this phone', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                            ],
                          ),
                        ),
                        Icon(LucideIcons.chevronRight, color: k.inkFaint),
                      ],
                    ),
                  ),
                ),
              ],
            ],
          ),
        );
      }),
    );
  }
}

/// GPS state under the duty switch. Never shows a made-up position: problems are named, with a fix.
class _LocationLine extends StatelessWidget {
  const _LocationLine({required this.state, required this.postFailed, required this.onFix});
  final LocationState state;
  final bool postFailed;
  final Future<void> Function() onFix;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final (IconData icon, Color color, String text, String? action) = switch (state) {
      LocationState.ok => (
          LucideIcons.locateFixed,
          k.brand,
          postFailed ? 'GPS on – could not send it to Kraveo, retrying' : 'Live location is being shared',
          null,
        ),
      LocationState.waiting || LocationState.off => (LucideIcons.locate, k.inkMuted, 'Finding your location…', null),
      LocationState.serviceOff => (LucideIcons.mapPinOff, KraveoPalette.danger, 'Location unavailable: GPS is turned off', 'Turn on GPS'),
      LocationState.permissionDenied => (LucideIcons.mapPinOff, KraveoPalette.danger, 'Location unavailable: Kraveo is not allowed to use it', 'Allow location'),
      LocationState.permissionDeniedForever => (LucideIcons.mapPinOff, KraveoPalette.danger, 'Location blocked for Kraveo in phone settings', 'Open settings'),
      LocationState.unavailable => (LucideIcons.mapPinOff, KStatus.placed.color, 'Location unavailable – no GPS signal. Still trying…', null),
    };
    return Padding(
      key: const ValueKey('location-line'),
      padding: const EdgeInsets.fromLTRB(8, 10, 8, 0),
      child: Row(children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 8),
        Expanded(child: Text(text, style: KraveoType.bodySm.copyWith(color: color == k.inkMuted ? k.inkMuted : k.ink))),
        if (action != null) ...[
          const SizedBox(width: 8),
          KButton(label: action, kind: KButtonKind.tonal, expand: false, onPressed: onFix),
        ],
      ]),
    );
  }
}

/// "Hi, Vikram" under the header: who is on duty. Opens the account sheet.
class _GreetingRow extends StatelessWidget {
  const _GreetingRow({required this.partner, required this.onTap});

  final PartnerSession partner;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final code = partner.runnerCode ?? '';
    return KPressable(
      semanticLabel: 'Account: ${partner.name}. Double tap to open.',
      onTap: onTap,
      scale: 0.98,
      child: ExcludeSemantics(
        child: Row(children: [
          KAvatar(id: partner.avatarId, size: 48),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Hi, ${partner.firstName}', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink)),
              if (code.isNotEmpty) Text(code, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted, letterSpacing: 0.8)),
            ]),
          ),
          Icon(LucideIcons.chevronRight, color: k.inkFaint),
        ]),
      ),
    );
  }
}
