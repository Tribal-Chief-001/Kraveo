import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/push/push_controller.dart';
import 'ui/ui.dart';

/// Keys for tests.
const Key kNotificationBannerKey = ValueKey('push-notification-banner');
const Key kNotificationActionKey = ValueKey('push-notification-action');
const Key kBatteryCardKey = ValueKey('push-battery-card');
const Key kBatteryAllowKey = ValueKey('push-battery-allow');
const Key kBatteryDismissKey = ValueKey('push-battery-dismiss');

/// Persistent notices under the store switch, ONE at a time and compact, so the order list keeps its room:
/// 1. notifications are off (with a button to fix it), because a missed order is the costliest problem;
/// 2. else [locationNotice]: the restaurant has no map location yet, so riders cannot find it;
/// 3. else the one-time "allow unrestricted battery" hint.
/// Shows nothing when push is fine or not wired and there is no location notice.
class PushStatusCards extends StatelessWidget {
  const PushStatusCards({super.key, required this.push, this.locationNotice});

  final PushController push;

  /// The location banner when the restaurant has no pin (null otherwise). Waits for the notification banner.
  final Widget? locationNotice;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: push,
      builder: (context, _) {
        final banner = push.banner;
        final Widget card;
        if (banner != PushBanner.none) {
          card = _NotificationBanner(key: kNotificationBannerKey, push: push, blocked: banner == PushBanner.blocked);
        } else if (locationNotice != null) {
          card = locationNotice!;
        } else if (push.showBatteryCard) {
          card = _BatteryCard(key: kBatteryCardKey, push: push);
        } else {
          return const SizedBox.shrink();
        }
        return NoticeFrame(child: card);
      },
    );
  }
}

/// Spacing + size cap shared by every notice under the store switch.
class NoticeFrame extends StatelessWidget {
  const NoticeFrame({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, 0),
      child: VMaxWidth(
        // Never more than a third of the screen: scrolls inside itself on a very small phone.
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.34),
          child: SingleChildScrollView(child: child),
        ),
      ),
    );
  }
}

class _NotificationBanner extends StatelessWidget {
  const _NotificationBanner({super.key, required this.push, required this.blocked});

  final PushController push;
  final bool blocked;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      elevated: false,
      color: KraveoPalette.danger.withValues(alpha: 0.10),
      borderColor: KraveoPalette.danger.withValues(alpha: 0.45),
      padding: const EdgeInsets.all(10),
      child: LayoutBuilder(builder: (context, box) {
        // Phone width: text first, full-width button under it. Wider (tablet): one row.
        final stacked = box.maxWidth < 520;
        final message = Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(LucideIcons.bellOff, size: 24, color: kDangerDeep),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(
                blocked ? 'Turn on notifications or you will miss orders' : 'Allow notifications to hear new orders',
                style: KraveoType.bodySm.copyWith(color: k.ink, fontWeight: FontWeight.w800, fontSize: 15),
              ),
              Text(
                blocked ? 'नोटिफिकेशन चालू करें, वरना ऑर्डर छूट जाएंगे' : 'नए ऑर्डर सुनने के लिए नोटिफिकेशन चालू करें',
                style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13),
              ),
            ]),
          ),
        ]);
        final button = KButton(
          key: kNotificationActionKey,
          label: blocked ? 'Open settings' : 'Allow',
          sublabel: blocked ? 'सेटिंग खोलें' : null,
          expand: stacked,
          onPressed: blocked ? push.openNotificationSettings : push.requestNotifications,
        );
        if (!stacked) {
          return Row(children: [Expanded(child: message), const SizedBox(width: 12), button]);
        }
        return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [message, const SizedBox(height: 8), button]);
      }),
    );
  }
}

class _BatteryCard extends StatelessWidget {
  const _BatteryCard({super.key, required this.push});

  final PushController push;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      elevated: false,
      color: k.brandSoft,
      padding: const EdgeInsets.all(10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(LucideIcons.batteryCharging, size: 24, color: k.brand),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Allow unrestricted battery so orders are never missed',
                  style: KraveoType.bodySm.copyWith(color: k.ink, fontWeight: FontWeight.w800, fontSize: 15)),
              const SizedBox(height: 2),
              Text(
                'Some phones pause apps to save battery and delay alerts. If the app is force-closed, Android cannot deliver orders until you open it again.',
                style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13),
              ),
            ]),
          ),
        ]),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(child: KButton(key: kBatteryAllowKey, label: 'Allow', sublabel: 'अनुमति दें', onPressed: push.requestBatteryUnrestricted)),
          const SizedBox(width: 8),
          Expanded(
              child: KButton(
                  key: kBatteryDismissKey, label: 'Not now', sublabel: 'अभी नहीं', kind: KButtonKind.ghost, onPressed: push.dismissBatteryCard)),
        ]),
      ]),
    );
  }
}
