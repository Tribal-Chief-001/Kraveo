import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../config/support_config.dart';

/// Shows a phone number big and clear with a "Copy number" button. The app has no dialer plugin,
/// so it never pretends to place a call: the rider copies the number into the phone app.
Future<void> showNumberSheet(BuildContext context, {required String title, required String number, String? note}) {
  return showKSheet<void>(
    context,
    builder: (ctx) {
      final k = ctx.k;
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(title, textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
          if (note != null) ...[
            const SizedBox(height: 8),
            Text(note, textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted)),
          ],
          const SizedBox(height: 16),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: SelectableText(number, style: KraveoType.displayMd.copyWith(color: k.ink, letterSpacing: 0.6)),
          ),
          const SizedBox(height: 20),
          KButton(
            label: 'Copy number',
            icon: LucideIcons.copy,
            large: true,
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: number));
              if (ctx.mounted) {
                Navigator.of(ctx).pop();
                ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                  const SnackBar(content: Text('Number copied. Paste it in your phone app to call.'), duration: Duration(seconds: 3)),
                );
              }
            },
          ),
          const SizedBox(height: 10),
          KButton(label: 'Close', kind: KButtonKind.ghost, large: true, onPressed: () => Navigator.of(ctx).pop()),
        ]),
      );
    },
  );
}

Future<void> showSupportSheet(BuildContext context, {String? note}) =>
    showNumberSheet(context, title: 'Kraveo support', number: SupportConfig.phone, note: note);
