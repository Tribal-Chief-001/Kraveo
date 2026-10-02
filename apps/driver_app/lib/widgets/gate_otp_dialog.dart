import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../state/rider_controller.dart';
import 'ui/icon_action.dart';
import 'ui/keypad.dart';

/// Full-screen keypad for the 4-digit code the customer reads out at the drop point.
///
/// The app never knows the right code: every check is done by Kraveo (`POST /orders/:id/verify-gate-otp`)
/// through [onSubmit]. Wrong codes show the tries left (when Kraveo says), and a locked delivery
/// tells the rider to call support.
class GateOtpDialog extends StatefulWidget {
  final String orderRef;
  final String customerName;
  final String gateName;
  final Future<OtpOutcome> Function(String code) onSubmit;

  /// Start in the locked state (Kraveo already refused this delivery's code 5 times).
  final bool initiallyLocked;

  const GateOtpDialog({
    super.key,
    required this.orderRef,
    required this.customerName,
    required this.gateName,
    required this.onSubmit,
    this.initiallyLocked = false,
  });

  @override
  State<GateOtpDialog> createState() => _GateOtpDialogState();
}

class _GateOtpDialogState extends State<GateOtpDialog> with SingleTickerProviderStateMixin {
  static const int _len = 4;

  String _pin = '';
  String _errorMessage = '';
  bool _isVerifying = false;
  bool _success = false;
  late bool _lockedOut = widget.initiallyLocked;

  late final AnimationController _shake = AnimationController(vsync: this, duration: const Duration(milliseconds: 420));

  @override
  void dispose() {
    _shake.dispose();
    super.dispose();
  }

  bool get _locked => _isVerifying || _success || _lockedOut;

  void _onDigit(String d) {
    if (_locked || _pin.length >= _len) return;
    setState(() {
      _pin += d;
      _errorMessage = '';
    });
  }

  void _onBackspace() {
    if (_locked || _pin.isEmpty) return;
    setState(() {
      _pin = _pin.substring(0, _pin.length - 1);
      _errorMessage = '';
    });
  }

  void _fail(String message) {
    HapticFeedback.heavyImpact();
    _shake.forward(from: 0);
    setState(() {
      _errorMessage = message;
    });
  }

  Future<void> _verifyOtp() async {
    if (_locked) return;
    final enteredOtp = _pin;
    if (enteredOtp.length < _len) {
      _fail('Enter all 4 digits');
      return;
    }

    setState(() {
      _isVerifying = true;
      _errorMessage = '';
    });
    final outcome = await widget.onSubmit(enteredOtp);
    if (!mounted) return;
    setState(() => _isVerifying = false);

    switch (outcome.kind) {
      case OtpOutcomeKind.delivered:
        setState(() => _success = true);
        HapticFeedback.mediumImpact();
        await Future<void>.delayed(const Duration(milliseconds: 450));
        if (mounted) Navigator.of(context).pop(true);
      case OtpOutcomeKind.wrong:
        setState(() => _pin = '');
        final left = outcome.attemptsLeft;
        _fail(left == null
            ? 'Wrong code. Ask the customer again.'
            : 'Wrong code. $left ${left == 1 ? 'try' : 'tries'} left.');
      case OtpOutcomeKind.locked:
        setState(() {
          _pin = '';
          _lockedOut = true;
        });
        _fail(RiderController.supportMessage);
      case OtpOutcomeKind.network:
        // Keep the digits: retrying the same code is safe.
        _fail('No internet – the code was not checked. Try again.');
      case OtpOutcomeKind.error:
        _fail(outcome.message ?? 'Kraveo could not check the code. Try again.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Dialog.fullscreen(
      backgroundColor: k.bg,
      child: SafeArea(
        child: LayoutBuilder(builder: (context, c) {
          return SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: c.maxHeight - 24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Row(children: [
                    KIconButton(
                      icon: LucideIcons.x,
                      semanticLabel: 'Close code entry',
                      onTap: () {
                        if (!_isVerifying && !_success) Navigator.of(context).pop(false);
                      },
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Customer code', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.headline.copyWith(color: k.ink)),
                          Text('Order ${widget.orderRef}', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkFaint)),
                        ],
                      ),
                    ),
                  ]),
                  const SizedBox(height: 10),
                  Text(
                    _lockedOut ? 'This delivery is locked after too many wrong codes.' : 'Ask ${widget.customerName} for their 4-digit code at ${widget.gateName}',
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: KraveoType.titleMd.copyWith(color: k.inkMuted),
                  ),
                  const SizedBox(height: 14),
                  AnimatedBuilder(
                    animation: _shake,
                    builder: (_, child) => Transform.translate(
                      offset: Offset(math.sin(_shake.value * math.pi * 6) * 12 * (1 - _shake.value), 0),
                      child: child,
                    ),
                    child: _PinBoxes(pin: _pin, length: _len, error: _errorMessage.isNotEmpty, success: _success),
                  ),
                  SizedBox(
                    height: 52,
                    child: Center(
                      child: _success
                          ? Row(mainAxisSize: MainAxisSize.min, children: [
                              Icon(LucideIcons.circleCheck, size: 20, color: k.brand),
                              const SizedBox(width: 8),
                              Text('Delivered', style: KraveoType.titleMd.copyWith(color: k.brand)),
                            ])
                          : Text(
                              _errorMessage,
                              textAlign: TextAlign.center,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: KraveoType.titleMd.copyWith(color: KraveoPalette.danger),
                            ),
                    ),
                  ),
                  KKeypad(onDigit: _onDigit, onBackspace: _onBackspace, enabled: !_locked),
                  const SizedBox(height: 6),
                  if (_lockedOut)
                    KButton(label: 'Close', icon: LucideIcons.x, kind: KButtonKind.tonal, large: true, onPressed: () => Navigator.of(context).pop(false))
                  else
                    KButton(
                      label: 'Verify & deliver',
                      icon: LucideIcons.packageCheck,
                      kind: KButtonKind.accent,
                      large: true,
                      loading: _isVerifying,
                      onPressed: _success ? null : _verifyOtp,
                    ),
                ],
              ),
            ),
          );
        }),
      ),
    );
  }
}

class _PinBoxes extends StatelessWidget {
  const _PinBoxes({required this.pin, required this.length, required this.error, required this.success});

  final String pin;
  final int length;
  final bool error, success;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final border = success
        ? k.brand
        : error
            ? KraveoPalette.danger
            : null;
    return Semantics(
      label: 'Code, ${pin.length} of $length digits entered',
      child: ExcludeSemantics(
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          for (var i = 0; i < length; i++)
            Flexible(
              child: AnimatedContainer(
                duration: KMotion.fast,
                constraints: const BoxConstraints(maxWidth: 68),
                height: 72,
                margin: const EdgeInsets.symmetric(horizontal: 5),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: success ? k.brand.withValues(alpha: 0.16) : k.surface,
                  borderRadius: BorderRadius.circular(KRadius.lg),
                  border: Border.all(
                    color: border ?? (i == pin.length ? k.ink : (i < pin.length ? k.inkMuted : k.line)),
                    width: (border != null || i == pin.length) ? 2.5 : 1.5,
                  ),
                ),
                child: i < pin.length
                    ? Text(pin[i], style: KraveoType.numeric.copyWith(color: success ? k.brand : k.ink, fontSize: 40))
                    : const SizedBox.shrink(),
              ),
            ),
        ]),
      ),
    );
  }
}
