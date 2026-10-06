import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/payout/payout_controller.dart';

/// Keys for tests.
const Key kPayoutBannerKey = ValueKey('payout-banner');
const Key kPayoutBannerActionKey = ValueKey('payout-banner-action');
const Key kPayoutBannerDismissKey = ValueKey('payout-banner-dismiss');

/// "Add payout details to get paid": shown on the Earnings tab while Kraveo has no payout details for this restaurant.
/// The owner can close it; it stays closed until the app is started or the owner logs in again.
class PayoutBanner extends StatelessWidget {
  const PayoutBanner({super.key, required this.controller, required this.onAdd});

  final PayoutController controller;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        if (!controller.showBanner) return const SizedBox.shrink();
        final k = context.k;
        return Padding(
          padding: const EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, 4),
          child: KCard(
            key: kPayoutBannerKey,
            elevated: false,
            color: KraveoPalette.warning.withValues(alpha: 0.12),
            borderColor: KraveoPalette.warning.withValues(alpha: 0.6),
            padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(LucideIcons.wallet, size: 24, color: k.ink),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                    Text('Add payout details to get paid', style: KraveoType.bodySm.copyWith(color: k.ink, fontWeight: FontWeight.w800, fontSize: 15)),
                    Text('पैसे पाने के लिए पेआउट की जानकारी डालें', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
                  ]),
                ),
                Semantics(
                  button: true,
                  label: 'Close this reminder',
                  excludeSemantics: true,
                  onTap: controller.dismissBanner,
                  child: KPressable(
                    key: kPayoutBannerDismissKey,
                    onTap: controller.dismissBanner,
                    child: SizedBox(width: 48, height: 48, child: Icon(LucideIcons.x, size: 22, color: k.inkMuted)),
                  ),
                ),
              ]),
              Padding(
                padding: const EdgeInsets.only(right: 8, top: 4),
                child: KButton(key: kPayoutBannerActionKey, label: 'Add payout details', sublabel: 'जानकारी डालें', onPressed: onAdd),
              ),
            ]),
          ),
        );
      },
    );
  }
}
