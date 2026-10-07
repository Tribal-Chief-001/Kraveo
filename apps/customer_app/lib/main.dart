import 'dart:async';

import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import 'providers/dhaba_provider.dart';
import 'providers/cart_provider.dart';
import 'providers/order_provider.dart';
import 'providers/session_provider.dart';
import 'services/customer_api_service.dart';
import 'services/google_auth_service.dart';
import 'services/push/firebase_push.dart';
import 'services/push/push_service.dart';
import 'screens/live_tracking_screen.dart';
import 'screens/auth_screen.dart';
import 'screens/home_screen.dart';
import 'screens/profile_setup_screen.dart';
import 'widgets/ui/snack.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // Push is an addition: the real Firebase layer starts after the first frame (AuthGate) and
  // can fail without affecting anything else.
  final push = PushService(
    messaging: FirebasePushMessaging(),
    local: PlatformLocalNotifier(),
    settings: MethodChannelSystemSettings(),
  );
  runApp(KraveoCustomerApp(push: push));
}

class KraveoCustomerApp extends StatelessWidget {
  /// [googleAuth] and [createOrders] are test seams; the real Google layer and the real order
  /// backend are used when they are null.
  const KraveoCustomerApp({super.key, this.googleAuth, this.createOrders, this.push});

  final GoogleAuthService? googleAuth;
  final OrderProvider Function()? createOrders;

  /// Push notifications (Docs/18). Null (the default, used by tests) means no push at all.
  final PushService? push;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => SessionProvider(googleAuth: googleAuth)),
        ChangeNotifierProvider(create: (_) => DhabaProvider()),
        ChangeNotifierProvider(create: (_) => CartProvider()),
        ChangeNotifierProvider(create: (_) => createOrders?.call() ?? OrderProvider()),
        if (push != null) ChangeNotifierProvider<PushService>.value(value: push!),
      ],
      child: MaterialApp(
        title: 'Kraveo',
        debugShowCheckedModeBanner: false,
        theme: KraveoTheme.customer(),
        home: const AuthGate(),
      ),
    );
  }
}

/// Owns the account lifecycle: decides between splash, login, first-time setup and the app,
/// and wires session expiry (HTTP 401) and sign-out to the user-specific providers.
class AuthGate extends StatefulWidget {
  const AuthGate({super.key});

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  late final SessionProvider _session = context.read<SessionProvider>();

  /// Null when the app runs without push (tests, or no Firebase wiring).
  late final PushService? _push = Provider.of<PushService?>(context, listen: false);
  late final AppLifecycleListener _lifecycle = AppLifecycleListener(onResume: () => unawaited(_push?.onAppResumed()));
  bool _routingTap = false;

  @override
  void initState() {
    super.initState();
    _session.onUserLoaded = (user) {
      context.read<CartProvider>().setKraveoCoins(user.kraveoCoins);
      // Restore this student's active order(s) and history from the server. A different
      // student than before wipes the previous one's orders first.
      context.read<OrderProvider>().beginSession(user.id);
      unawaited(_push?.onSessionStarted(user.id));
    };
    _session.onSignedOut = _resetUserState;
    _session.beforeSignOut = _push?.onSessionEnding;
    CustomerApiService.onUnauthorized = _handleUnauthorized;
    _setUpPush();
    _session.restore();
  }

  void _setUpPush() {
    final push = _push;
    if (push == null) return;
    _lifecycle; // start listening
    final orders = context.read<OrderProvider>();
    push.onOrderEvent = (p) {
      // A push arrived while the app is open: refresh that order once through the normal path.
      if (orders.userId != null) unawaited(orders.refreshOrder(p.orderId));
    };
    push.isOrderVisible = orders.isWatching;
    push.addListener(_drainPendingTap);
    // After the first frame, so Firebase start-up never delays the first paint.
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(push.start()));
  }

  /// Routes a tapped notification to its order once the student is signed in. A tap that
  /// arrives signed out is dropped (the login screen is the right place to land).
  void _drainPendingTap() {
    final push = _push;
    if (push == null || push.pendingTap == null || _routingTap) return;
    switch (_session.status) {
      case SessionStatus.checking:
      case SessionStatus.unreachable:
        return; // keep it; tried again when the session settles
      case SessionStatus.signedOut:
      case SessionStatus.needsProfile:
        push.clearPendingTap();
        return;
      case SessionStatus.signedIn:
        break;
    }
    final tap = push.takePendingTap();
    if (tap == null) return;
    _routingTap = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _routingTap = false;
      if (!mounted || _session.status != SessionStatus.signedIn) return;
      final navigator = Navigator.of(context);
      // A push for any restaurant of a combined order opens the one screen of the whole order:
      // name the route by the order's primary id when it is known, so a second tap (for another
      // restaurant's part) finds the screen that is already open.
      final orderId = context.read<OrderProvider>().orderById(tap.orderId)?.id ?? tap.orderId;
      final routeName = 'track:$orderId';
      String? topName;
      navigator.popUntil((route) {
        topName = route.settings.name;
        return true;
      });
      // The screen on top may have been opened through another part of the same combined order.
      final top = topName;
      final topId = top != null && top.startsWith('track:') ? top.substring(6) : null;
      final topCanonical = topId == null ? top : 'track:${context.read<OrderProvider>().orderById(topId)?.id ?? topId}';
      if (topCanonical == routeName) return; // already showing it
      navigator.popUntil((route) => route.isFirst);
      navigator.push(MaterialPageRoute<void>(
        settings: RouteSettings(name: routeName),
        builder: (_) => LiveTrackingScreen(orderId: orderId),
      ));
    });
  }

  @override
  void dispose() {
    final push = _push;
    if (push != null) {
      push.removeListener(_drainPendingTap);
      push.onOrderEvent = null;
      push.isOrderVisible = null;
      _lifecycle.dispose();
    }
    _session.onUserLoaded = null;
    _session.onSignedOut = null;
    _session.beforeSignOut = null;
    if (CustomerApiService.onUnauthorized == _handleUnauthorized) CustomerApiService.onUnauthorized = null;
    super.dispose();
  }

  void _resetUserState() {
    _push?.onSignedOut();
    // Orders are dropped immediately (and in-flight answers ignored) so nothing of the previous
    // student can show up on the next account.
    context.read<OrderProvider>().resetForLogout(notify: false);
    // Deferred: sign-out can happen mid-build of a screen that reads these providers.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.read<CartProvider>().resetForLogout();
      context.read<OrderProvider>().resetForLogout();
      context.read<DhabaProvider>().resetForLogout();
    });
  }

  /// A 401 came back from an authenticated call: back to login with an explanation.
  void _handleUnauthorized() {
    if (!mounted) return;
    final alreadySignedOut = _session.status == SessionStatus.signedOut;
    // Close checkout / menus that were pushed above the gate.
    Navigator.of(context).popUntil((route) => route.isFirst);
    _session.expire();
    if (!alreadySignedOut) {
      showKSnack(context, CustomerApiService.sessionExpiredMessage, icon: LucideIcons.logIn, error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionProvider>();
    if (_push?.pendingTap != null) WidgetsBinding.instance.addPostFrameCallback((_) => _drainPendingTap());
    switch (session.status) {
      case SessionStatus.checking:
        return const _SplashScreen();
      case SessionStatus.unreachable:
        return _SessionUnreachable(onRetry: session.retryRestore, onUseAnotherAccount: session.logout);
      case SessionStatus.signedOut:
        return const AuthScreen();
      case SessionStatus.needsProfile:
        return const ProfileSetupScreen();
      case SessionStatus.signedIn:
        return const HomeScreen();
    }
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          KBrandMark(height: 72),
          SizedBox(height: 28),
          SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 3)),
        ]),
      ),
    );
  }
}

/// Shown when a saved session exists but Kraveo cannot be reached. We keep the token so the
/// student is not logged out just because the network dropped.
class _SessionUnreachable extends StatefulWidget {
  const _SessionUnreachable({required this.onRetry, required this.onUseAnotherAccount});

  final Future<void> Function() onRetry;
  final Future<void> Function() onUseAnotherAccount;

  @override
  State<_SessionUnreachable> createState() => _SessionUnreachableState();
}

class _SessionUnreachableState extends State<_SessionUnreachable> {
  bool _busy = false;

  Future<void> _retry() async {
    setState(() => _busy = true);
    await widget.onRetry();
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(KSpace.gutter),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: KEmptyState(
                icon: LucideIcons.wifiOff,
                title: 'Can\'t reach Kraveo',
                message: 'Check your connection and try again. You are still signed in.',
                action: Column(mainAxisSize: MainAxisSize.min, children: [
                  KButton(label: 'Try again', icon: LucideIcons.rotateCcw, loading: _busy, onPressed: _retry),
                  const SizedBox(height: 12),
                  KButton(label: 'Use a different account', kind: KButtonKind.ghost, onPressed: _busy ? null : widget.onUseAnotherAccount),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
