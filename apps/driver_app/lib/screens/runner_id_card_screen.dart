import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../widgets/ui/icon_action.dart';

/// The rider's staff pass, shown to hostel-gate security. It carries only what Kraveo really knows: the
/// rider's name and runner code. There is no scannable code and no "verified" badge: the guard reads the
/// code (RUN-xxxx) and checks it with Kraveo.
class RunnerIdCardScreen extends StatelessWidget {
  final String name;

  /// The rider's runner code, e.g. "RUN-8042". "-" when Kraveo has not given one.
  final String runnerId;

  /// Optional profile photo. Falls back to initials when null or when it fails to load.
  final String? photoUrl;

  const RunnerIdCardScreen({
    super.key,
    required this.name,
    required this.runnerId,
    this.photoUrl,
  });

  bool get _hasCode => runnerId.trim().isNotEmpty && runnerId.trim() != '-';

  String get _initials {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return 'R';
    if (parts.length == 1) return parts.first[0].toUpperCase();
    return (parts.first[0] + parts.last[0]).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 32),
          children: [
            Row(children: [
              KIconButton(icon: LucideIcons.arrowLeft, semanticLabel: 'Back', onTap: () => Navigator.of(context).maybePop()),
              const SizedBox(width: 14),
              Expanded(child: Text('Runner pass', style: KraveoType.headline.copyWith(color: k.ink))),
            ]),
            const SizedBox(height: 20),
            KReveal(
              child: Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(KRadius.xxl),
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [k.brandSoft, k.surface, k.bg],
                    stops: const [0, 0.55, 1],
                  ),
                  border: Border.all(color: k.brand.withValues(alpha: 0.6), width: 1.5),
                  boxShadow: KShadow.glow(k.brand).map((s) => s.copyWith(color: s.color.withValues(alpha: 0.18))).toList(),
                ),
                child: Column(
                  children: [
                    // Lanyard slot
                    Container(
                      margin: const EdgeInsets.only(top: 14),
                      width: 64,
                      height: 8,
                      decoration: BoxDecoration(color: k.bg, borderRadius: BorderRadius.circular(4), border: Border.all(color: k.line)),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(22, 16, 22, 0),
                      child: Row(children: [
                        const KBrandMark(height: 34),
                        const Spacer(),
                        Text('DELIVERY PARTNER', style: KraveoType.label.copyWith(color: k.inkMuted, letterSpacing: 1.4, fontSize: 11)),
                      ]),
                    ),
                    const SizedBox(height: 22),
                    _Avatar(initials: _initials, photoUrl: photoUrl),
                    const SizedBox(height: 16),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 22),
                      child: Text(name, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.displayMd.copyWith(color: k.ink)),
                    ),
                    const SizedBox(height: 22),
                    Text('RUNNER ID', style: KraveoType.label.copyWith(color: k.inkFaint, letterSpacing: 1.6)),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(runnerId, style: KraveoType.displayLg.copyWith(color: k.accent, fontSize: 46, letterSpacing: 2)),
                    ),
                    Container(
                      key: const ValueKey('pass-guard-note'),
                      margin: const EdgeInsets.fromLTRB(22, 18, 22, 22),
                      padding: const EdgeInsets.all(16),
                      width: double.infinity,
                      decoration: BoxDecoration(color: k.surface, borderRadius: BorderRadius.circular(KRadius.xl), border: Border.all(color: k.line)),
                      child: Text(
                        _hasCode ? 'Show this pass; the guard checks the code $runnerId' : 'Show this pass to the guard.',
                        textAlign: TextAlign.center,
                        style: KraveoType.titleMd.copyWith(color: k.ink),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.initials, required this.photoUrl});
  final String initials;
  final String? photoUrl;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final fallback = Center(child: Text(initials, style: KraveoType.displayMd.copyWith(color: k.ink, fontSize: 40)));
    return Container(
      width: 124,
      height: 124,
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: SweepGradient(colors: [k.brand, k.accent, k.brand]),
      ),
      child: Container(
        decoration: BoxDecoration(shape: BoxShape.circle, color: k.surfaceAlt, border: Border.all(color: k.bg, width: 4)),
        clipBehavior: Clip.antiAlias,
        child: photoUrl == null
            ? fallback
            : Image.network(photoUrl!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => fallback),
      ),
    );
  }
}
