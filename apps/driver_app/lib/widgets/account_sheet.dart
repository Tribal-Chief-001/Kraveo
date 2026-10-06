import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/partner_session.dart';

/// Account sheet: who is logged in on this phone, the runner pass, and Log out.
Future<void> showAccountSheet(
  BuildContext context, {
  required PartnerSession partner,
  required VoidCallback onOpenPass,
  required VoidCallback onLogout,
  VoidCallback? onOpenPayout,
}) {
  return showKSheet<void>(
    context,
    builder: (sheetContext) {
      final k = sheetContext.k;
      final phone = partner.phone?.trim() ?? '';
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            KAvatar(id: partner.avatarId, size: 64),
            const SizedBox(width: 16),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(partner.name.isEmpty ? 'Runner' : partner.name,
                    maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.headlineSm.copyWith(color: k.ink)),
                if ((partner.runnerCode ?? '').isNotEmpty)
                  Text(partner.runnerCode!, style: KraveoType.titleMd.copyWith(color: k.accent, letterSpacing: 1)),
                if (phone.isNotEmpty) Text(phone, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
              ]),
            ),
          ]),
          const SizedBox(height: 20),
          KButton(
            label: 'Runner ID pass',
            icon: LucideIcons.badgeCheck,
            kind: KButtonKind.tonal,
            large: true,
            onPressed: () {
              Navigator.of(sheetContext).pop();
              onOpenPass();
            },
          ),
          if (onOpenPayout != null) ...[
            const SizedBox(height: 12),
            KButton(
              key: const ValueKey('account-payout-button'),
              label: 'Payout details',
              icon: LucideIcons.landmark,
              kind: KButtonKind.tonal,
              large: true,
              onPressed: () {
                Navigator.of(sheetContext).pop();
                onOpenPayout();
              },
            ),
          ],
          const SizedBox(height: 12),
          KButton(
            key: const ValueKey('account-logout-button'),
            label: 'Log out',
            icon: LucideIcons.logOut,
            kind: KButtonKind.ghost,
            large: true,
            onPressed: () {
              Navigator.of(sheetContext).pop();
              onLogout();
            },
          ),
        ]),
      );
    },
  );
}

/// Confirms before signing out. The safe choice is the dominant button. Resolves to true
/// only when the rider confirms.
Future<bool> showLogoutConfirm(BuildContext context, {bool hasActiveJob = false}) async {
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
            decoration: BoxDecoration(color: KraveoPalette.danger.withValues(alpha: 0.14), shape: BoxShape.circle),
            child: const Icon(LucideIcons.logOut, size: 34, color: KraveoPalette.danger),
          ),
          const SizedBox(height: 16),
          Text('Log out?', textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
          const SizedBox(height: 8),
          Text(
            hasActiveJob
                ? 'You have a delivery in progress. Logging out sets you off duty and you will stop receiving orders.'
                : 'You will go off duty and stop receiving orders until you log in again.',
            textAlign: TextAlign.center,
            style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16),
          ),
          const SizedBox(height: 24),
          KButton(label: 'Stay logged in', large: true, onPressed: () => Navigator.of(ctx).pop(false)),
          const SizedBox(height: 12),
          KButton(
            key: const ValueKey('confirm-logout-button'),
            label: 'Yes, log out',
            large: true,
            kind: KButtonKind.danger,
            onPressed: () => Navigator.of(ctx).pop(true),
          ),
        ]),
      );
    },
  );
  return result ?? false;
}
