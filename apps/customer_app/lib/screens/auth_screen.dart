import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/auth_results.dart';
import '../services/customer_api_service.dart';
import '../widgets/ui/display_text.dart';
import '../widgets/ui/error_line.dart';
import '../widgets/ui/otp_boxes.dart';
import '../widgets/ui/phone_input.dart';
import '../widgets/ui/snack.dart';

/// Phone login in two steps: number, then the 4-digit SMS code.
/// Calls [onVerified] once the backend has accepted the code (token already saved).
class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.onVerified});

  final ValueChanged<VerifyOtpResult> onVerified;

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _phoneController = TextEditingController();
  final _otpController = TextEditingController();
  final _otpFocus = FocusNode();
  bool _otpRequested = false;
  bool _isLoading = false;
  String? _errorMessage;
  int _errorTick = 0;

  Timer? _ticker;

  /// Seconds until the code can be re-sent (OTP step), or until sending is allowed again
  /// after a 429 (phone step).
  int _resendLeft = 0;

  /// Seconds the code entry stays locked after too many wrong tries.
  int _lockLeft = 0;
  int _expiresInSeconds = 300;
  String? _limitedPhone;

  @override
  void dispose() {
    _ticker?.cancel();
    _phoneController.dispose();
    _otpController.dispose();
    _otpFocus.dispose();
    super.dispose();
  }

  String get _phone => _phoneController.text.trim();

  static String _clock(int seconds) => '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';

  void _ensureTicker() {
    if (_ticker?.isActive ?? false) return;
    _ticker = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() {
        if (_resendLeft > 0) _resendLeft--;
        if (_lockLeft > 0) {
          _lockLeft--;
          if (_lockLeft == 0) {
            _errorMessage = null;
            _refocusOtp();
          }
        }
      });
      if (_resendLeft == 0 && _lockLeft == 0) timer.cancel();
    });
  }

  void _startResend(int seconds) {
    setState(() => _resendLeft = seconds < 1 ? 1 : seconds);
    _ensureTicker();
  }

  void _refocusOtp() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _otpRequested) _otpFocus.requestFocus();
    });
  }

  String _sendFailure(SendOtpResult r, {required bool resend}) {
    if (r.networkError) return 'We couldn\'t reach Kraveo. Check your connection and try again.';
    if (r.unavailable) return 'We couldn\'t send the code right now. Please try again in a little while.';
    if (r.rateLimited) return r.message ?? 'Too many code requests. Please wait a moment and try again.';
    if (r.statusCode == 400) return r.message ?? 'That doesn\'t look like a valid mobile number.';
    return r.message ?? (resend ? 'Could not resend the code. Please try again.' : 'Could not send the code. Please try again.');
  }

  Future<void> _requestOtp() async {
    FocusScope.of(context).unfocus();
    if (_isLoading) return;
    final problem = validateIndianMobile(_phone);
    if (problem != null) {
      setState(() => _errorMessage = problem);
      return;
    }
    if (_resendLeft > 0 && _limitedPhone == _phone) return;

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final result = await CustomerApiService.sendOtp(_phone);
    if (!mounted) return;
    if (result.success) {
      _otpController.clear();
      setState(() {
        _isLoading = false;
        _otpRequested = true;
        _errorMessage = null;
        _lockLeft = 0;
        _expiresInSeconds = result.expiresInSeconds;
        _limitedPhone = null;
      });
      _startResend(result.resendAfterSeconds);
      return;
    }
    setState(() {
      _isLoading = false;
      _errorMessage = _sendFailure(result, resend: false);
    });
    if (result.rateLimited) {
      _limitedPhone = _phone;
      _startResend(result.retryAfterSeconds ?? 30);
    }
  }

  Future<void> _resendOtp() async {
    if (_resendLeft > 0 || _isLoading) return;
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final result = await CustomerApiService.sendOtp(_phone);
    if (!mounted) return;
    if (result.success) {
      _otpController.clear();
      setState(() {
        _isLoading = false;
        _lockLeft = 0;
        _expiresInSeconds = result.expiresInSeconds;
      });
      _startResend(result.resendAfterSeconds);
      _refocusOtp();
      showKSnack(context, 'New code sent to +91 $_phone', icon: LucideIcons.messageSquare);
      return;
    }
    setState(() {
      _isLoading = false;
      _errorMessage = _sendFailure(result, resend: true);
    });
    if (result.rateLimited) _startResend(result.retryAfterSeconds ?? 30);
  }

  Future<void> _verifyOtp([String? completed]) async {
    if (_isLoading || _lockLeft > 0) return;
    final code = (completed ?? _otpController.text).trim();
    if (!RegExp(r'^\d{4}$').hasMatch(code)) {
      FocusScope.of(context).unfocus();
      setState(() {
        _errorMessage = 'Enter the 4-digit code we sent you.';
        _errorTick++;
      });
      return;
    }

    FocusScope.of(context).unfocus();
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final result = await CustomerApiService.verifyOtp(_phone, code);
    if (!mounted) return;
    if (result.success) {
      setState(() => _isLoading = false);
      widget.onVerified(result);
      return;
    }

    if (result.networkError) {
      // Keep the digits: nothing was wrong with them.
      setState(() {
        _isLoading = false;
        _errorMessage = 'We couldn\'t reach Kraveo. Check your connection and tap Verify to try again.';
      });
      return;
    }
    if (result.unavailable || (result.statusCode != null && result.statusCode! >= 500)) {
      setState(() {
        _isLoading = false;
        _errorMessage = 'Verification is unavailable right now. Please try again in a moment.';
      });
      return;
    }
    if (result.locked) {
      _otpController.clear();
      setState(() {
        _isLoading = false;
        _lockLeft = result.retryAfterSeconds ?? 300;
        _errorMessage = result.message ?? 'Too many wrong codes. Please wait before trying again.';
        _errorTick++;
      });
      _ensureTicker();
      return;
    }
    if (result.roleNotAllowed) {
      _otpController.clear();
      setState(() {
        _isLoading = false;
        _errorMessage = result.message ?? 'This number can\'t sign in to the customer app.';
      });
      return;
    }

    final left = result.attemptsLeft;
    final base = result.message ?? 'That code didn\'t work.';
    final tail = left == null ? 'Request a new code if it expired.' : (left <= 0 ? 'No attempts left.' : '$left ${left == 1 ? 'attempt' : 'attempts'} left.');
    _otpController.clear();
    setState(() {
      _isLoading = false;
      _errorMessage = '${base.replaceFirst(RegExp(r'[.!\s]+$'), '')}. $tail';
      _errorTick++;
    });
    _refocusOtp();
  }

  void _changeNumber() {
    _ticker?.cancel();
    setState(() {
      _otpRequested = false;
      _otpController.clear();
      _errorMessage = null;
      _resendLeft = 0;
      _lockLeft = 0;
      _limitedPhone = null;
    });
  }

  Future<void> _pasteCode() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final match = RegExp(r'(?<!\d)\d{4}(?!\d)').firstMatch(data?.text ?? '');
    if (!mounted) return;
    if (match == null) {
      showKSnack(context, 'No 4-digit code found on your clipboard.', error: true);
      return;
    }
    _otpController.text = match.group(0)!;
    _otpController.selection = TextSelection.collapsed(offset: _otpController.text.length);
    setState(() => _errorMessage = null);
    _verifyOtp(_otpController.text);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Scaffold(
      backgroundColor: k.bg,
      body: Stack(children: [
        // Soft brand-tinted shapes give the screen depth without adding noise.
        Positioned(
          top: -90,
          right: -70,
          child: Container(width: 260, height: 260, decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle)),
        ),
        Positioned(
          top: 120,
          right: -120,
          child: Container(width: 200, height: 200, decoration: BoxDecoration(color: KraveoPalette.g100.withValues(alpha: 0.55), shape: BoxShape.circle)),
        ),
        SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 24),
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 460),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const KReveal(child: Align(alignment: Alignment.centerLeft, child: KBrandMark(height: 46))),
                    const SizedBox(height: 28),
                    AnimatedSwitcher(
                      duration: KMotion.base,
                      switchInCurve: KMotion.emphasized,
                      transitionBuilder: (child, anim) => FadeTransition(
                        opacity: anim,
                        child: SlideTransition(position: Tween<Offset>(begin: const Offset(0.04, 0), end: Offset.zero).animate(anim), child: child),
                      ),
                      child: _otpRequested ? _buildOtpStep(context) : _buildPhoneStep(context),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _buildPhoneStep(BuildContext context) {
    final k = context.k;
    final hasError = _errorMessage != null;
    final coolingDown = _resendLeft > 0 && _limitedPhone == _phone;
    return Column(
      key: const ValueKey('phone-step'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        KReveal(index: 1, child: KDisplayText('Late-night\ncravings, sorted.', style: KraveoType.displayMd.copyWith(color: k.ink))),
        const SizedBox(height: 12),
        KReveal(
          index: 2,
          child: Text('Hot dhaba food, at your hostel gate.', style: KraveoType.body.copyWith(color: k.inkMuted)),
        ),
        const SizedBox(height: 24),
        KReveal(
          index: 3,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('MOBILE NUMBER', style: KraveoType.label.copyWith(color: k.inkMuted)),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('phone-field'),
              controller: _phoneController,
              enabled: !_isLoading,
              keyboardType: TextInputType.phone,
              textInputAction: TextInputAction.done,
              autofillHints: const [AutofillHints.telephoneNumberNational],
              inputFormatters: const [IndianPhoneInputFormatter()],
              style: KraveoType.headlineSm.copyWith(color: k.ink, letterSpacing: 1),
              onChanged: (_) {
                setState(() {
                  _errorMessage = null;
                  if (_limitedPhone != null && _limitedPhone != _phone) {
                    _resendLeft = 0;
                    _limitedPhone = null;
                  }
                });
              },
              onSubmitted: (_) => _requestOtp(),
              decoration: InputDecoration(
                hintText: '98765 43210',
                prefixIcon: Padding(
                  padding: const EdgeInsets.only(left: 18, right: 10),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Text('+91', style: KraveoType.headlineSm.copyWith(color: k.inkMuted)),
                    const SizedBox(width: 10),
                    Container(width: 1.4, height: 24, color: k.line),
                  ]),
                ),
                prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
                enabledBorder: hasError ? OutlineInputBorder(borderRadius: KRadius.control, borderSide: const BorderSide(color: KraveoPalette.danger, width: 1.6)) : null,
              ),
            ),
            KErrorLine(message: _errorMessage),
          ]),
        ),
        const SizedBox(height: 20),
        KReveal(
          index: 4,
          child: KButton(
            label: coolingDown ? 'Try again in ${_clock(_resendLeft)}' : 'Send code',
            icon: coolingDown ? LucideIcons.timer : LucideIcons.arrowRight,
            loading: _isLoading,
            onPressed: coolingDown ? null : _requestOtp,
          ),
        ),
        const SizedBox(height: 16),
        KReveal(
          index: 5,
          child: Row(children: [
            Icon(LucideIcons.shieldCheck, size: 16, color: k.brand),
            const SizedBox(width: 8),
            Expanded(child: Text('We text you a 4-digit code. No password to remember.', style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
          ]),
        ),
      ],
    );
  }

  Widget _buildOtpStep(BuildContext context) {
    final k = context.k;
    final hasError = _errorMessage != null;
    final locked = _lockLeft > 0;
    final minutes = (_expiresInSeconds / 60).round();
    return Column(
      key: const ValueKey('otp-step'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        KDisplayText('Enter your\n4-digit code', style: KraveoType.displayMd.copyWith(color: k.ink)),
        const SizedBox(height: 12),
        Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text('Sent to +91 $_phone  ', style: KraveoType.body.copyWith(color: k.inkMuted)),
          KPressable(
            onTap: _isLoading ? null : _changeNumber,
            semanticLabel: 'Change phone number',
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text('Change number', style: KraveoType.button.copyWith(color: k.brand, fontSize: 15)),
            ),
          ),
        ]),
        const SizedBox(height: 24),
        OtpBoxes(
          controller: _otpController,
          focusNode: _otpFocus,
          enabled: !_isLoading && !locked,
          hasError: hasError,
          errorTick: _errorTick,
          onChanged: (_) {
            if (_errorMessage != null && !locked) setState(() => _errorMessage = null);
          },
          onCompleted: _verifyOtp,
        ),
        KErrorLine(message: _errorMessage),
        const SizedBox(height: 4),
        Row(children: [
          KPressable(
            onTap: _isLoading || locked ? null : _pasteCode,
            semanticLabel: 'Paste code from clipboard',
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(LucideIcons.clipboardPaste, size: 16, color: k.inkMuted),
                const SizedBox(width: 6),
                Text('Paste code', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13)),
              ]),
            ),
          ),
          const Spacer(),
          if (_resendLeft > 0)
            Text('Resend in ${_clock(_resendLeft)}', style: KraveoType.label.copyWith(color: k.inkFaint, fontSize: 13))
          else
            KPressable(
              onTap: _isLoading ? null : _resendOtp,
              semanticLabel: 'Resend code',
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Text('Resend code', style: KraveoType.label.copyWith(color: k.brand, fontSize: 13)),
              ),
            ),
        ]),
        const SizedBox(height: 8),
        KButton(
          label: locked ? 'Try again in ${_clock(_lockLeft)}' : 'Verify & continue',
          icon: locked ? LucideIcons.timer : LucideIcons.arrowRight,
          loading: _isLoading,
          onPressed: locked ? null : _verifyOtp,
        ),
        const SizedBox(height: 14),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 1), child: Icon(LucideIcons.clock, size: 16, color: k.inkFaint)),
          const SizedBox(width: 8),
          Expanded(child: Text('The code is valid for $minutes ${minutes == 1 ? 'minute' : 'minutes'}.', style: KraveoType.bodySm.copyWith(color: k.inkMuted))),
        ]),
      ],
    );
  }
}
