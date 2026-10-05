import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';

import '../services/push/push_service.dart';
import 'ui/sheet_chrome.dart';

/// Asks to turn notifications on, once, with a one-line reason. Called when checkout opens,
/// never on the first frame of the app. Does nothing without push support (or when already on).
Future<void> askForNotificationsOnce(BuildContext context) async {
  final push = Provider.of<PushService?>(context, listen: false);
  if (push == null) return;
  try {
    if (!await push.shouldShowRationale()) return;
    await push.markRationaleShown();
    if (!context.mounted) return;
    final yes = await showKConfirm(
      context,
      title: 'Get order updates?',
      message: 'We\'ll tell you when your food is on the way and when your rider is at the gate.',
      confirmLabel: 'Turn on',
      cancelLabel: 'Not now',
    );
    if (yes == true) await push.requestPermission();
  } catch (_) {
    // Never let a notification prompt get in the way of ordering.
  }
}

/// Small non-blocking hint shown on the tracking screen while notifications are switched off.
/// Renders nothing when push is unsupported, not signed in, or notifications are on.
class NotificationsOffHint extends StatelessWidget {
  const NotificationsOffHint({super.key});

  @override
  Widget build(BuildContext context) {
    final push = Provider.of<PushService?>(context);
    if (push == null || !push.blocked) return const SizedBox.shrink();
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.md)),
        child: Row(children: [
          Icon(LucideIcons.bellOff, size: 18, color: k.inkMuted),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              'Notifications are off. You won\'t hear when your rider arrives.',
              style: KraveoType.bodySm.copyWith(color: k.ink, fontWeight: FontWeight.w600),
            ),
          ),
          TextButton(onPressed: push.enableNotifications, child: const Text('Turn on')),
        ]),
      ),
    );
  }
}
