import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

/// Where a restaurant asks Kraveo for help. Email only: there is no helpline number yet.
const String kSupportEmail = 'kraveo.contact@gmail.com';

/// Opens a link outside the app. True when something opened.
typedef MailOpener = Future<bool> Function(Uri uri);

Future<bool> _launchMail(Uri uri) async {
  try {
    return await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    return false;
  }
}

/// The "Email Kraveo support" action. Replaced in tests.
class SupportContact {
  @visibleForTesting
  static MailOpener opener = _launchMail;

  static Uri mailtoUri([String subject = 'Kraveo restaurant partner help']) => Uri.parse('mailto:$kSupportEmail?subject=${Uri.encodeComponent(subject)}');

  /// Opens the phone's mail app with a new message to Kraveo support. When there is no mail app, the address is
  /// copied instead and the owner is told so.
  static Future<void> openEmail(BuildContext context) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    var opened = false;
    try {
      opened = await opener(mailtoUri());
    } catch (_) {}
    if (opened) return;
    try {
      await Clipboard.setData(const ClipboardData(text: kSupportEmail));
    } catch (_) {}
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(
        content: Text('No email app found. Address copied: $kSupportEmail  ·  ईमेल पता कॉपी हो गया'),
        duration: Duration(seconds: 5),
      ));
  }
}
