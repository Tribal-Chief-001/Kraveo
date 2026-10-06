import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../config/support_config.dart';
import '../services/navigation.dart';

/// Opens `tel:` / `mailto:` links. Tests replace it with a fake; it is the real
/// `url_launcher` otherwise.
NavigationLauncher contactLauncher = const UrlNavigationLauncher();

/// `tel:` link for [number] (digits, spaces and a leading + are kept; anything else is dropped).
Uri telUri(String number) => Uri(scheme: 'tel', path: number.replaceAll(RegExp(r'[^0-9+]'), ''));

/// `mailto:` link to Kraveo support. The subject is encoded by hand because `Uri(queryParameters:)`
/// writes spaces as `+`, which mail apps show literally.
Uri supportMailUri({String subject = 'Kraveo rider support'}) =>
    Uri.parse('mailto:${SupportConfig.email}?subject=${Uri.encodeComponent(subject)}');

/// Dials [number] in the phone app. When no dialer can open, the number is copied and the rider is told.
Future<void> callNumber(BuildContext context, {required String number}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final opened = await contactLauncher.open(telUri(number));
  if (opened) return;
  await Clipboard.setData(ClipboardData(text: number));
  messenger
    ?..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text('Could not open the phone app. Number copied: $number'), duration: const Duration(seconds: 4)));
}

/// Opens a new email to Kraveo support. When no email app can open, the address is copied.
Future<void> emailSupport(BuildContext context, {String subject = 'Kraveo rider support'}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final opened = await contactLauncher.open(supportMailUri(subject: subject));
  if (opened) return;
  await Clipboard.setData(const ClipboardData(text: SupportConfig.email));
  messenger
    ?..hideCurrentSnackBar()
    ..showSnackBar(const SnackBar(content: Text('No email app found. Address copied: ${SupportConfig.email}'), duration: Duration(seconds: 4)));
}

/// "Email Kraveo support" sheet, with a separate, clearly labelled "Emergency: call 112" action for a
/// real emergency (Kraveo support is email only and is not an emergency service).
Future<void> showSupportSheet(BuildContext context, {String? note, String? subject}) {
  return showKSheet<void>(
    context,
    builder: (ctx) {
      final k = ctx.k;
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Kraveo support', textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
          if (note != null) ...[
            const SizedBox(height: 8),
            Text(note, textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted)),
          ],
          const SizedBox(height: 16),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: SelectableText(SupportConfig.email, style: KraveoType.titleLg.copyWith(color: k.ink)),
          ),
          const SizedBox(height: 6),
          Text('Kraveo support answers by email.', textAlign: TextAlign.center, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          const SizedBox(height: 18),
          KButton(
            key: const ValueKey('email-support-button'),
            label: 'Email Kraveo support',
            icon: LucideIcons.mail,
            large: true,
            onPressed: () async {
              Navigator.of(ctx).pop();
              await emailSupport(context, subject: subject ?? 'Kraveo rider support');
            },
          ),
          const SizedBox(height: 12),
          Divider(color: k.line, height: 1),
          const SizedBox(height: 12),
          Text('In a real emergency, do not wait for an email.', textAlign: TextAlign.center, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
          const SizedBox(height: 8),
          KButton(
            key: const ValueKey('emergency-112-button'),
            label: 'Emergency: call ${SupportConfig.emergencyNumber}',
            icon: LucideIcons.siren,
            kind: KButtonKind.danger,
            large: true,
            onPressed: () async {
              Navigator.of(ctx).pop();
              await callNumber(context, number: SupportConfig.emergencyNumber);
            },
          ),
          const SizedBox(height: 10),
          KButton(label: 'Close', kind: KButtonKind.ghost, large: true, onPressed: () => Navigator.of(ctx).pop()),
        ]),
      );
    },
  );
}
