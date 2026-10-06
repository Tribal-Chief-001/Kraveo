import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../services/external_links.dart';
import 'support_contact.dart';

/// Branded floating snackbar. Errors turn danger-red and use an alert icon.
SnackBar buildKSnack(String message, {bool error = false, IconData? icon, SnackBarAction? action, Duration? duration}) {
  return SnackBar(
    backgroundColor: error ? KraveoPalette.danger : null,
    duration: duration ?? const Duration(seconds: 3),
    action: action,
    content: Row(children: [
      Icon(icon ?? (error ? LucideIcons.circleAlert : LucideIcons.circleCheck), size: 20, color: Colors.white),
      const SizedBox(width: 10),
      Expanded(child: Text(message)),
    ]),
  );
}

void showKSnack(BuildContext context, String message, {bool error = false, IconData? icon, SnackBarAction? action, Duration? duration}) {
  // A message that tells the student to write to support gets an "Email" button and stays longer.
  final mentionsSupport = message.contains(kSupportEmail);
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(buildKSnack(
      message,
      error: error,
      icon: icon,
      action: action ?? (mentionsSupport ? supportSnackAction(context) : null),
      duration: duration ?? (mentionsSupport ? const Duration(seconds: 7) : null),
    ));
}
