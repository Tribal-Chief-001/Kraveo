import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../config/app_info.dart';
import '../models/auth_results.dart';
import '../models/customer_user.dart';
import '../models/order.dart';
import '../providers/cart_provider.dart';
import '../providers/order_provider.dart';
import '../providers/session_provider.dart';
import '../widgets/ui/error_line.dart';
import '../widgets/ui/format.dart';
import '../widgets/ui/hostel_pill.dart';
import '../widgets/ui/profile_sheets.dart';
import '../widgets/ui/sheet_chrome.dart';
import '../widgets/ui/snack.dart';
import '../widgets/ui/status_map.dart';
import '../widgets/ui/support_contact.dart';
import '../services/external_links.dart';

/// "Me" tab: avatar, name, e-mail, mobile, student status, drop-off point, coins, order summary
/// and the account actions (log out, delete account).
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, this.onOpenOrders, this.onTrackOrder});

  /// Jumps to the Orders tab.
  final VoidCallback? onOpenOrders;

  /// Jumps to the Track tab (shown while an order is live).
  final VoidCallback? onTrackOrder;

  Future<void> _changeHostel(BuildContext context, SessionProvider session) async {
    final picked = await showHostelPicker(context, blocks: kHostelBlocks, selected: session.hostel ?? '');
    if (picked == null || picked == session.hostel || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final result = await session.changeHostel(picked);
    if (result.unauthorized) return; // AuthGate already sent the student back to login
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(result.success
          ? buildKSnack('Drop-off point set to $picked', icon: LucideIcons.mapPin)
          : buildKSnack(
              result.networkError ? 'We couldn\'t save your drop-off point. Check your connection and try again.' : (result.message ?? 'We couldn\'t save your drop-off point. Please try again.'),
              error: true,
            ));
  }

  Future<void> _toggleStudent(BuildContext context, SessionProvider session, bool value) async {
    if (session.isSavingProfile) return;
    final messenger = ScaffoldMessenger.of(context);
    ProfileResult result;
    if (value) {
      // A student needs a hostel block: ask first, save both together.
      final picked = await showHostelPicker(context, blocks: kHostelBlocks, selected: session.hostel ?? '');
      if (picked == null || !context.mounted) return;
      result = await session.saveProfile(isStudent: true, hostelBlock: picked);
    } else {
      result = await session.saveProfile(isStudent: false);
    }
    if (result.unauthorized) return; // AuthGate already sent the student back to login
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(result.success
          ? buildKSnack(value ? 'Student status saved' : 'Saved. You\'ll choose your drop-off point at checkout.', icon: LucideIcons.graduationCap)
          : buildKSnack(profileSaveFailure(result), error: true));
  }

  Future<void> _logout(BuildContext context, SessionProvider session) async {
    final ok = await showKConfirm(
      context,
      title: 'Log out of Kraveo?',
      message: 'You will sign back in with Google next time. Anything in your cart will be cleared.',
      confirmLabel: 'Log out',
    );
    if (ok == true) await session.logout();
  }

  Future<void> _deleteAccount(BuildContext context) {
    return showKSheet<bool>(context, builder: (_) => const DeleteAccountSheet());
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final session = context.watch<SessionProvider>();
    final orders = context.watch<OrderProvider>();
    final coins = context.select<CartProvider, int>((c) => c.userKraveoCoins);
    final user = session.user;
    final bottomInset = MediaQuery.paddingOf(context).bottom;

    return Scaffold(
      backgroundColor: k.bg,
      appBar: AppBar(
        automaticallyImplyLeading: false,
        toolbarHeight: 68,
        titleSpacing: KSpace.gutter,
        title: const Text('Me'),
      ),
      body: user == null
          ? const SizedBox.shrink()
          : ListView(
              padding: EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, bottomInset + 24),
              children: [
                KReveal(child: _IdentityCard(user: user, coins: coins, onChangeAvatar: () => showAvatarSheet(context))),
                const _SectionLabel('YOUR DETAILS'),
                KReveal(
                  index: 1,
                  child: KCard(
                    padding: EdgeInsets.zero,
                    child: Column(children: [
                      _DetailRow(icon: LucideIcons.user, label: 'Name', value: user.displayName, onTap: () => showDetailsSheet(context)),
                      Divider(height: 1, indent: 72, endIndent: 16, color: k.line.withValues(alpha: 0.7)),
                      _DetailRow(icon: LucideIcons.mail, label: 'Email', value: user.email ?? 'Not available'),
                      Divider(height: 1, indent: 72, endIndent: 16, color: k.line.withValues(alpha: 0.7)),
                      _DetailRow(
                        icon: LucideIcons.phone,
                        label: 'Mobile',
                        value: user.phone == null ? 'Add your number' : user.maskedPhone,
                        muted: user.phone == null,
                        onTap: () => showDetailsSheet(context),
                      ),
                    ]),
                  ),
                ),
                const _SectionLabel('DELIVERY'),
                KReveal(
                  index: 2,
                  child: KCard(
                    padding: EdgeInsets.zero,
                    child: Column(children: [
                      _StudentRow(
                        isStudent: user.isStudent == true,
                        saving: session.isSavingProfile,
                        onChanged: (v) => _toggleStudent(context, session, v),
                      ),
                      Divider(height: 1, indent: 72, endIndent: 16, color: k.line.withValues(alpha: 0.7)),
                      if (user.isStudent == true)
                        _DropoffCard(
                          hostel: session.hostel,
                          saving: session.isSavingProfile,
                          onTap: () => _changeHostel(context, session),
                        )
                      else
                        const _DeliveryPointNote(),
                    ]),
                  ),
                ),
                const _SectionLabel('ORDERS'),
                KReveal(index: 3, child: _OrdersCard(orders: orders, onOpen: onOpenOrders, onTrack: onTrackOrder)),
                const _SectionLabel('HELP'),
                KReveal(
                  index: 4,
                  child: KCard(
                    padding: EdgeInsets.zero,
                    child: _SettingsRow(
                      icon: LucideIcons.mail,
                      title: 'Contact Kraveo support',
                      subtitle: kSupportEmail,
                      onTap: () => emailSupport(context, subject: 'Kraveo customer app help'),
                    ),
                  ),
                ),
                const _SectionLabel('ACCOUNT'),
                KReveal(
                  index: 4,
                  child: KCard(
                    padding: EdgeInsets.zero,
                    child: Column(children: [
                      _SettingsRow(
                        icon: LucideIcons.logOut,
                        title: 'Log out',
                        subtitle: 'Sign out on this phone',
                        onTap: () => _logout(context, session),
                      ),
                      Divider(height: 1, indent: 72, endIndent: 16, color: k.line.withValues(alpha: 0.7)),
                      _SettingsRow(
                        icon: LucideIcons.trash2,
                        title: 'Delete account',
                        subtitle: 'Permanently remove your data',
                        danger: true,
                        onTap: () => _deleteAccount(context),
                      ),
                    ]),
                  ),
                ),
                const SizedBox(height: 28),
                Center(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    const Opacity(opacity: 0.85, child: KBrandMark(height: 30)),
                    const SizedBox(height: 8),
                    Text('Kraveo v$kAppVersion', style: KraveoType.caption.copyWith(color: k.inkFaint, fontSize: 12)),
                  ]),
                ),
              ],
            ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 26, 4, 10),
      child: Text(text, style: KraveoType.label.copyWith(color: context.k.inkMuted, letterSpacing: 1.2)),
    );
  }
}

/// Brand-green hero: avatar (tap to change), name, e-mail and the coin balance.
class _IdentityCard extends StatelessWidget {
  const _IdentityCard({required this.user, required this.coins, required this.onChangeAvatar});

  final CustomerUser user;
  final int coins;
  final VoidCallback onChangeAvatar;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      width: double.infinity,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: k.brand, borderRadius: BorderRadius.circular(KRadius.xl), boxShadow: KShadow.lift(k.shadowTint)),
      child: Stack(children: [
        Positioned(
          right: -40,
          top: -46,
          child: Container(width: 170, height: 170, decoration: BoxDecoration(color: KraveoPalette.g700.withValues(alpha: 0.55), shape: BoxShape.circle)),
        ),
        Padding(
          padding: const EdgeInsets.all(20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              KPressable(
                onTap: onChangeAvatar,
                semanticLabel: 'Change avatar',
                child: Stack(clipBehavior: Clip.none, children: [
                  KAvatar(id: user.avatarId, size: 72, ring: true),
                  Positioned(
                    right: -2,
                    bottom: -2,
                    child: Container(
                      width: 26,
                      height: 26,
                      decoration: BoxDecoration(color: k.surface, shape: BoxShape.circle, border: Border.all(color: k.brand, width: 2)),
                      child: Icon(LucideIcons.pencil, size: 13, color: k.brand),
                    ),
                  ),
                ]),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: MergeSemantics(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(user.displayName, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.headlineSm.copyWith(color: k.onBrand)),
                    if (user.email != null) ...[
                      const SizedBox(height: 6),
                      Text(user.email!, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.onBrand.withValues(alpha: 0.85), fontWeight: FontWeight.w600)),
                    ],
                  ]),
                ),
              ),
            ]),
            const SizedBox(height: 18),
            Semantics(
              container: true,
              label: '$coins Kraveo Coins. Redeeming coins is coming soon',
              child: ExcludeSemantics(
                child: Container(
                  padding: const EdgeInsets.fromLTRB(14, 12, 16, 12),
                  decoration: BoxDecoration(color: k.onBrand.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(KRadius.lg)),
                  child: Row(children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(color: k.onBrand.withValues(alpha: 0.16), shape: BoxShape.circle),
                      child: Icon(LucideIcons.coins, size: 20, color: k.onBrand),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Kraveo Coins', style: KraveoType.titleMd.copyWith(color: k.onBrand)),
                        const SizedBox(height: 2),
                        Text('Redeeming soon', style: KraveoType.bodySm.copyWith(color: k.onBrand.withValues(alpha: 0.8))),
                      ]),
                    ),
                    const SizedBox(width: 8),
                    KAnimatedNumber(value: coins, style: KraveoType.numericSm.copyWith(color: k.onBrand)),
                  ]),
                ),
              ),
            ),
          ]),
        ),
      ]),
    );
  }
}

/// One line of profile info: icon tile, small label, value. Tappable rows show a chevron.
class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.icon, required this.label, required this.value, this.onTap, this.muted = false});

  final IconData icon;
  final String label;
  final String value;
  final VoidCallback? onTap;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KPressable(
      onTap: onTap,
      scale: 0.99,
      semanticLabel: onTap == null ? '$label, $value' : '$label, $value. Edit',
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: ExcludeSemantics(
          child: Row(children: [
            _IconTile(icon: icon, color: k.brand),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(label, style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 0.6)),
                const SizedBox(height: 2),
                Text(value, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleMd.copyWith(color: muted ? k.inkFaint : k.ink)),
              ]),
            ),
            if (onTap != null) Icon(LucideIcons.pencil, size: 18, color: k.inkFaint),
          ]),
        ),
      ),
    );
  }
}

/// "I'm a student" switch. Turning it on asks for a hostel block first.
class _StudentRow extends StatelessWidget {
  const _StudentRow({required this.isStudent, required this.saving, required this.onChanged});

  final bool isStudent;
  final bool saving;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Semantics(
      toggled: isStudent,
      label: 'I\'m a student. ${isStudent ? 'On. Your hostel block is saved for checkout' : 'Off. You choose a drop-off point at checkout'}',
      excludeSemantics: true,
      onTap: saving ? null : () => onChanged(!isStudent),
      child: KPressable(
        onTap: saving ? null : () => onChanged(!isStudent),
        scale: 0.99,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Row(children: [
            _IconTile(icon: LucideIcons.graduationCap, color: k.brand),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('I\'m a student', style: KraveoType.titleMd.copyWith(color: k.ink)),
                const SizedBox(height: 2),
                Text(isStudent ? 'Your hostel block is saved for checkout' : 'You choose a drop-off point at checkout', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
              ]),
            ),
            const SizedBox(width: 8),
            if (saving)
              SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.4, color: k.brand))
            else
              IgnorePointer(child: Switch(value: isStudent, onChanged: (_) {})),
          ]),
        ),
      ),
    );
  }
}

/// Shown instead of the hostel row when the student flag is off.
class _DeliveryPointNote extends StatelessWidget {
  const _DeliveryPointNote();

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      child: Row(children: [
        _IconTile(icon: LucideIcons.mapPin, color: k.inkMuted),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Delivery point', style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 0.6)),
            const SizedBox(height: 2),
            Text('Chosen at checkout for each order', style: KraveoType.titleMd.copyWith(color: k.ink)),
          ]),
        ),
      ]),
    );
  }
}

class _DropoffCard extends StatelessWidget {
  const _DropoffCard({required this.hostel, required this.saving, required this.onTap});

  final String? hostel;
  final bool saving;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KPressable(
      onTap: saving ? null : onTap,
      scale: 0.99,
      child: Semantics(
        label: hostel == null ? 'Hostel block not set. Choose one' : 'Hostel block $hostel. Change',
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
          child: Row(children: [
            _IconTile(icon: LucideIcons.mapPin, color: k.brand),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Hostel block', style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 0.6)),
                const SizedBox(height: 2),
                Text(hostel ?? 'Not set', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: hostel == null ? k.inkFaint : k.ink)),
              ]),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.pill)),
              child: Text(hostel == null ? 'Choose' : 'Change', style: KraveoType.label.copyWith(color: k.brand, fontSize: 13)),
            ),
          ]),
        ),
      ),
    );
  }
}

class _OrdersCard extends StatelessWidget {
  const _OrdersCard({required this.orders, required this.onOpen, required this.onTrack});

  final OrderProvider orders;
  final VoidCallback? onOpen;
  final VoidCallback? onTrack;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    // Counts what has been loaded from the server; "+" when more history pages exist.
    final delivered = orders.history.where((o) => o.status == OrderProgressStatus.delivered).toList();
    final spent = delivered.fold<double>(0, (sum, o) => sum + o.totalAmount);
    final more = orders.historyHasMore ? '+' : '';
    final active = orders.activeOrder;
    final live = active != null && active.status.isLive;

    return KCard(
      onTap: onOpen,
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          _IconTile(icon: LucideIcons.receiptText, color: k.brand),
          const SizedBox(width: 14),
          Expanded(child: Text('Your orders', style: KraveoType.titleLg.copyWith(color: k.ink))),
          Icon(LucideIcons.chevronRight, size: 20, color: k.inkFaint),
        ]),
        const SizedBox(height: 14),
        if (delivered.isEmpty)
          Text('No delivered orders yet. Your first one is a few taps away.', style: KraveoType.bodySm.copyWith(color: k.inkMuted))
        else
          Row(children: [
            Expanded(child: _Stat(value: '${delivered.length}$more', label: delivered.length == 1 ? 'Order delivered' : 'Orders delivered')),
            Container(width: 1, height: 36, color: k.line),
            const SizedBox(width: 16),
            Expanded(child: _Stat(value: '${rupee(spent)}$more', label: 'Spent so far')),
          ]),
        if (live) ...[
          const SizedBox(height: 14),
          KPressable(
            onTap: onTrack,
            semanticLabel: 'Order from ${active.vendorName}: ${orderHeadline(active)}. Open tracking',
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.md)),
              child: Row(children: [
                Icon(LucideIcons.bike, size: 18, color: k.brand),
                const SizedBox(width: 10),
                Expanded(child: Text('${active.vendorName}: ${orderHeadline(active)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.brand, fontSize: 13))),
                const SizedBox(width: 8),
                Icon(LucideIcons.arrowRight, size: 16, color: k.brand),
              ]),
            ),
          ),
        ],
      ]),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(value, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.numericSm.copyWith(color: k.ink)),
      Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
    ]);
  }
}

class _IconTile extends StatelessWidget {
  const _IconTile({required this.icon, required this.color});

  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 42,
      height: 42,
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(KRadius.sm)),
      child: Icon(icon, size: 20, color: color),
    );
  }
}

class _SettingsRow extends StatelessWidget {
  const _SettingsRow({required this.icon, required this.title, required this.subtitle, required this.onTap, this.danger = false});

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final tone = danger ? kDangerInk : k.ink;
    return KPressable(
      onTap: onTap,
      scale: 0.99,
      semanticLabel: '$title. $subtitle',
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: ExcludeSemantics(
          child: Row(children: [
            _IconTile(icon: icon, color: danger ? KraveoPalette.danger : k.brand),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: KraveoType.titleMd.copyWith(color: tone)),
                const SizedBox(height: 2),
                Text(subtitle, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
              ]),
            ),
            Icon(LucideIcons.chevronRight, size: 20, color: k.inkFaint),
          ]),
        ),
      ),
    );
  }
}

/// Explains that deletion is permanent, asks for an explicit acknowledgement, and surfaces
/// the backend's reason (for example an order still in progress) without closing.
class DeleteAccountSheet extends StatefulWidget {
  const DeleteAccountSheet({super.key});

  @override
  State<DeleteAccountSheet> createState() => _DeleteAccountSheetState();
}

class _DeleteAccountSheetState extends State<DeleteAccountSheet> {
  bool _understood = false;
  bool _busy = false;
  String? _error;

  Future<void> _delete() async {
    final session = context.read<SessionProvider>();
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await session.deleteAccount();
    if (!mounted) return;
    if (result.success) {
      navigator.pop(true);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(buildKSnack('Your account has been deleted.', icon: LucideIcons.trash2));
      return;
    }
    if (result.unauthorized) return; // AuthGate is already showing login
    setState(() {
      _busy = false;
      _error = result.networkError
          ? 'We couldn\'t reach Kraveo. Check your connection and try again.'
          : result.conflict
              ? (result.message ?? 'You have an order in progress. You can delete your account once it is delivered or cancelled.')
              : (result.message ?? 'We couldn\'t delete your account. Please try again.');
    });
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return PopScope(
      canPop: !_busy,
      child: KSheetFrame(
        title: 'Delete your account?',
        onClose: _busy ? () {} : null,
        footer: Column(mainAxisSize: MainAxisSize.min, children: [
          // Pinned with the buttons so the reason is never scrolled out of sight.
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: SizedBox(width: double.infinity, child: KErrorLine(message: _error))),
          Row(children: [
            Expanded(child: KButton(label: 'Keep account', kind: KButtonKind.ghost, onPressed: _busy ? null : () => Navigator.of(context).pop(false))),
            const SizedBox(width: 12),
            Expanded(child: KButton(label: 'Delete', kind: KButtonKind.danger, loading: _busy, onPressed: _understood ? _delete : null)),
          ]),
        ]),
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: KraveoPalette.danger.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(KRadius.md)),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(LucideIcons.triangleAlert, size: 20, color: kDangerInk),
              const SizedBox(width: 12),
              Expanded(child: Text('This is permanent and can\'t be undone.', style: KraveoType.titleMd.copyWith(color: kDangerInk))),
            ]),
          ),
          const SizedBox(height: 16),
          for (final line in const [
            'Your name, phone number and drop-off point are removed from Kraveo.',
            'Your Kraveo Coins are lost and can\'t be restored.',
            'You will be logged out on this phone straight away.',
          ])
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Padding(padding: const EdgeInsets.only(top: 2), child: Icon(LucideIcons.minus, size: 16, color: k.inkFaint)),
                const SizedBox(width: 10),
                Expanded(child: Text(line, style: KraveoType.body.copyWith(color: k.inkMuted))),
              ]),
            ),
          const SizedBox(height: 4),
          KPressable(
            onTap: _busy ? null : () => setState(() => _understood = !_understood),
            semanticLabel: 'I understand my account will be permanently deleted',
            child: Semantics(
              checked: _understood,
              child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
                AnimatedContainer(
                  duration: KMotion.fast,
                  width: 26,
                  height: 26,
                  decoration: BoxDecoration(
                    color: _understood ? KraveoPalette.danger : Colors.transparent,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _understood ? KraveoPalette.danger : k.inkFaint, width: 1.6),
                  ),
                  child: _understood ? const Icon(LucideIcons.check, size: 16, color: Colors.white) : null,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Text('I understand this is permanent', style: KraveoType.titleMd.copyWith(color: k.ink)),
                  ),
                ),
              ]),
            ),
          ),
        ],
      ),
    );
  }
}
