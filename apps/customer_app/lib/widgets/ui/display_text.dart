import 'package:flutter/material.dart';

/// Big display headline that respects the user's text size up to 1.1x only,
/// so hero copy never pushes primary actions off small screens.
class KDisplayText extends StatelessWidget {
  const KDisplayText(this.text, {super.key, required this.style, this.maxLines, this.overflow});

  final String text;
  final TextStyle style;
  final int? maxLines;
  final TextOverflow? overflow;

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    return MediaQuery(
      data: mq.copyWith(textScaler: mq.textScaler.clamp(maxScaleFactor: 1.1)),
      child: Text(text, style: style, maxLines: maxLines, overflow: overflow),
    );
  }
}
