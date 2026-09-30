import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/driver_api_service.dart';
import 'ui/icon_action.dart';
import 'ui/keypad.dart';

class GateOtpDialog extends StatefulWidget {
  final String expectedOtp;
  final String orderId;
  final String customerName;
  final String gateName;
  final ValueChanged<String> onVerified;

  const GateOtpDialog({
    super.key,
    this.expectedOtp = '4829',
    required this.orderId,
    required this.customerName,
    this.gateName = 'Gate 2 Handshake',
    required this.onVerified,
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

  late final AnimationController _shake = AnimationController(vsync: this, duration: const Duration(milliseconds: 420));

  @override
  void dispose() {
    _shake.dispose();
    super.dispose();
  }

  bool get _locked => _isVerifying || _success;

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

  void _verifyOtp() {
    final enteredOtp = _pin;
    if (enteredOtp.length < 4) {
      _fail('Please enter complete 4-digit PIN');
      return;
    }

    setState(() {
      _isVerifying = true;
      _errorMessage = '';
    });

    Future.delayed(const Duration(milliseconds: 500), () {
      if (enteredOtp == widget.expectedOtp) {
        if (!mounted) return;
        setState(() {
          _isVerifying = false;
          _success = true;
        });
        HapticFeedback.mediumImpact();
        Future.delayed(const Duration(milliseconds: 350), () {
          if (!mounted) return;
          Navigator.of(context).pop();
          widget.onVerified(enteredOtp);
        });
      } else {
        DriverApiService.verifyGateOtp(widget.orderId, enteredOtp).then((isServerValid) {
          if (isServerValid && mounted) {
            Navigator.of(context).pop();
            widget.onVerified(enteredOtp);
          }
        }).catchError((_) {});

        if (!mounted) return;
        setState(() {
          _isVerifying = false;
          _pin = '';
        });
        _fail('Invalid OTP PIN. Check with student at gate.');
      }
    });
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
                      semanticLabel: 'Cancel PIN entry',
                      onTap: () {
                        if (!_locked) Navigator.of(context).pop();
                      },
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Gate PIN', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.headline.copyWith(color: k.ink)),
                          Text('Order ${widget.orderId}', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkFaint)),
                        ],
                      ),
                    ),
                  ]),
                  const SizedBox(height: 10),
                  Text(
                    'Ask ${widget.customerName} at ${widget.gateName}',
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
                    height: 34,
                    child: Center(
                      child: _success
                          ? Row(mainAxisSize: MainAxisSize.min, children: [
                              Icon(LucideIcons.circleCheck, size: 20, color: k.brand),
                              const SizedBox(width: 8),
                              Text('PIN verified', style: KraveoType.titleMd.copyWith(color: k.brand)),
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
      label: 'PIN, ${pin.length} of $length digits entered',
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
