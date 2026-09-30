import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../widgets/pipeline_stepper.dart';
import '../widgets/gate_otp_dialog.dart';
import '../widgets/ui/screen_header.dart';
import '../services/driver_api_service.dart';

class ActiveDeliveryScreen extends StatefulWidget {
  final int currentStep;
  final ValueChanged<int> onStepChanged;
  final VoidCallback onCompleted;
  final VoidCallback? onCancel;

  const ActiveDeliveryScreen({
    super.key,
    required this.currentStep,
    required this.onStepChanged,
    required this.onCompleted,
    this.onCancel,
  });

  @override
  State<ActiveDeliveryScreen> createState() => _ActiveDeliveryScreenState();
}

class _ActiveDeliveryScreenState extends State<ActiveDeliveryScreen> {
  final String orderId = '#ord-8492';
  final String customerName = 'Aman Sharma';
  final String customerPhone = '+91 98765 43210';
  final String dhabaName = 'FC Night Mess';
  final String hostelGate = 'Boys Hostel Block 1 (Gate 2)';

  bool _detailsOpen = false;

  void _callCustomer() {
    showDialog(
      context: context,
      builder: (context) {
        final k = context.k;
        return AlertDialog(
          title: Row(
            children: [
              Icon(LucideIcons.phoneCall, color: k.brand),
              const SizedBox(width: 12),
              Expanded(child: Text('Call $customerName', maxLines: 2, overflow: TextOverflow.ellipsis)),
            ],
          ),
          content: Text(
            'Dialing $customerPhone...\nMake sure to coordinate exact pickup/handshake gate.',
            style: KraveoType.body.copyWith(color: k.inkMuted),
          ),
          actions: [
            KButton(label: 'End call', kind: KButtonKind.danger, large: true, icon: LucideIcons.phone, onPressed: () => Navigator.pop(context)),
          ],
        );
      },
    );
  }

  void _openMapRoute() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Opening Navigation Route to Campus Gate...'),
        duration: Duration(seconds: 2),
      ),
    );
  }

  void _triggerGateOtp() {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => GateOtpDialog(
        orderId: orderId,
        customerName: customerName,
        gateName: hostelGate,
        expectedOtp: '4829',
        onVerified: (verifiedOtp) {
          DriverApiService.updateDeliveryStatus(orderId, 'DELIVERED', otpCode: verifiedOtp);
          widget.onCompleted();
        },
      ),
    );
  }

  void _advanceStep() {
    final nextStep = widget.currentStep + 1;
    if (nextStep == 1) {
      DriverApiService.updateDeliveryStatus(orderId, 'PICKED_UP');
    } else if (nextStep == 2) {
      DriverApiService.updateDeliveryStatus(orderId, 'ARRIVED_AT_GATE');
    }
    widget.onStepChanged(nextStep);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final step = widget.currentStep.clamp(0, 3);
    final bottomInset = MediaQuery.paddingOf(context).bottom;

    final (String headline, String where, String slideLabel, IconData slideIcon) = switch (step) {
      0 => ('Go to restaurant', dhabaName, 'Slide · picked up', LucideIcons.package),
      1 => ('Ride to the gate', hostelGate, 'Slide · at the gate', LucideIcons.mapPin),
      2 => ('Meet the student', hostelGate, 'Slide · student here', LucideIcons.handshake),
      _ => ('Hand over the order', 'Ask $customerName for the 4-digit PIN', '', LucideIcons.hash),
    };

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: EdgeInsets.only(bottom: bottomInset + 24),
          children: [
            ScreenHeader(
              title: 'Delivery',
              subtitle: 'Order $orderId',
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.pill), border: Border.all(color: k.brand.withValues(alpha: 0.5))),
                child: Text('₹40', style: KraveoType.headlineSm.copyWith(color: k.brand)),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 0),
              child: PipelineStepper(
                currentStep: step,
                onStepTapped: (s) => widget.onStepChanged(s),
              ),
            ),
            KReveal(
              key: ValueKey('now-$step'),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(KSpace.gutter, 28, KSpace.gutter, 0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('STEP ${step + 1} OF 4', style: KraveoType.label.copyWith(color: k.brand, letterSpacing: 1.2)),
                    const SizedBox(height: 4),
                    Text(headline, style: KraveoType.displayMd.copyWith(color: k.ink)),
                    const SizedBox(height: 4),
                    Row(children: [
                      Icon(step == 0 ? LucideIcons.store : LucideIcons.mapPin, size: 18, color: k.inkMuted),
                      const SizedBox(width: 8),
                      Expanded(child: Text(where, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: k.inkMuted))),
                    ]),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 24, KSpace.gutter, 0),
              child: step < 3
                  ? Semantics(
                      label: slideLabel,
                      button: true,
                      excludeSemantics: true,
                      onTap: _advanceStep,
                      // Key per step so the slider resets after each confirmed step.
                      child: KSlideToConfirm(key: ValueKey('slide-$step'), label: slideLabel, icon: slideIcon, onConfirmed: _advanceStep),
                    )
                  : KButton(label: 'Enter gate OTP', icon: LucideIcons.hash, kind: KButtonKind.accent, large: true, onPressed: _triggerGateOtp),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0),
              child: Row(children: [
                Expanded(child: KButton(label: 'Call', icon: LucideIcons.phone, kind: KButtonKind.tonal, large: true, onPressed: _callCustomer)),
                const SizedBox(width: 12),
                Expanded(child: KButton(label: 'Map', icon: LucideIcons.navigation, kind: KButtonKind.ghost, large: true, onPressed: _openMapRoute)),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 0),
              child: _OrderDetails(
                open: _detailsOpen,
                onToggle: () => setState(() => _detailsOpen = !_detailsOpen),
                restaurant: dhabaName,
                customer: customerName,
                block: hostelGate,
                items: 3,
                amount: 40,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OrderDetails extends StatelessWidget {
  const _OrderDetails({
    required this.open,
    required this.onToggle,
    required this.restaurant,
    required this.customer,
    required this.block,
    required this.items,
    required this.amount,
  });

  final bool open;
  final VoidCallback onToggle;
  final String restaurant, customer, block;
  final int items, amount;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          KPressable(
            semanticLabel: open ? 'Hide order details' : 'Show order details',
            onTap: onToggle,
            scale: 0.99,
            child: Container(
              constraints: const BoxConstraints(minHeight: 64),
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
              color: Colors.transparent,
              child: ExcludeSemantics(
                child: Row(children: [
                  Icon(LucideIcons.receipt, size: 22, color: k.inkMuted),
                  const SizedBox(width: 12),
                  Expanded(child: Text('Order details', style: KraveoType.titleLg.copyWith(color: k.ink))),
                  Text('$items items', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                  const SizedBox(width: 8),
                  Icon(open ? LucideIcons.chevronUp : LucideIcons.chevronDown, size: 22, color: k.inkFaint),
                ]),
              ),
            ),
          ),
          AnimatedSize(
            duration: KMotion.base,
            curve: KMotion.emphasized,
            alignment: Alignment.topCenter,
            child: open
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(18, 0, 18, 18),
                    child: Column(children: [
                      Divider(color: k.line, height: 1),
                      const SizedBox(height: 12),
                      _Line(icon: LucideIcons.store, label: 'Restaurant', value: restaurant),
                      _Line(icon: LucideIcons.user, label: 'Customer', value: customer),
                      _Line(icon: LucideIcons.mapPin, label: 'Drop', value: block),
                      _Line(icon: LucideIcons.package, label: 'Items', value: '$items'),
                      _Line(icon: LucideIcons.wallet, label: 'Your payout', value: '₹$amount'),
                    ]),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.icon, required this.label, required this.value});
  final IconData icon;
  final String label, value;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 18, color: k.inkFaint),
        const SizedBox(width: 10),
        Text(label, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
        const SizedBox(width: 12),
        Expanded(child: Text(value, textAlign: TextAlign.right, style: KraveoType.titleMd.copyWith(color: k.ink))),
      ]),
    );
  }
}
