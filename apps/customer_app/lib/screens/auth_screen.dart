import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/customer_api_service.dart';
import '../widgets/ui/display_text.dart';
import '../widgets/ui/format.dart';
import '../widgets/ui/otp_boxes.dart';
import '../widgets/ui/snack.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.onAuthenticated});

  final VoidCallback onAuthenticated;

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  static const int _resendSeconds = 30;

  final _phoneController = TextEditingController();
  final _otpController = TextEditingController();
  final _nameController = TextEditingController();
  final _otpFocus = FocusNode();
  bool _otpRequested = false;
  bool _isLoading = false;
  String? _errorMessage;
  int _errorTick = 0;
  Timer? _resendTimer;
  int _resendLeft = 0;

  @override
  void dispose() {
    _resendTimer?.cancel();
    _phoneController.dispose();
    _otpController.dispose();
    _nameController.dispose();
    _otpFocus.dispose();
    super.dispose();
  }

  String get _phone => _phoneController.text.trim();

  void _startResendCountdown() {
    _resendTimer?.cancel();
    setState(() => _resendLeft = _resendSeconds);
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() => _resendLeft = _resendLeft > 0 ? _resendLeft - 1 : 0);
      if (_resendLeft == 0) timer.cancel();
    });
  }

  Future<void> _requestOtp() async {
    FocusScope.of(context).unfocus();
    if (!RegExp(r'^\d{10}$').hasMatch(_phone)) {
      setState(() => _errorMessage = 'Enter your 10-digit Indian mobile number.');
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final sent = await CustomerApiService.sendOtp(_phone);
    if (!mounted) return;
    setState(() {
      _isLoading = false;
      _otpRequested = sent;
      _errorMessage = sent ? null : 'Unable to send OTP. Check your connection and try again.';
    });
    if (sent) _startResendCountdown();
  }

  Future<void> _resendOtp() async {
    if (_resendLeft > 0 || _isLoading) return;
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final sent = await CustomerApiService.sendOtp(_phone);
    if (!mounted) return;
    setState(() {
      _isLoading = false;
      _errorMessage = sent ? null : 'Could not resend the code. Check your connection and try again.';
    });
    if (sent) {
      _otpController.clear();
      _startResendCountdown();
      showKSnack(context, 'New code sent to +91 $_phone', icon: LucideIcons.messageSquare);
    }
  }

  Future<void> _verifyOtp() async {
    FocusScope.of(context).unfocus();
    if (!RegExp(r'^\d{4}$').hasMatch(_otpController.text.trim())) {
      setState(() {
        _errorMessage = 'Enter the 4-digit OTP sent to your phone.';
        _errorTick++;
      });
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final token = await CustomerApiService.verifyOtp(
      _phone,
      _otpController.text.trim(),
      name: _nameController.text.trim().isEmpty ? null : _nameController.text.trim(),
    );
    if (!mounted) return;
    setState(() => _isLoading = false);
    if (token == null) {
      setState(() {
        _errorMessage = 'Invalid or expired OTP. Request a new code and try again.';
        _errorTick++;
      });
      _otpController.clear();
      _otpFocus.requestFocus();
      return;
    }
    widget.onAuthenticated();
  }

  void _changeNumber() {
    _resendTimer?.cancel();
    setState(() {
      _otpRequested = false;
      _otpController.clear();
      _errorMessage = null;
      _resendLeft = 0;
    });
  }

  Future<void> _pasteCode() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final digits = (data?.text ?? '').replaceAll(RegExp(r'\D'), '');
    if (digits.length >= 4) {
      _otpController.text = digits.substring(0, 4);
      _otpController.selection = TextSelection.collapsed(offset: _otpController.text.length);
      setState(() => _errorMessage = null);
    } else if (mounted) {
      showKSnack(context, 'No 4-digit code found on your clipboard.', error: true);
    }
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
              controller: _phoneController,
              enabled: !_isLoading,
              keyboardType: TextInputType.phone,
              textInputAction: TextInputAction.done,
              autofillHints: const [AutofillHints.telephoneNumberNational],
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
              style: KraveoType.headlineSm.copyWith(color: k.ink, letterSpacing: 1),
              onChanged: (_) {
                if (_errorMessage != null) setState(() => _errorMessage = null);
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
            _ErrorLine(message: _errorMessage),
          ]),
        ),
        const SizedBox(height: 20),
        KReveal(
          index: 4,
          child: KButton(label: 'Send code', icon: LucideIcons.arrowRight, loading: _isLoading, onPressed: _requestOtp),
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
              child: Text('Change', style: KraveoType.button.copyWith(color: k.brand, fontSize: 15)),
            ),
          ),
        ]),
        const SizedBox(height: 24),
        OtpBoxes(
          controller: _otpController,
          focusNode: _otpFocus,
          enabled: !_isLoading,
          hasError: hasError,
          errorTick: _errorTick,
          onChanged: (_) {
            if (_errorMessage != null) setState(() => _errorMessage = null);
          },
        ),
        _ErrorLine(message: _errorMessage),
        const SizedBox(height: 4),
        Row(children: [
          KPressable(
            onTap: _isLoading ? null : _pasteCode,
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
            Text('Resend in 0:${_resendLeft.toString().padLeft(2, '0')}', style: KraveoType.label.copyWith(color: k.inkFaint, fontSize: 13))
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
        const SizedBox(height: 16),
        Text('YOUR NAME (OPTIONAL)', style: KraveoType.label.copyWith(color: k.inkMuted)),
        const SizedBox(height: 8),
        TextField(
          controller: _nameController,
          enabled: !_isLoading,
          textCapitalization: TextCapitalization.words,
          textInputAction: TextInputAction.done,
          autofillHints: const [AutofillHints.givenName],
          onSubmitted: (_) => _verifyOtp(),
          decoration: const InputDecoration(hintText: 'So your runner can greet you'),
        ),
        const SizedBox(height: 20),
        KButton(label: 'Verify & start ordering', icon: LucideIcons.arrowRight, loading: _isLoading, onPressed: _verifyOtp),
      ],
    );
  }
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine({required this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    return AnimatedSize(
      duration: KMotion.base,
      curve: KMotion.emphasized,
      alignment: Alignment.topLeft,
      child: message == null
          ? const SizedBox(width: double.infinity)
          : Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.circleAlert, size: 16, color: kDangerInk)),
                const SizedBox(width: 8),
                Expanded(child: Text(message!, style: KraveoType.bodySm.copyWith(color: kDangerInk, fontWeight: FontWeight.w600))),
              ]),
            ),
    );
  }
}
