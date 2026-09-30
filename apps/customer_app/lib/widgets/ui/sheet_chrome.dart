// ignore_for_file: sort_child_properties_last
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'k_icon_button.dart';

/// Shared structure for every bottom sheet: header (title + close), scrollable body, pinned footer.
/// Handles the keyboard inset and caps height so the sheet never covers the whole screen.
class KSheetFrame extends StatelessWidget {
  const KSheetFrame({
    super.key,
    required this.title,
    this.subtitle,
    this.children = const [],
    this.footer,
    this.padding = const EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, 20),
    this.onClose,
  });

  final String title;
  final Widget? subtitle;
  final List<Widget> children;
  final Widget? footer;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final mq = MediaQuery.of(context);
    return Padding(
      padding: EdgeInsets.only(bottom: mq.viewInsets.bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: mq.size.height * 0.88),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 8, 12, 12),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.headlineSm.copyWith(color: k.ink)),
                    if (subtitle != null) ...[const SizedBox(height: 4), subtitle!],
                  ]),
                ),
              ),
              const SizedBox(width: 8),
              KIconButton(
                icon: LucideIcons.x,
                semanticLabel: 'Close',
                background: k.surfaceAlt,
                bordered: false,
                onTap: onClose ?? () => Navigator.of(context).maybePop(),
              ),
            ]),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              padding: padding,
              children: children,
            ),
          ),
          if (footer != null) KSheetFooter(child: footer!),
        ]),
      ),
    );
  }
}

/// Pinned action area at the bottom of a sheet / screen.
class KSheetFooter extends StatelessWidget {
  const KSheetFooter({super.key, required this.child, this.floating = false});

  final Widget child;
  final bool floating;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final bottom = MediaQuery.paddingOf(context).bottom;
    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(KSpace.gutter, 14, KSpace.gutter, 14 + (bottom > 0 ? bottom : 4)),
      decoration: BoxDecoration(
        color: k.surface,
        border: Border(top: BorderSide(color: k.line.withValues(alpha: 0.7))),
        boxShadow: floating ? KShadow.lift(k.shadowTint) : null,
      ),
      child: child,
    );
  }
}

/// Small centred confirmation sheet. Returns true when the primary action is chosen.
Future<bool?> showKConfirm(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  String cancelLabel = 'Cancel',
  bool danger = false,
}) {
  return showKSheet<bool>(
    context,
    builder: (ctx) => KSheetFrame(
      title: title,
      children: [Text(message, style: KraveoType.body.copyWith(color: ctx.k.inkMuted))],
      footer: Row(children: [
        Expanded(child: KButton(label: cancelLabel, kind: KButtonKind.ghost, onPressed: () => Navigator.of(ctx).pop(false))),
        const SizedBox(width: 12),
        Expanded(child: KButton(label: confirmLabel, kind: danger ? KButtonKind.danger : KButtonKind.primary, onPressed: () => Navigator.of(ctx).pop(true))),
      ]),
    ),
  );
}
