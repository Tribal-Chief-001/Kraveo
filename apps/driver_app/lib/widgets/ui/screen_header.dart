import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Big, calm screen title used by every driver tab (replaces the bland AppBar).
class ScreenHeader extends StatelessWidget {
  const ScreenHeader({super.key, required this.title, this.subtitle, this.trailing, this.leading});

  final String title;
  final String? subtitle;
  final Widget? trailing;
  final Widget? leading;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 8),
      child: Row(
        children: [
          if (leading != null) ...[leading!, const SizedBox(width: 12)],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.displayMd.copyWith(color: k.ink)),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(subtitle!, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: k.inkMuted)),
                ],
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 12), trailing!],
        ],
      ),
    );
  }
}

/// Small caps label above a block of content.
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key, this.padding = const EdgeInsets.fromLTRB(KSpace.gutter, 24, KSpace.gutter, 10), this.trailing});

  final String text;
  final EdgeInsetsGeometry padding;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: padding,
      child: Row(
        children: [
          Expanded(
            child: Text(text.toUpperCase(),
                maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.inkFaint, letterSpacing: 1.2)),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}
