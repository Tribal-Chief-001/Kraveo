import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../services/external_links.dart';
import 'snack.dart';

/// Opens the mail app for a message to Kraveo support; when no mail app can be opened the address
/// is copied instead (and the student is told).
Future<void> emailSupport(BuildContext context, {String? subject}) async {
  final opened = await ExternalLinks.emailSupport(subject: subject);
  if (opened || !context.mounted) return;
  await Clipboard.setData(const ClipboardData(text: kSupportEmail));
  if (!context.mounted) return;
  showKSnack(context, 'No email app found. $kSupportEmail is copied: paste it into your email.', icon: LucideIcons.copy);
}

/// Opens the dialer for [phone]; when that is not possible the number is copied and the student is told.
Future<void> callNumber(BuildContext context, {required String name, required String phone}) async {
  final opened = await ExternalLinks.dial(phone);
  if (opened || !context.mounted) return;
  await Clipboard.setData(ClipboardData(text: phone));
  if (!context.mounted) return;
  showKSnack(context, 'Couldn’t open the dialer. $name’s number ($phone) is copied: paste it in your phone app.', icon: LucideIcons.phone);
}

/// A snackbar action that writes to support, for messages that mention [kSupportEmail].
SnackBarAction supportSnackAction(BuildContext context) => SnackBarAction(label: 'Email', onPressed: () => emailSupport(context));

/// "Need help? kraveo.contact@gmail.com": a tappable line that opens the mail app (copying the
/// address when there is none).
class SupportEmailLine extends StatelessWidget {
  const SupportEmailLine({super.key, this.prefix = 'Need help?', this.subject});

  final String prefix;
  final String? subject;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KPressable(
      semanticLabel: 'Email Kraveo support at $kSupportEmail',
      onTap: () => emailSupport(context, subject: subject),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(LucideIcons.mail, size: 16, color: k.brand),
          const SizedBox(width: 8),
          Flexible(
            child: Text.rich(
              TextSpan(children: [
                TextSpan(text: '$prefix ', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                TextSpan(text: kSupportEmail, style: KraveoType.bodySm.copyWith(color: k.brand, fontWeight: FontWeight.w700, decoration: TextDecoration.underline)),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}
