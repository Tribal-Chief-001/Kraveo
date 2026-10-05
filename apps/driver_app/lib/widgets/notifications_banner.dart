import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Persistent warning shown while notifications are blocked: without them a locked phone never hears a new delivery.
class NotificationsBlockedBanner extends StatelessWidget {
  const NotificationsBlockedBanner({super.key, required this.opensSettings, required this.onFix});

  /// True when the system will not ask again and only the phone settings can turn notifications on.
  final bool opensSettings;
  final VoidCallback onFix;

  static const String message = 'Turn on notifications or you will miss deliveries';

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      borderColor: KraveoPalette.danger,
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          const Icon(LucideIcons.bellOff, size: 22, color: KraveoPalette.danger),
          const SizedBox(width: 10),
          Expanded(child: Text(message, style: KraveoType.titleMd.copyWith(color: k.ink))),
        ]),
        const SizedBox(height: 12),
        KButton(
          key: const ValueKey('push-fix-button'),
          label: opensSettings ? 'Open settings' : 'Turn on',
          icon: opensSettings ? LucideIcons.settings : LucideIcons.bell,
          kind: KButtonKind.tonal,
          onPressed: onFix,
        ),
      ]),
    );
  }
}

/// Explain-then-ask: shown once, right after an approved rider signs in, before the system permission prompt.
/// Resolves to true when the rider agrees to be asked.
Future<bool> showNotificationsExplainSheet(BuildContext context) async {
  final result = await showKSheet<bool>(
    context,
    builder: (ctx) {
      final k = ctx.k;
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
            child: Icon(LucideIcons.bellRing, size: 34, color: k.brand),
          ),
          const SizedBox(height: 16),
          Text('Get new-delivery alerts', textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
          const SizedBox(height: 8),
          Text(
            'Kraveo plays a sound and shows a notification when a delivery is waiting, even when your phone is locked. '
            'Without it you can miss orders.',
            textAlign: TextAlign.center,
            style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16),
          ),
          const SizedBox(height: 24),
          KButton(
            key: const ValueKey('push-explain-allow'),
            label: 'Turn on notifications',
            icon: LucideIcons.bell,
            large: true,
            onPressed: () => Navigator.of(ctx).pop(true),
          ),
          const SizedBox(height: 12),
          KButton(
            key: const ValueKey('push-explain-skip'),
            label: 'Not now',
            kind: KButtonKind.ghost,
            large: true,
            onPressed: () => Navigator.of(ctx).pop(false),
          ),
        ]),
      );
    },
  );
  return result ?? false;
}
