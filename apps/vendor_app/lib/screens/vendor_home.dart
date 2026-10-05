import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import '../services/audio_alert_service.dart';
import '../services/failure_messages.dart';
import '../services/menu_stock_controller.dart';
import '../services/order_queue_controller.dart';
import '../services/order_queue_service.dart';
import '../services/order_socket.dart';
import '../services/push/push_controller.dart';
import '../services/vendor_backend.dart';
import '../session/session_controller.dart';
import '../models/partner_session.dart';
import 'kitchen_queue.dart';
import 'stock_manager.dart';
import 'sales_analytics.dart';
import '../widgets/location_flow.dart';
import '../widgets/push_status_cards.dart';
import '../widgets/ui/ui.dart';

class VendorHomeScreen extends StatefulWidget {
  /// Network layer; tests pass a fake. Defaults to the real Kraveo API.
  final VendorBackend? backend;

  /// Live order events; tests pass a fake. Defaults to Socket.io. Pass a factory returning null-free fakes.
  final OrderSocketFactory? socketFactory;

  /// The loud alarm; tests pass a fake.
  final AlarmSink? alarm;

  /// Restaurant id when no session is in scope (tests). Normally read from the signed-in session.
  final String? vendorId;

  final Duration pollInterval;

  const VendorHomeScreen({super.key, this.backend, this.socketFactory, this.alarm, this.vendorId, this.pollInterval = const Duration(seconds: 15)});

  @override
  State<VendorHomeScreen> createState() => _VendorHomeScreenState();
}

class _VendorHomeScreenState extends State<VendorHomeScreen> with WidgetsBindingObserver {
  int _currentIndex = 0;
  late final VendorBackend _backend = widget.backend ?? const HttpVendorBackend();
  OrderQueueController? _orders;
  MenuStockController? _menu;
  String? _vendorId;
  bool _initialised = false;

  // Push (null when the app runs without it, e.g. in tests).
  VoidCallback? _detachPush;
  bool _explainerOpen = false;

  /// The once-per-start "Set your restaurant location" sheet is open (or about to open).
  bool _locationPromptOpen = false;

  /// What the server last told us about the store (null until known).
  bool? _storeOpen;
  bool _storeBusy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _enableScreenWakeLock();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final push = PushScope.maybeOf(context);
    if (push != null) {
      _detachPush ??= push.attachHome(_onPushAction);
      _maybeExplainNotifications(push);
    }
    _maybeLocationPrompt(push);
    if (_initialised) return;
    _initialised = true;
    final session = SessionScope.maybeOf(context)?.session;
    // The REAL restaurant id of the signed-in owner. There is no fallback id: without one, no orders load.
    _vendorId = widget.vendorId ?? session?.vendorId;
    _storeOpen = session?.isAcceptingOrders;
    final id = _vendorId;
    if (id == null || id.isEmpty) return;
    final orders = OrderQueueController(
      backend: _backend,
      vendorId: id,
      socket: (widget.socketFactory ?? SocketIoOrderSocket.new)(),
      alarm: widget.alarm,
      pollInterval: widget.pollInterval,
    );
    orders.addListener(_onOrdersChanged);
    _orders = orders;
    _menu = MenuStockController(backend: _backend, vendorId: id);
    orders.start();
    _syncStoreStatus();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _detachPush?.call();
    _orders?.removeListener(_onOrdersChanged);
    _orders?.dispose();
    _menu?.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from the background (or the phone woke up): reload at once, never wait for the next tick.
    // The in-app alarm only rings while the app is on screen; in the background the system notification rings instead.
    _orders?.setAppInForeground(state == AppLifecycleState.resumed);
    if (state == AppLifecycleState.resumed) {
      _orders?.onResumed();
      _syncStoreStatus();
    }
  }

  Future<void> _enableScreenWakeLock() async {
    try {
      await WakelockPlus.enable();
    } catch (_) {}
  }

  /// A paid order is waiting: open its full-screen takeover (queued one after another).
  void _onOrdersChanged() {
    final c = _orders;
    if (c == null || !mounted) return;
    final waiting = c.incoming;
    if (waiting.isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || c.isDisposed) return;
      for (final o in c.incoming) {
        OrderQueueService.enqueueIncomingOrder(context, o.id, c);
      }
    });
  }

  /// A push told us something: reload once; a tap also shows the kitchen queue and, for a new order that is
  /// still waiting for an answer, its takeover.
  Future<void> _onPushAction(PushAction action) async {
    final c = _orders;
    if (!mounted || c == null || c.isDisposed) return;
    if (action.kind == PushActionKind.showQueue && _currentIndex != 0) setState(() => _currentIndex = 0);
    await c.refresh();
    if (!mounted || c.isDisposed) return;
    final id = action.orderId;
    if (action.kind == PushActionKind.showQueue && id != null && c.byId(id)?.isIncoming == true) {
      OrderQueueService.enqueueIncomingOrder(context, id, c);
    }
  }

  /// Right after an approved login: say why before the system asks (never on the first frame, only once).
  void _maybeExplainNotifications(PushController push) {
    if (_explainerOpen || !push.shouldExplain) return;
    _explainerOpen = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted || !push.shouldExplain) {
        _explainerOpen = false;
        return;
      }
      push.markExplained();
      final agreed = await showConfirmSheet(
        context,
        icon: LucideIcons.bellRing,
        title: 'Hear every new order',
        hindiTitle: 'हर नया ऑर्डर सुनें',
        message: 'Kraveo needs to send you notifications so a new order rings on this phone, even when the app is closed or the screen is locked.\nऐप बंद या स्क्रीन लॉक होने पर भी नया ऑर्डर बजे, इसके लिए नोटिफिकेशन चालू करें।',
        safeLabel: 'Not now',
        safeSublabel: 'अभी नहीं',
        confirmLabel: 'Allow notifications',
        confirmSublabel: 'नोटिफिकेशन चालू करें',
        destructive: false,
      );
      _explainerOpen = false;
      if (agreed) await push.requestNotifications();
      if (mounted) _maybeLocationPrompt(push);
    });
  }

  /// Notification permission is settled: not waiting for the system to report it, and no explainer open or due.
  bool _pushSettled(PushController? push) =>
      push == null || (!_explainerOpen && !push.shouldExplain && (!push.isActive || push.notificationAccess != null));

  /// Once per app start / login, when Kraveo says this restaurant has no map location: offer the detect sheet.
  /// It waits for the notification explainer (one thing at a time, notifications first); the banner stays either way.
  void _maybeLocationPrompt(PushController? push) {
    if (_locationPromptOpen || !_pushSettled(push)) return;
    if (!shouldPromptForLocation(SessionScope.maybeOf(context))) return;
    _locationPromptOpen = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted || _explainerOpen || !shouldPromptForLocation(SessionScope.maybeOf(context))) {
        _locationPromptOpen = false;
        return;
      }
      await promptForRestaurantLocation(context);
      _locationPromptOpen = false;
    });
  }

  void _openIncoming(String orderId) {
    final c = _orders;
    if (c == null) return;
    OrderQueueService.enqueueIncomingOrder(context, orderId, c);
  }

  Future<void> _syncStoreStatus() async {
    final id = _vendorId;
    if (id == null || _storeBusy) return;
    final res = await _backend.fetchStoreOpen(id);
    if (!mounted || _storeBusy || !res.ok) return;
    setState(() => _storeOpen = res.data);
  }

  void _toast(String text, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text(text),
        backgroundColor: error ? kDangerDeep : null,
        duration: Duration(seconds: error ? 5 : 2),
      ));
  }

  /// Opening is instant (it is always safe). Closing asks first, because a mis-tap would
  /// silently stop new orders in the middle of a rush. Live orders are never touched by this switch.
  Future<void> _toggleStoreStatusWithConfirmation(bool newValue) async {
    final id = _vendorId;
    if (_storeBusy) return;
    if (id == null) {
      _toast('This login is not linked to a restaurant. Call Kraveo.  ·  Kraveo को फ़ोन करें', error: true);
      return;
    }
    if (!newValue) {
      final confirmed = await showConfirmSheet(
        context,
        icon: LucideIcons.powerOff,
        title: 'Close the store?',
        hindiTitle: 'दुकान बंद करें?',
        message: 'You will stop getting new orders until you open again. Orders you already have stay.\nनए ऑर्डर आना बंद हो जाएंगे। चालू ऑर्डर बने रहेंगे।',
        safeLabel: 'Keep open',
        safeSublabel: 'खुला रखें',
        confirmLabel: 'Yes, close store',
        confirmSublabel: 'हाँ, बंद करें',
      );
      if (!confirmed || !mounted) return;
    }

    final before = _storeOpen;
    setState(() {
      _storeOpen = newValue;
      _storeBusy = true;
    });
    final res = await _backend.setStoreOpen(id, newValue);
    if (!mounted) return;
    setState(() {
      _storeBusy = false;
      // Never show a state the server did not save.
      _storeOpen = res.ok ? res.data : before;
    });
    if (res.ok) {
      _toast(res.data == true ? 'Store is now OPEN for orders  ·  दुकान खुली' : 'Store is now CLOSED  ·  दुकान बंद');
    } else {
      _toast('Could not ${newValue ? 'open' : 'close'} the store. ${failureText(res.failure!, serverMessage: res.message, code: res.code).both}', error: true);
    }
  }

  /// Plays the alarm so the owner can check the volume. No order is created.
  Future<void> _testAlarm() async {
    await AudioAlertService.startLoudAlarm();
    if (!mounted) return;
    await showConfirmSheet(
      context,
      icon: LucideIcons.bellRing,
      title: 'Can you hear the alarm?',
      hindiTitle: 'क्या अलार्म सुनाई दे रहा है?',
      message: 'Turn the phone volume up if it is quiet.\nआवाज़ कम है तो फ़ोन की आवाज़ बढ़ाएं।',
      safeLabel: 'Stop alarm',
      safeSublabel: 'अलार्म बंद करें',
      confirmLabel: 'Yes, I hear it',
      confirmSublabel: 'हाँ, सुनाई दे रहा है',
      destructive: false,
    );
    await AudioAlertService.stopAlarm();
    // A real order may be waiting: let it ring again.
    _orders?.resyncAlarm();
  }

  void _callCampusAdminSupport() {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Row(
          children: [
            Icon(LucideIcons.phone, color: context.k.onBrand),
            const SizedBox(width: 10),
            const Expanded(child: Text('Kraveo Campus Ops helpline: +91 98765 43214')),
          ],
        ),
        duration: const Duration(seconds: 4),
      ),
    );
  }

  /// Asks first (a mis-tap would stop order alerts on this phone), then signs out. The session
  /// gate swaps to the login screen once the controller reports signed-out.
  Future<void> _confirmLogout() async {
    final controller = SessionScope.maybeOf(context);
    if (controller == null) return;
    final confirmed = await showConfirmSheet(
      context,
      icon: LucideIcons.logOut,
      title: 'Log out?',
      hindiTitle: 'लॉग आउट करें?',
      message: 'You will not get new order alerts on this phone until you log in again.\nदोबारा लॉग इन करने तक इस फ़ोन पर नए ऑर्डर नहीं आएंगे।',
      safeLabel: 'Stay logged in',
      safeSublabel: 'लॉग इन रहें',
      confirmLabel: 'Yes, log out',
      confirmSublabel: 'हाँ, लॉग आउट',
    );
    if (!confirmed || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Logging out…  ·  लॉग आउट हो रहा है'), duration: Duration(seconds: 6)));
    await controller.logout();
    messenger.hideCurrentSnackBar();
  }

  void _openHelpSheet() {
    final partner = SessionScope.maybeOf(context)?.session;
    showKSheet<void>(
      context,
      builder: (sheetContext) {
        final k = sheetContext.k;
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Need help?', style: KraveoType.headline.copyWith(color: k.ink)),
            Text('मदद चाहिए?', style: KraveoType.titleLg.copyWith(color: k.inkMuted)),
            const SizedBox(height: 16),
            KCard(
              color: k.brandSoft,
              elevated: false,
              child: Row(children: [
                Icon(LucideIcons.headset, size: 30, color: k.brand),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Kraveo Campus Ops', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
                    FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text('+91 98765 43214', style: KraveoType.headlineSm.copyWith(color: k.ink))),
                  ]),
                ),
              ]),
            ),
            const SizedBox(height: 16),
            KButton(
              label: 'Call helpline',
              sublabel: 'मदद के लिए फ़ोन',
              icon: LucideIcons.phoneCall,
              large: true,
              onPressed: () {
                Navigator.of(sheetContext).pop();
                _callCampusAdminSupport();
              },
            ),
            const SizedBox(height: 12),
            KButton(
              label: 'Test the order alarm',
              sublabel: 'अलार्म जाँचें',
              icon: LucideIcons.bellRing,
              kind: KButtonKind.tonal,
              large: true,
              onPressed: () {
                Navigator.of(sheetContext).pop();
                _testAlarm();
              },
            ),
            if (partner != null) ...[
              const SizedBox(height: 20),
              _AccountCard(partner: partner),
              if (partner.hasLocation != null) ...[
                const SizedBox(height: 12),
                KButton(
                  key: kLocationRowKey,
                  label: partner.hasLocation == true ? 'Update restaurant location' : 'Set restaurant location',
                  sublabel: partner.hasLocation == true ? 'रेस्टोरेंट की लोकेशन बदलें' : 'रेस्टोरेंट की लोकेशन डालें',
                  icon: LucideIcons.mapPin,
                  kind: KButtonKind.tonal,
                  large: true,
                  onPressed: () {
                    Navigator.of(sheetContext).pop();
                    if (mounted) runRestaurantLocationFlow(context, update: partner.hasLocation == true);
                  },
                ),
              ],
              const SizedBox(height: 12),
              KButton(
                key: const ValueKey('logout-button'),
                label: 'Log out',
                sublabel: 'लॉग आउट',
                icon: LucideIcons.logOut,
                kind: KButtonKind.ghost,
                large: true,
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  _confirmLogout();
                },
              ),
            ],
          ]),
        );
      },
    );
  }

  /// Owner name under the restaurant name (or the phone when the account is named after it).
  static String _headerSubtitle(PartnerSession? partner) {
    if (partner == null) return 'Kraveo Restaurant Partner';
    final owner = partner.name.trim();
    if (owner.isNotEmpty && owner != partner.restaurantName) return owner;
    return (partner.phone?.trim().isNotEmpty ?? false) ? partner.phone! : 'Kraveo Restaurant Partner';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final partner = SessionScope.maybeOf(context)?.session;
    final push = PushScope.maybeOf(context);
    final orders = _orders;
    final menu = _menu;

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            // Top bar: which store + help
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 6, 12, 0),
              child: Row(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(color: k.brand, borderRadius: BorderRadius.circular(KRadius.md)),
                    child: Icon(LucideIcons.store, color: k.onBrand, size: 24),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(partner?.restaurantName ?? 'Your restaurant', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
                        Text(_headerSubtitle(partner), maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
                      ],
                    ),
                  ),
                  Semantics(
                    button: true,
                    label: 'Help and support',
                    excludeSemantics: true,
                    child: KPressable(
                      onTap: _openHelpSheet,
                      child: Container(
                        width: 52,
                        height: 52,
                        decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
                        child: Icon(LucideIcons.headset, size: 26, color: k.brand),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),

            // The store OPEN / CLOSED control - always visible
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: KSpace.gutter),
              child: VMaxWidth(
                child: VStoreStatusHero(
                  isOpen: _storeOpen ?? true,
                  onTap: () => _toggleStoreStatusWithConfirmation(!(_storeOpen ?? true)),
                ),
              ),
            ),

            if (push != null)
              PushStatusCards(push: push, locationNotice: partner?.needsLocation == true ? const LocationBanner(key: kLocationBannerKey) : null)
            else if (partner?.needsLocation == true)
              const NoticeFrame(child: LocationBanner(key: kLocationBannerKey)),

            Expanded(
              child: (orders == null || menu == null)
                  ? const _NoRestaurantLinked()
                  : IndexedStack(
                      index: _currentIndex,
                      children: [
                        KitchenQueueScreen(controller: orders, onOpenIncoming: _openIncoming),
                        StockManagerScreen(controller: menu),
                        ListenableBuilder(
                          listenable: orders,
                          builder: (context, _) {
                            final now = DateTime.now();
                            final today = DateTime(now.year, now.month, now.day);
                            return SalesAnalyticsScreen(
                              orders: orders.allOrders,
                              now: now,
                              complete: orders.historyCovers(today),
                              loading: orders.historyLoading,
                              onRetry: () => orders.loadHistorySince(today),
                            );
                          },
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: orders == null
          ? null
          : ListenableBuilder(
              listenable: orders,
              builder: (context, _) => VBigNav(
                index: _currentIndex,
                onChanged: (index) {
                  setState(() => _currentIndex = index);
                  if (index == 2) {
                    final now = DateTime.now();
                    orders.loadHistorySince(DateTime(now.year, now.month, now.day));
                  }
                },
                items: [
                  VNavItem(icon: LucideIcons.chefHat, label: 'Orders', hindi: 'ऑर्डर', badge: orders.incoming.length + orders.kitchen.length),
                  const VNavItem(icon: LucideIcons.utensils, label: 'Menu', hindi: 'मेनू'),
                  const VNavItem(icon: LucideIcons.wallet, label: 'Earnings', hindi: 'कमाई'),
                ],
              ),
            ),
    );
  }
}

/// The signed-in account has no restaurant attached: say so instead of showing an empty kitchen.
class _NoRestaurantLinked extends StatelessWidget {
  const _NoRestaurantLinked();

  @override
  Widget build(BuildContext context) {
    return const VMaxWidth(
      child: VScrollCenter(
        child: KEmptyState(
          icon: LucideIcons.store,
          title: 'No restaurant linked',
          message: 'This login is not linked to a restaurant yet. Call Kraveo Campus Ops.\nयह खाता किसी रेस्टोरेंट से जुड़ा नहीं है। Kraveo को फ़ोन करें।',
        ),
      ),
    );
  }
}

/// "Logged in as" card inside the help sheet: who is signed in on this phone.
class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.partner});

  final PartnerSession partner;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final phone = partner.phone?.trim() ?? '';
    return KCard(
      elevated: false,
      child: Row(children: [
        KAvatar(id: partner.avatarId, size: 48),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Logged in as · लॉग इन', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 12.5)),
            Text(partner.restaurantName, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
            if (phone.isNotEmpty) Text(phone, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
          ]),
        ),
      ]),
    );
  }
}
