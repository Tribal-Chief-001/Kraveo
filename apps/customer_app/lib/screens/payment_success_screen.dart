import 'dart:async';
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../widgets/ui/format.dart';

/// A short celebratory beat between "payment done" and the live tracking screen, so the student
/// sees clearly that the order went through. It hands over to tracking by itself after a moment
/// (or on tap) and never blocks: [onContinue] is called exactly once.
class PaymentSuccessScreen extends StatefulWidget {
  const PaymentSuccessScreen({
    super.key,
    required this.orderId,
    required this.amountLabel,
    required this.vendorName,
    required this.onContinue,
    this.confirming = false,
    this.autoContinue = const Duration(milliseconds: 2600),
  });

  final String orderId;
  final String amountLabel;
  final String vendorName;

  /// True when the bank has the payment but the server has not confirmed it yet.
  final bool confirming;
  final Duration autoContinue;
  final VoidCallback onContinue;

  @override
  State<PaymentSuccessScreen> createState() => _PaymentSuccessScreenState();
}

class _PaymentSuccessScreenState extends State<PaymentSuccessScreen> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500))..forward();
  Timer? _timer;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _timer = Timer(widget.autoContinue, _continue);
  }

  void _continue() {
    if (_done || !mounted) return;
    _done = true;
    _timer?.cancel();
    widget.onContinue();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final title = widget.confirming ? 'Payment received' : 'Payment successful';
    final line = widget.confirming
        ? 'We are confirming it with the bank. This takes a moment.'
        : 'Waiting for ${widget.vendorName} to accept your order.';
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: k.bg,
        body: SafeArea(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _continue,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  AnimatedBuilder(
                    animation: _c,
                    builder: (context, _) {
                      final pop = Curves.elasticOut.transform((_c.value * 1.6).clamp(0.0, 1.0));
                      final ring = Curves.easeOut.transform(_c.value);
                      return SizedBox(
                        width: 190,
                        height: 190,
                        child: Stack(alignment: Alignment.center, children: [
                          Opacity(
                            opacity: (1 - ring).clamp(0.0, 1.0),
                            child: Container(
                              width: 120 + 70 * ring,
                              height: 120 + 70 * ring,
                              decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: k.brand, width: 3)),
                            ),
                          ),
                          Transform.scale(
                            scale: pop,
                            child: Container(
                              width: 112,
                              height: 112,
                              decoration: BoxDecoration(color: k.brand, shape: BoxShape.circle),
                              child: Icon(LucideIcons.check, size: 60, color: k.onBrand),
                            ),
                          ),
                        ]),
                      );
                    },
                  ),
                  const SizedBox(height: 28),
                  KReveal(
                    index: 2,
                    child: Text(title, textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
                  ),
                  const SizedBox(height: 8),
                  KReveal(
                    index: 3,
                    child: Text(widget.amountLabel, style: KraveoType.numeric.copyWith(color: k.brand)),
                  ),
                  const SizedBox(height: 14),
                  KReveal(
                    index: 4,
                    child: Text(
                      'Order ${orderRef(widget.orderId)}',
                      style: KraveoType.label.copyWith(color: k.inkMuted),
                    ),
                  ),
                  const SizedBox(height: 10),
                  KReveal(
                    index: 5,
                    child: Text(line, textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted)),
                  ),
                  const SizedBox(height: 34),
                  KReveal(
                    index: 6,
                    child: KButton(label: 'Track my order', icon: LucideIcons.mapPin, onPressed: _continue),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
