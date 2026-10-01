import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// A form field with a small caption above it, an optional help line and an inline error below.
class FieldBlock extends StatelessWidget {
  const FieldBlock({super.key, required this.label, required this.child, this.error, this.hint});

  final String label;
  final Widget child;
  final String? error;

  /// Optional grey help line under the field, e.g. "At least 8 characters".
  final String? hint;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13)),
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
                    const Padding(padding: EdgeInsets.only(top: 2), child: Icon(LucideIcons.circleAlert, size: 18, color: KraveoPalette.danger)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(error!, style: KraveoType.bodySm.copyWith(color: KraveoPalette.danger, fontSize: 15, fontWeight: FontWeight.w700))),
                  ]),
                ),
              ),
      ),
    ]);
  }
}

/// Red error border used by the text fields in the account forms.
const OutlineInputBorder fieldErrorBorder = OutlineInputBorder(
  borderRadius: BorderRadius.all(Radius.circular(KRadius.lg)),
  borderSide: BorderSide(color: KraveoPalette.danger, width: 1.8),
);
