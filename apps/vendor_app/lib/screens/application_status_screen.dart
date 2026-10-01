import 'dart:async';
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/partner_session.dart';

/// What a restaurant sees after creating an account until Kraveo approves it, or when the application was
/// rejected or the account suspended. Pending applications are re-checked every [pollEvery] and when the
/// app comes back to the foreground, so approval shows up without the owner doing anything.
class ApplicationStatusScreen extends StatefulWidget {
  const ApplicationStatusScreen({
    super.key,
    required this.session,
    required this.onRefresh,
    required this.onEdit,
    required this.onLogout,
    this.pollEvery = const Duration(seconds: 20),
  });

  final PartnerSession session;

  /// Re-checks the application with Kraveo; resolves to true when something changed.
  final Future<bool> Function() onRefresh;
  final VoidCallback onEdit;
  final Future<void> Function() onLogout;
  final Duration pollEvery;

  @override
  State<ApplicationStatusScreen> createState() => _ApplicationStatusScreenState();
}

class _ApplicationStatusScreenState extends State<ApplicationStatusScreen> with WidgetsBindingObserver {
  Timer? _timer;
  bool _checking = false;
  bool _loggingOut = false;
  bool _checkedOnce = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _timer = Timer.periodic(widget.pollEvery, (_) => _check(silent: true));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _check(silent: true);
  }

  Future<void> _check({bool silent = false}) async {
    if (_checking || !mounted) return;
    if (!silent) setState(() => _checking = true);
    try {
      await widget.onRefresh();
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _checking = false;
      if (!silent) _checkedOnce = true;
    });
  }

  Future<void> _logout() async {
    if (_loggingOut) return;
    setState(() => _loggingOut = true);
    await widget.onLogout();
    if (mounted) setState(() => _loggingOut = false);
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final s = widget.session;
    final (IconData icon, Color tone, String title, String hindi, String body, String bodyHindi) = switch (s.approval) {
      PartnerApproval.rejected => (
          LucideIcons.circleX,
          KraveoPalette.danger,
          'We could not approve this yet',
          'अभी मंज़ूर नहीं हो सका',
          'Please fix the details below and send them again.',
          'नीचे दी गई जानकारी सुधारकर फिर से भेजें।',
        ),
      PartnerApproval.suspended => (
          LucideIcons.circlePause,
          KraveoPalette.warning,
          'Your account is paused',
          'आपका अकाउंट रुका हुआ है',
          'You cannot take orders right now. Ask Kraveo support to open it again.',
          'अभी आप ऑर्डर नहीं ले सकते। दोबारा चालू करने के लिए Kraveo सपोर्ट से पूछें।',
        ),
      _ => (
          LucideIcons.hourglass,
          k.brand,
          'Thanks! We are checking your details',
          'धन्यवाद! हम आपकी जानकारी जाँच रहे हैं',
          'Kraveo may call you on ${s.phone ?? 'your number'}. You can start taking orders as soon as you are approved.',
          'Kraveo आपको फ़ोन कर सकता है। मंज़ूरी मिलते ही आप ऑर्डर लेना शुरू कर सकते हैं।',
        ),
    };
    final pending = s.approval == PartnerApproval.pending;
    final rejected = s.approval == PartnerApproval.rejected;
    final reason = s.rejectionReason?.trim() ?? '';

    return Scaffold(
      backgroundColor: k.bg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 24, KSpace.gutter, 28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const KReveal(child: KBrandMark(height: 52)),
                const SizedBox(height: 26),
                KReveal(
                  index: 1,
                  child: Container(
                    key: const ValueKey('status-icon'),
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(color: tone.withValues(alpha: 0.14), shape: BoxShape.circle),
                    child: Icon(icon, size: 36, color: tone),
                  ),
                ),
                const SizedBox(height: 18),
                KReveal(
                  index: 2,
                  child: Semantics(
                    header: true,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(title, key: const ValueKey('status-title'), style: KraveoType.headline.copyWith(color: k.ink, fontSize: 27)),
                      const SizedBox(height: 4),
                      Text(hindi, style: KraveoType.titleLg.copyWith(color: k.inkMuted, fontSize: 20)),
                    ]),
                  ),
                ),
                const SizedBox(height: 14),
                KReveal(
                  index: 3,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(body, style: KraveoType.body.copyWith(color: k.ink, fontSize: 17)),
                    const SizedBox(height: 4),
                    Text(bodyHindi, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
                  ]),
                ),
                if (reason.isNotEmpty && !pending) ...[
                  const SizedBox(height: 18),
                  KReveal(
                    index: 4,
                    child: KCard(
                      key: const ValueKey('status-reason'),
                      elevated: false,
                      color: Color.alphaBlend(tone.withValues(alpha: 0.10), k.surface),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Icon(LucideIcons.messageSquareWarning, size: 24, color: tone),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text('Reason from Kraveo  ·  Kraveo का कारण', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13)),
                            const SizedBox(height: 4),
                            Text(reason, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 18)),
                          ]),
                        ),
                      ]),
                    ),
                  ),
                ],
                const SizedBox(height: 18),
                KReveal(
                  index: 5,
                  child: KCard(
                    elevated: false,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      _Row(icon: LucideIcons.store, label: 'Restaurant  ·  रेस्टोरेंट', value: s.restaurantName),
                      if ((s.address ?? '').isNotEmpty) _Row(icon: LucideIcons.mapPin, label: 'Kitchen  ·  रसोई', value: s.address!),
                      if ((s.category ?? '').isNotEmpty) _Row(icon: LucideIcons.chefHat, label: 'Serves  ·  क्या बनाते हैं', value: s.category!),
                      _Row(icon: LucideIcons.phone, label: 'Your number  ·  आपका नंबर', value: s.phone ?? '—', last: true),
                    ]),
                  ),
                ),
                const SizedBox(height: 22),
                if (rejected)
                  KReveal(
                    index: 6,
                    child: KButton(
                      key: const ValueKey('edit-button'),
                      label: 'Update details and apply again',
                      sublabel: 'जानकारी सुधारकर फिर भेजें',
                      icon: LucideIcons.pencil,
                      large: true,
                      onPressed: widget.onEdit,
                    ),
                  )
                else
                  KReveal(
                    index: 6,
                    child: KButton(
                      key: const ValueKey('check-button'),
                      label: _checking ? 'Checking…' : 'Check status',
                      sublabel: 'स्थिति देखें',
                      icon: LucideIcons.refreshCw,
                      large: true,
                      loading: _checking,
                      onPressed: () => _check(),
                    ),
                  ),
                if (_checkedOnce && !_checking && pending)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text('Still waiting. We will update this screen by itself.  ·  अभी इंतज़ार है। यह स्क्रीन अपने आप बदल जाएगी।',
                        key: const ValueKey('still-waiting'), style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
                  ),
                if (pending) ...[
                  const SizedBox(height: 12),
                  KReveal(
                    index: 7,
                    child: KButton(
                      key: const ValueKey('edit-button'),
                      label: 'Change my details',
                      sublabel: 'जानकारी बदलें',
                      kind: KButtonKind.ghost,
                      icon: LucideIcons.pencil,
                      onPressed: widget.onEdit,
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                KReveal(
                  index: 8,
                  child: KButton(
                    key: const ValueKey('logout-button'),
                    label: 'Log out',
                    sublabel: 'लॉग आउट',
                    kind: KButtonKind.ghost,
                    icon: LucideIcons.logOut,
                    loading: _loggingOut,
                    onPressed: _logout,
                  ),
                ),
                const SizedBox(height: 18),
                Text('Need help? Ask Kraveo support.  ·  मदद चाहिए? Kraveo सपोर्ट से पूछें।',
                    style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.label, required this.value, this.last = false});

  final IconData icon;
  final String label;
  final String value;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: EdgeInsets.only(bottom: last ? 0 : 14),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 22, color: k.inkMuted),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 12)),
            const SizedBox(height: 2),
            Text(value, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 17)),
          ]),
        ),
      ]),
    );
  }
}
