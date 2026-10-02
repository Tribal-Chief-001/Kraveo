import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'screens/driver_home.dart';
import 'models/partner_session.dart';
import 'screens/application_status_screen.dart';
import 'screens/login_screen.dart';
import 'screens/signup_screen.dart';
import 'services/driver_api_service.dart';
import 'services/partner_auth_service.dart';
import 'session/session_controller.dart';
import 'state/rider_controller.dart';

void main() {
  runApp(const KraveoDriverApp());
}

class KraveoDriverApp extends StatefulWidget {
  /// [auth] is the network layer for login / session checks; tests pass a fake.
  /// [riderServices] builds the order API, socket and GPS for the home screen (null = the real ones).
  const KraveoDriverApp({super.key, this.auth, this.riderServices});

  final PartnerAuthService? auth;
  final RiderServices Function()? riderServices;

  @override
  State<KraveoDriverApp> createState() => _KraveoDriverAppState();
}

class _KraveoDriverAppState extends State<KraveoDriverApp> {
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
        title: 'Kraveo Delivery Partner',
        debugShowCheckedModeBanner: false,
        theme: KraveoTheme.driver(),
        home: AuthGate(session: _session, riderServices: widget.riderServices),
      ),
    );
  }
}

/// Decides between splash, login, the "can't reach Kraveo" retry state and the app, and wires
/// session expiry (HTTP 401 on any authenticated call) to the login screen.
class AuthGate extends StatefulWidget {
  const AuthGate({super.key, required this.session, this.riderServices});

  final SessionController session;
  final RiderServices Function()? riderServices;

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> with WidgetsBindingObserver {
  SessionController get _session => widget.session;

  @override
  void initState() {
    super.initState();
    DriverApiService.onUnauthorized = _handleUnauthorized;
    DriverApiService.onNotApproved = _handleNotApproved;
    WidgetsBinding.instance.addObserver(this);
    _session.restore();
  }

  @override
  void dispose() {
    if (DriverApiService.onUnauthorized == _handleUnauthorized) DriverApiService.onUnauthorized = null;
    if (DriverApiService.onNotApproved == _handleNotApproved) DriverApiService.onNotApproved = null;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// The sign-up form (new account), or the same form prefilled to fix a pending / rejected application.
  void _openSignup({PartnerSession? existing}) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => SignupScreen(
        existing: existing,
        onSubmit: existing == null ? _session.signUp : _session.resubmit,
      ),
    ));
  }

  /// An admin suspended this account while the app was open (the server answered 403 PARTNER_NOT_APPROVED), or
  /// the app has just come back to the foreground: ask Kraveo, and the gate swaps in the status screen if needed.
  void _handleNotApproved() {
    if (!mounted || _session.status != SessionStatus.signedIn) return;
    Navigator.of(context).popUntil((route) => route.isFirst);
    _session.refreshApproval();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _session.status == SessionStatus.signedIn) _session.refreshApproval();
  }

  /// A 401 came back from an authenticated call: back to login with an explanation.
  void _handleUnauthorized() {
    if (!mounted || _session.status != SessionStatus.signedIn) return;
    // Close the runner pass / dialogs that sit above the gate.
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
            Expanded(child: Text(DriverApiService.sessionExpiredMessage)),
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
            return LoginScreen(onSubmit: _session.login, onCreateAccount: _openSignup);
          case SessionStatus.signedIn:
            final me = _session.session;
            // Only an approved rider reaches the delivery screens; everyone else sees where they stand.
            if (me != null && me.approval != PartnerApproval.approved) {
              return ApplicationStatusScreen(
                key: ValueKey('application-${me.approval.name}'),
                session: me,
                onRefresh: _session.refreshApproval,
                onEdit: () => _openSignup(existing: me),
                onLogout: _session.logout,
              );
            }
            return DriverHomeScreen(services: widget.riderServices?.call());
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
          label: 'Loading Kraveo Delivery Partner',
          child: const Column(mainAxisSize: MainAxisSize.min, children: [
            KBrandMark(height: 64),
            SizedBox(height: 28),
            SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3)),
          ]),
        ),
      ),
    );
  }
}

/// A saved login exists but Kraveo cannot be reached. The token is kept, so a dropped network
/// never logs a rider out mid-shift.
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
                const SizedBox(height: 8),
                Text('Check your internet. You are still logged in.', textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
                const SizedBox(height: 20),
                KButton(label: 'Retry', icon: LucideIcons.rotateCcw, large: true, loading: _busy, onPressed: _retry),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
