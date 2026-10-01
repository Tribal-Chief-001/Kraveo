import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'vendor_ui.dart';

/// A form field with an English + Hindi caption above it and an inline error below.
class FieldBlock extends StatelessWidget {
  const FieldBlock({super.key, required this.label, required this.hindi, required this.child, this.error, this.hint});

  final String label;
  final String hindi;
  final Widget child;
  final String? error;

  /// Optional grey help line under the field, e.g. "At least 8 characters".
  final String? hint;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text.rich(
        TextSpan(children: [
          TextSpan(text: label, style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13)),
          TextSpan(text: '   $hindi', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13, letterSpacing: 0)),
        ]),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      const SizedBox(height: 8),
      child,
      if (hint != null && error == null)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(hint!, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
        ),
      AnimatedSize(
        duration: KMotion.base,
        curve: KMotion.emphasized,
        alignment: Alignment.topLeft,
        child: error == null
            ? const SizedBox(width: double.infinity)
            : Semantics(
                liveRegion: true,
                child: Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.circleAlert, size: 18, color: kDangerDeep)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(error!, style: KraveoType.bodySm.copyWith(color: kDangerDeep, fontSize: 15, fontWeight: FontWeight.w700))),
                  ]),
                ),
              ),
      ),
    ]);
  }
}

/// Red error border used by the text fields in the account forms.
OutlineInputBorder fieldErrorBorder() => OutlineInputBorder(
      borderRadius: KRadius.control,
      borderSide: BorderSide(color: kDangerDeep, width: 1.8),
    );
