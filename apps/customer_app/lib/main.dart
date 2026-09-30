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
import 'screens/auth_screen.dart';
import 'screens/home_screen.dart';
import 'screens/profile_setup_screen.dart';
import 'widgets/ui/snack.dart';

void main() {
  runApp(const KraveoCustomerApp());
}

class KraveoCustomerApp extends StatelessWidget {
  /// [googleAuth] is a test seam; the real Google layer is used when it is null.
  const KraveoCustomerApp({super.key, this.googleAuth});

  final GoogleAuthService? googleAuth;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => SessionProvider(googleAuth: googleAuth)),
        ChangeNotifierProvider(create: (_) => DhabaProvider()),
        ChangeNotifierProvider(create: (_) => CartProvider()),
        ChangeNotifierProvider(create: (_) => OrderProvider()),
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

  @override
  void initState() {
    super.initState();
    _session.onUserLoaded = (user) => context.read<CartProvider>().setKraveoCoins(user.kraveoCoins);
    _session.onSignedOut = _resetUserState;
    CustomerApiService.onUnauthorized = _handleUnauthorized;
    _session.restore();
  }

  @override
  void dispose() {
    _session.onUserLoaded = null;
    _session.onSignedOut = null;
    if (CustomerApiService.onUnauthorized == _handleUnauthorized) CustomerApiService.onUnauthorized = null;
    super.dispose();
  }

  void _resetUserState() {
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
