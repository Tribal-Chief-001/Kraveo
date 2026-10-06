import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../../services/support_contact.dart';

/// "kraveo.contact@gmail.com" with a mail icon. One tap opens the phone's mail app (or copies the address).
class SupportEmailLink extends StatelessWidget {
  const SupportEmailLink({super.key});

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      button: true,
      label: 'Email Kraveo support at $kSupportEmail',
      excludeSemantics: true,
      onTap: () => SupportContact.openEmail(context),
      child: KPressable(
        onTap: () => SupportContact.openEmail(context),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(LucideIcons.mail, size: 20, color: k.brand),
            const SizedBox(width: 8),
            Flexible(child: Text(kSupportEmail, style: KraveoType.titleMd.copyWith(color: k.brand, fontSize: 16, decoration: TextDecoration.underline))),
          ]),
        ),
      ),
    );
  }
}
