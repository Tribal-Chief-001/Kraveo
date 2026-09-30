import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'screens/login_screen.dart';
import 'screens/vendor_home_screen.dart';
import 'services/order_queue_service.dart';
import 'services/partner_auth_service.dart';
import 'services/vendor_api_service.dart';
import 'session/session_controller.dart';

void main() {
  runApp(const KraveoVendorApp());
}

class KraveoVendorApp extends StatefulWidget {
  /// [auth] is the network layer for login / session checks; tests pass a fake.
  const KraveoVendorApp({super.key, this.auth});

  final PartnerAuthService? auth;

  @override
  State<KraveoVendorApp> createState() => _KraveoVendorAppState();
}

class _KraveoVendorAppState extends State<KraveoVendorApp> {
  late final SessionController _session = SessionController(auth: widget.auth);

  @override
  void dispose() {
    _session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SessionScope(
      controller: _session,
      child: MaterialApp(
        title: 'Kraveo Restaurant Partner',
        debugShowCheckedModeBanner: false,
        theme: KraveoTheme.vendor(),
        // The vendor theme already renders type ~12% larger; cap the system font scale so
        // huge accessibility settings enlarge text without breaking the fixed 64px targets.
        builder: (context, child) => MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: child ?? const SizedBox.shrink()),
        home: AuthGate(session: _session),
      ),
    );
  }
}

/// Decides between splash, login, the "can't reach Kraveo" retry state and the app, and wires
/// session expiry (HTTP 401 on any authenticated call) and sign-out to the rest of the app.
class AuthGate extends StatefulWidget {
  const AuthGate({super.key, required this.session});

  final SessionController session;

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  SessionController get _session => widget.session;
  SessionStatus? _lastStatus;

  @override
  void initState() {
    super.initState();
    _lastStatus = _session.status;
    _session.addListener(_onSessionChanged);
    VendorApiService.onUnauthorized = _handleUnauthorized;
    _session.restore();
  }

  @override
  void dispose() {
    _session.removeListener(_onSessionChanged);
    if (VendorApiService.onUnauthorized == _handleUnauthorized) VendorApiService.onUnauthorized = null;
    super.dispose();
  }

  /// Leaving the signed-in state (log out or expiry): stop anything that belongs to the old
  /// partner, such as a ringing order alarm or queued order pop-ups.
  void _onSessionChanged() {
    final was = _lastStatus;
    _lastStatus = _session.status;
    if (was != SessionStatus.signedOut && _session.status == SessionStatus.signedOut) {
      OrderQueueService.clearQueue();
    }
  }

  /// A 401 came back from an authenticated call: back to login with an explanation.
  void _handleUnauthorized() {
    if (!mounted || _session.status != SessionStatus.signedIn) return;
    // Close dialogs / pushed pages that sit above the gate.
    Navigator.of(context).popUntil((route) => route.isFirst);
    _session.expire();
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        const SnackBar(
          duration: Duration(seconds: 5),
          content: Row(children: [
            Icon(LucideIcons.logIn, size: 22, color: Colors.white),
            SizedBox(width: 10),
            Expanded(child: Text('${VendorApiService.sessionExpiredMessage}  ·  सेशन खत्म हो गया, फिर से लॉग इन करें')),
          ]),
        ),
      );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _session,
      builder: (context, _) {
        switch (_session.status) {
          case SessionStatus.checking:
            return const _SplashScreen();
          case SessionStatus.unreachable:
            return _SessionUnreachable(onRetry: _session.retryRestore);
          case SessionStatus.signedOut:
            return LoginScreen(onSubmit: _session.login);
          case SessionStatus.signedIn:
            return const VendorHomeScreen();
        }
      },
    );
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Semantics(
          label: 'Loading Kraveo Restaurant Partner',
          child: const Column(mainAxisSize: MainAxisSize.min, children: [
            KBrandMark(height: 72),
            SizedBox(height: 28),
            SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3)),
          ]),
        ),
      ),
    );
  }
}

/// A saved login exists but Kraveo cannot be reached. The token is kept, so a dropped network
/// never logs the kitchen out.
class _SessionUnreachable extends StatefulWidget {
  const _SessionUnreachable({required this.onRetry});

  final Future<void> Function() onRetry;

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
    final k = context.k;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(KSpace.gutter),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Container(
                  width: 68,
                  height: 68,
                  decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
                  child: Icon(LucideIcons.wifiOff, size: 32, color: k.brand),
                ),
                const SizedBox(height: 16),
                Text('Can\'t reach Kraveo', textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
                Text('Kraveo से कनेक्ट नहीं हो पा रहा', textAlign: TextAlign.center, style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
                const SizedBox(height: 8),
                Text('Check your internet. You are still logged in.', textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
                const SizedBox(height: 20),
                KButton(label: 'Retry', sublabel: 'फिर कोशिश करें', icon: LucideIcons.rotateCcw, large: true, loading: _busy, onPressed: _retry),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
