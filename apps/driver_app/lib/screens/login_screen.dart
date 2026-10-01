import 'dart:async';
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/partner_auth_service.dart';
import '../widgets/ui/phone_input.dart';

/// Delivery partner login: phone + password on the OLED-dark driver theme.
/// [onSubmit] performs the sign-in; on success the session gate swaps this screen out.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onSubmit, this.onCreateAccount});

  final Future<LoginResult> Function(String phone, String password) onSubmit;

  /// Opens the "create account" form. When null the link is not shown (older tests pump the screen alone).
  final VoidCallback? onCreateAccount;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phoneController = TextEditingController();
  final _passwordController = TextEditingController();
  final _passwordFocus = FocusNode();

  bool _busy = false;
  bool _showPassword = false;

  String? _phoneError;
  String? _passwordError;
  _LoginProblem? _problem;

  Timer? _ticker;
  int _lockLeft = 0;
  String? _lockedPhone;

  @override
  void dispose() {
    _ticker?.cancel();
    _phoneController.dispose();
    _passwordController.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  bool get _locked => _lockLeft > 0;

  static String _clock(int seconds) => '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';

  void _startLock(int seconds) {
    _ticker?.cancel();
    _lockedPhone = _phoneController.text.trim();
    _lockLeft = seconds < 1 ? 1 : seconds;
    _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() {
        _lockLeft--;
        if (_lockLeft <= 0) {
          _lockLeft = 0;
          _problem = null;
          timer.cancel();
        }
      });
    });
  }

  void _clearLock() {
    _ticker?.cancel();
    _lockLeft = 0;
    _lockedPhone = null;
  }

  Future<void> _submit() async {
    if (_busy || _locked) return;
    FocusScope.of(context).unfocus();
    final phone = _phoneController.text.trim();
    final password = _passwordController.text;

    final phoneError = isValidIndianMobile(phone) ? null : 'Enter your 10-digit mobile number';
    final passwordError = password.isEmpty ? 'Enter your password' : null;
    if (phoneError != null || passwordError != null) {
      setState(() {
        _phoneError = phoneError;
        _passwordError = passwordError;
        _problem = null;
      });
      return;
    }

    setState(() {
      _busy = true;
      _phoneError = null;
      _passwordError = null;
      _problem = null;
    });
    final LoginResult result;
    try {
      result = await widget.onSubmit(phone, password);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _problem = _problemFor(const LoginResult.failure(LoginFailure.server));
      });
      return;
    }
    if (!mounted) return;
    if (result.ok) {
      // The gate replaces this screen; clear the typed password from memory meanwhile.
      _passwordController.clear();
      setState(() => _busy = false);
      return;
    }
    setState(() {
      _busy = false;
      _problem = _problemFor(result);
      if (result.failure == LoginFailure.locked) _startLock(result.retryAfterSeconds);
      if (result.failure == LoginFailure.invalidCredentials) _passwordController.clear();
    });
  }

  _LoginProblem _problemFor(LoginResult r) {
    switch (r.failure!) {
      case LoginFailure.invalidCredentials:
        return _LoginProblem(icon: LucideIcons.keyRound, title: r.message ?? 'Wrong phone or password.');
      case LoginFailure.locked:
        return const _LoginProblem(icon: LucideIcons.lock, title: 'Too many wrong tries.', isLock: true);
      case LoginFailure.wrongRole:
        return _LoginProblem(icon: LucideIcons.store, title: r.message ?? 'This number is registered for another Kraveo app.');
      case LoginFailure.offline:
        return const _LoginProblem(icon: LucideIcons.wifiOff, title: 'Can\'t reach Kraveo. Check your internet and try again.');
      case LoginFailure.server:
        return const _LoginProblem(icon: LucideIcons.triangleAlert, title: 'Kraveo is having trouble. Please try again in a moment.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final locked = _locked;
    return Scaffold(
      backgroundColor: k.bg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 28),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const KReveal(child: KBrandMark(height: 48)),
                    const SizedBox(height: 24),
                    KReveal(
                      index: 1,
                      child: Semantics(
                        header: true,
                        child: Text('Delivery partner login', style: KraveoType.displayMd.copyWith(color: k.ink, fontSize: 32)),
                      ),
                    ),
                    const SizedBox(height: 6),
                    KReveal(
                      index: 1,
                      child: Text('Log in to start taking orders.', style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
                    ),
                    const SizedBox(height: 24),
                    KReveal(
                      index: 2,
                      child: _FieldBlock(
                        label: 'MOBILE NUMBER',
                        error: _phoneError,
                        child: Semantics(
                          label: 'Mobile number',
                          textField: true,
                          child: TextField(
                            key: const ValueKey('phone-field'),
                            controller: _phoneController,
                            enabled: !_busy,
                            keyboardType: TextInputType.phone,
                            textInputAction: TextInputAction.next,
                            autofillHints: const [AutofillHints.telephoneNumberNational],
                            inputFormatters: const [IndianPhoneInputFormatter()],
                            style: KraveoType.headlineSm.copyWith(color: k.ink, letterSpacing: 1, fontSize: 24),
                            onChanged: (value) => setState(() {
                              _phoneError = null;
                              // Editing the number clears an old error; the lock only applies to the
                              // number that was locked.
                              if (_locked && value.trim() != _lockedPhone) _clearLock();
                              if (!_locked) _problem = null;
                            }),
                            onSubmitted: (_) => _passwordFocus.requestFocus(),
                            decoration: InputDecoration(
                              hintText: '98765 43210',
                              contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 20),
                              prefixIcon: Padding(
                                padding: const EdgeInsets.only(left: 18, right: 10),
                                child: Row(mainAxisSize: MainAxisSize.min, children: [
                                  Text('+91', style: KraveoType.headlineSm.copyWith(color: k.inkMuted, fontSize: 24)),
                                  const SizedBox(width: 10),
                                  Container(width: 1.4, height: 28, color: k.line),
                                ]),
                              ),
                              prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
                              enabledBorder: _phoneError != null ? _errorBorder : null,
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    KReveal(
                      index: 3,
                      child: _FieldBlock(
                        label: 'PASSWORD',
                        error: _passwordError,
                        child: Semantics(
                          label: 'Password',
                          textField: true,
                          child: TextField(
                            key: const ValueKey('password-field'),
                            controller: _passwordController,
                            focusNode: _passwordFocus,
                            enabled: !_busy,
                            obscureText: !_showPassword,
                            enableSuggestions: false,
                            autocorrect: false,
                            keyboardType: TextInputType.visiblePassword,
                            textInputAction: TextInputAction.done,
                            autofillHints: const [AutofillHints.password],
                            style: KraveoType.titleLg.copyWith(color: k.ink, fontSize: 21),
                            onChanged: (_) => setState(() {
                              _passwordError = null;
                              if (_problem != null && !_locked) _problem = null;
                            }),
                            onSubmitted: (_) => _submit(),
                            decoration: InputDecoration(
                              hintText: 'Your password',
                              contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 20),
                              suffixIcon: Padding(
                                padding: const EdgeInsets.only(right: 6),
                                child: KPressable(
                                  semanticLabel: _showPassword ? 'Hide password' : 'Show password',
                                  onTap: () => setState(() => _showPassword = !_showPassword),
                                  child: SizedBox(
                                    width: 52,
                                    height: 52,
                                    child: ExcludeSemantics(
                                      child: Icon(_showPassword ? LucideIcons.eyeOff : LucideIcons.eye, size: 24, color: k.inkMuted),
                                    ),
                                  ),
                                ),
                              ),
                              suffixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
                              enabledBorder: _passwordError != null ? _errorBorder : null,
                            ),
                          ),
                        ),
                      ),
                    ),
                    _ProblemBanner(problem: _problem, lockLeft: _lockLeft),
                    const SizedBox(height: 22),
                    KReveal(
                      index: 4,
                      child: KButton(
                        key: const ValueKey('login-button'),
                        label: locked ? 'Try again in ${_clock(_lockLeft)}' : 'Log in',
                        icon: locked ? LucideIcons.timer : LucideIcons.logIn,
                        large: true,
                        loading: _busy,
                        onPressed: locked ? null : _submit,
                      ),
                    ),
                    if (widget.onCreateAccount != null) ...[
                      const SizedBox(height: 14),
                      KReveal(
                        index: 5,
                        child: KButton(
                          key: const ValueKey('create-account-button'),
                          label: 'New rider? Create account',
                          kind: KButtonKind.ghost,
                          icon: LucideIcons.userPlus,
                          onPressed: _busy ? null : widget.onCreateAccount,
                        ),
                      ),
                    ],
                    const SizedBox(height: 22),
                    KReveal(
                      index: 6,
                      child: KCard(
                        color: k.brandSoft,
                        elevated: false,
                        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Icon(LucideIcons.headset, size: 24, color: k.brand),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text('Forgot password? Ask Kraveo support.', style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16)),
                          ),
                        ]),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  static const OutlineInputBorder _errorBorder = OutlineInputBorder(
    borderRadius: BorderRadius.all(Radius.circular(KRadius.lg)),
    borderSide: BorderSide(color: KraveoPalette.danger, width: 1.8),
  );
}

class _LoginProblem {
  const _LoginProblem({required this.icon, required this.title, this.isLock = false});
  final IconData icon;
  final String title;
  final bool isLock;
}

class _FieldBlock extends StatelessWidget {
  const _FieldBlock({required this.label, required this.child, this.error});

  final String label;
  final Widget child;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13)),
      const SizedBox(height: 8),
      child,
      AnimatedSize(
        duration: KMotion.base,
        curve: KMotion.emphasized,
        alignment: Alignment.topLeft,
        child: error == null
            ? const SizedBox(width: double.infinity)
            : Semantics(
                liveRegion: true,
                child: Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Padding(padding: EdgeInsets.only(top: 2), child: Icon(LucideIcons.circleAlert, size: 18, color: KraveoPalette.danger)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(error!, style: KraveoType.bodySm.copyWith(color: KraveoPalette.danger, fontSize: 15, fontWeight: FontWeight.w700))),
                  ]),
                ),
              ),
      ),
    ]);
  }
}

class _ProblemBanner extends StatelessWidget {
  const _ProblemBanner({required this.problem, required this.lockLeft});

  final _LoginProblem? problem;
  final int lockLeft;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final p = problem;
    return AnimatedSize(
      duration: KMotion.base,
      curve: KMotion.emphasized,
      alignment: Alignment.topCenter,
      child: p == null
          ? const SizedBox(width: double.infinity)
          : Semantics(
              liveRegion: true,
              child: Padding(
                padding: const EdgeInsets.only(top: 18),
                child: Container(
                  key: const ValueKey('login-problem'),
                  width: double.infinity,
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.14), k.surface),
                    borderRadius: BorderRadius.circular(KRadius.lg),
                    border: Border.all(color: KraveoPalette.danger, width: 1.6),
                  ),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Icon(p.icon, size: 26, color: KraveoPalette.danger),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(p.title, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 17, fontWeight: FontWeight.w800)),
                        if (p.isLock && lockLeft > 0) ...[
                          const SizedBox(height: 2),
                          Text('Try again in ${_LoginScreenState._clock(lockLeft)}',
                              style: KraveoType.titleMd.copyWith(color: KraveoPalette.danger, fontSize: 17, fontWeight: FontWeight.w800)),
                        ],
                      ]),
                    ),
                  ]),
                ),
              ),
            ),
    );
  }
}
