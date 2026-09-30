import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Big, forgiving confirmation. For a destructive action the SAFE choice is the dominant
/// green button on top and the risky red one sits below it; for a normal forward step the
/// confirm button is the dominant one. Resolves to `true` only when the action is confirmed.
Future<bool> showConfirmSheet(
  BuildContext context, {
  required IconData icon,
  required String title,
  required String hindiTitle,
  String? message,
  required String safeLabel,
  required String safeSublabel,
  required String confirmLabel,
  required String confirmSublabel,
  bool destructive = true,
}) async {
  final result = await showKSheet<bool>(
    context,
    builder: (ctx) {
      final k = ctx.k;
      final accent = destructive ? KraveoPalette.danger : k.brand;
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 76,
            height: 76,
            decoration: BoxDecoration(color: accent.withValues(alpha: 0.12), shape: BoxShape.circle),
            child: Icon(icon, size: 36, color: destructive ? Color.alphaBlend(Colors.black.withValues(alpha: 0.2), accent) : accent),
          ),
          const SizedBox(height: 16),
          Text(title, textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
          const SizedBox(height: 4),
          Text(hindiTitle, textAlign: TextAlign.center, style: KraveoType.titleLg.copyWith(color: k.inkMuted)),
          if (message != null) ...[
            const SizedBox(height: 10),
            Text(message, textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
          ],
          const SizedBox(height: 24),
          if (destructive) ...[
            KButton(label: safeLabel, sublabel: safeSublabel, large: true, onPressed: () => Navigator.of(ctx).pop(false)),
            const SizedBox(height: 12),
            KButton(label: confirmLabel, sublabel: confirmSublabel, large: true, kind: KButtonKind.danger, onPressed: () => Navigator.of(ctx).pop(true)),
          ] else ...[
            KButton(label: confirmLabel, sublabel: confirmSublabel, large: true, onPressed: () => Navigator.of(ctx).pop(true)),
            const SizedBox(height: 12),
            KButton(label: safeLabel, sublabel: safeSublabel, large: true, kind: KButtonKind.ghost, onPressed: () => Navigator.of(ctx).pop(false)),
          ],
        ]),
      );
    },
  );
  return result ?? false;
}
