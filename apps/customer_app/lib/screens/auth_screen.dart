import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../providers/session_provider.dart';
import '../widgets/ui/display_text.dart';
import '../widgets/ui/error_line.dart';
import '../widgets/ui/google_button.dart';

/// Welcome / login: brand hero and one big "Continue with Google" button.
/// Everything after the tap (token exchange, routing to sign-up or Home) is owned by
/// [SessionProvider] and `AuthGate`; this screen only shows progress and errors.
class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  String? _error;

  Future<void> _continueWithGoogle() async {
    final session = context.read<SessionProvider>();
    if (session.isSigningIn) return;
    setState(() => _error = null);
    final outcome = await session.signInWithGoogle();
    if (!mounted || outcome.success) return; // success: AuthGate swaps this screen out
    // Cancelling the Google picker is a choice, not an error: stay quiet.
    setState(() => _error = outcome.error);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final busy = context.select<SessionProvider, bool>((s) => s.isSigningIn);
    return Scaffold(
      backgroundColor: k.bg,
      body: Stack(children: [
        // Soft brand-tinted shapes give the screen depth without adding noise.
        Positioned(
          top: -90,
          right: -70,
          child: Container(width: 260, height: 260, decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle)),
        ),
        Positioned(
          top: 120,
          right: -120,
          child: Container(width: 200, height: 200, decoration: BoxDecoration(color: KraveoPalette.g100.withValues(alpha: 0.55), shape: BoxShape.circle)),
        ),
        SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(children: [
                Expanded(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 16),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      const KReveal(child: Align(alignment: Alignment.centerLeft, child: KBrandMark(height: 52))),
                      const SizedBox(height: 32),
                      KReveal(index: 1, child: KDisplayText('Late-night\ncravings, sorted.', style: KraveoType.displayMd.copyWith(color: k.ink))),
                      const SizedBox(height: 12),
                      KReveal(index: 2, child: Text('Hot dhaba food, at your hostel gate.', style: KraveoType.body.copyWith(color: k.inkMuted))),
                      const SizedBox(height: 28),
                      const KReveal(index: 3, child: _Perk(icon: LucideIcons.utensils, title: 'Dhaba food near campus', body: 'Your favourite kitchens, one place.')),
                      const SizedBox(height: 12),
                      const KReveal(index: 4, child: _Perk(icon: LucideIcons.mapPin, title: 'Delivered to your gate', body: 'Pick your block, meet the runner there.')),
                      const SizedBox(height: 12),
                      const KReveal(index: 5, child: _Perk(icon: LucideIcons.bike, title: 'Live order tracking', body: 'Watch it arrive, share the OTP at the gate.')),
                    ]),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(KSpace.gutter, 8, KSpace.gutter, 20),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    GoogleContinueButton(onPressed: _continueWithGoogle, loading: busy),
                    KErrorLine(message: _error),
                    const SizedBox(height: 14),
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Padding(padding: const EdgeInsets.only(top: 1), child: Icon(LucideIcons.shieldCheck, size: 16, color: k.brand)),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'We use your Google name and email only to set up your Kraveo account. No password, and we never post anything.',
                          style: KraveoType.bodySm.copyWith(color: k.inkMuted),
                        ),
                      ),
                    ]),
                  ]),
                ),
              ]),
            ),
          ),
        ),
      ]),
    );
  }
}

class _Perk extends StatelessWidget {
  const _Perk({required this.icon, required this.title, required this.body});

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.sm)),
        child: Icon(icon, size: 21, color: k.brand),
      ),
      const SizedBox(width: 14),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: KraveoType.titleMd.copyWith(color: k.ink)),
          const SizedBox(height: 2),
          Text(body, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
        ]),
      ),
    ]);
  }
}
