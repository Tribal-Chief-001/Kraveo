import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

/// Job offer: payout first, route second, then one huge slide-to-accept.
/// The 1-tap accept remains as a clearly secondary fallback.
class SwipeAcceptCard extends StatefulWidget {
  final VoidCallback onAccepted;
  final VoidCallback? onDeclined;
  final int payout;
  final double distanceKm;
  final String pickupName;
  final String pickupNote;
  final String dropName;
  final String dropNote;

  const SwipeAcceptCard({
    super.key,
    required this.onAccepted,
    this.onDeclined,
    this.payout = 40,
    this.distanceKm = 1.8,
    this.pickupName = 'FC Night Mess',
    this.pickupNote = 'VIT Bhopal Entry Gate 1',
    this.dropName = 'Boys Hostel Block 1',
    this.dropNote = 'Gate 2 handshake',
  });

  @override
  State<SwipeAcceptCard> createState() => _SwipeAcceptCardState();
}

class _SwipeAcceptCardState extends State<SwipeAcceptCard> {
  bool _accepted = false;

  void _accept() {
    if (_accepted) return;
    setState(() => _accepted = true);
    widget.onAccepted();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KCard(
      padding: const EdgeInsets.all(20),
      borderColor: k.brand.withValues(alpha: 0.55),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('YOU EARN', maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.brand, letterSpacing: 1.1)),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Text('₹${widget.payout}', style: KraveoType.displayLg.copyWith(fontSize: 64, height: 1.05, color: k.ink)),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              _Chip(icon: LucideIcons.route, text: '${widget.distanceKm} km'),
              if (widget.onDeclined != null) ...[
                const SizedBox(width: 8),
                KPressable(
                  semanticLabel: 'Decline this order',
                  onTap: widget.onDeclined,
                  child: Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(color: k.surfaceAlt, shape: BoxShape.circle, border: Border.all(color: k.line)),
                    child: ExcludeSemantics(child: Icon(LucideIcons.x, size: 22, color: k.inkMuted)),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 18),
          _Stop(icon: LucideIcons.store, color: k.brand, title: widget.pickupName, note: widget.pickupNote, label: 'PICKUP'),
          Padding(
            padding: const EdgeInsets.only(left: 19),
            child: Container(width: 2, height: 16, color: k.line),
          ),
          _Stop(icon: LucideIcons.mapPin, color: KStatus.atGate.color, title: widget.dropName, note: widget.dropNote, label: 'DROP'),
          const SizedBox(height: 20),
          if (_accepted)
            Container(
              height: 72,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: k.brand.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(KRadius.pill)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(LucideIcons.circleCheck, color: k.brand, size: 24),
                const SizedBox(width: 10),
                Text('Order accepted', style: KraveoType.titleLg.copyWith(color: k.brand)),
              ]),
            )
          else ...[
            Semantics(
              label: 'Slide to accept order, earn ₹${widget.payout}',
              button: true,
              excludeSemantics: true,
              onTap: _accept,
              child: KSlideToConfirm(label: 'Slide to accept', icon: LucideIcons.arrowRight, onConfirmed: _accept),
            ),
            const SizedBox(height: 10),
            KButton(label: 'Accept with one tap', kind: KButtonKind.ghost, icon: LucideIcons.hand, onPressed: _accept),
          ],
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.pill), border: Border.all(color: k.line)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 16, color: k.inkMuted),
        const SizedBox(width: 6),
        Text(text, style: KraveoType.label.copyWith(color: k.ink, fontSize: 14)),
      ]),
    );
  }
}

class _Stop extends StatelessWidget {
  const _Stop({required this.icon, required this.color, required this.title, required this.note, required this.label});
  final IconData icon;
  final Color color;
  final String title, note, label;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: color.withValues(alpha: 0.16), shape: BoxShape.circle),
          child: Icon(icon, size: 20, color: color),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: KraveoType.caption.copyWith(color: k.inkFaint, letterSpacing: 1.2)),
              Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.titleLg.copyWith(color: k.ink)),
              Text(note, maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
            ],
          ),
        ),
      ],
    );
  }
}
