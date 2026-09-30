import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'format.dart';

/// Inline form error: animates in under a field and is announced to screen readers.
class KErrorLine extends StatelessWidget {
  const KErrorLine({super.key, required this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    return AnimatedSize(
      duration: KMotion.base,
      curve: KMotion.emphasized,
      alignment: Alignment.topLeft,
      child: message == null
          ? const SizedBox(width: double.infinity)
          : Semantics(
              liveRegion: true,
              child: Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.circleAlert, size: 16, color: kDangerInk)),
                  const SizedBox(width: 8),
                  Expanded(child: Text(message!, style: KraveoType.bodySm.copyWith(color: kDangerInk, fontWeight: FontWeight.w600))),
                ]),
              ),
            ),
    );
  }
}
