// ignore_for_file: sort_child_properties_last
import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/customer_api_service.dart';
import 'ui/format.dart';
import 'ui/sheet_chrome.dart';
import 'ui/star_glyph.dart';
import 'ui/snack.dart';

class ReviewModal extends StatefulWidget {
  final String orderId;
  final String dhabaName;
  final String? driverName;
  final List<String> dishNames;
  final Function(int coinsEarned) onReviewSubmitted;

  const ReviewModal({
    super.key,
    required this.orderId,
    required this.dhabaName,
    this.driverName,
    required this.dishNames,
    required this.onReviewSubmitted,
  });

  static Future<void> show(
    BuildContext context, {
    required String orderId,
    required String dhabaName,
    String? driverName,
    required List<String> dishNames,
    required Function(int coinsEarned) onReviewSubmitted,
  }) {
    return showKSheet<void>(
      context,
      builder: (_) => ReviewModal(
        orderId: orderId,
        dhabaName: dhabaName,
        driverName: driverName,
        dishNames: dishNames,
        onReviewSubmitted: onReviewSubmitted,
      ),
    );
  }

  @override
  State<ReviewModal> createState() => _ReviewModalState();
}

class _Tag {
  const _Tag(this.icon, this.label);
  final IconData icon;
  final String label;
}

class _ReviewModalState extends State<ReviewModal> {
  int _driverRating = 5;
  final Set<String> _selectedDriverTags = {'Super fast', 'Polite runner'};
  final TextEditingController _driverNotesController = TextEditingController();

  final Map<String, int> _dishRatings = {};
  final Set<String> _selectedDishTags = {'Hot & fresh', 'Delicious taste'};
  final TextEditingController _dhabaNotesController = TextEditingController();

  bool _isSubmitting = false;

  static const List<_Tag> _driverTagOptions = [
    _Tag(LucideIcons.zap, 'Super fast'),
    _Tag(LucideIcons.handshake, 'Polite runner'),
    _Tag(LucideIcons.packageCheck, 'Careful handling'),
    _Tag(LucideIcons.phoneCall, 'Great call info'),
  ];

  static const List<_Tag> _dishTagOptions = [
    _Tag(LucideIcons.flame, 'Hot & fresh'),
    _Tag(LucideIcons.smile, 'Delicious taste'),
    _Tag(LucideIcons.package, 'Great packaging'),
    _Tag(LucideIcons.sparkles, 'Perfect spice'),
  ];

  @override
  void initState() {
    super.initState();
    for (var dish in widget.dishNames) {
      _dishRatings[dish] = 5;
    }
  }

  @override
  void dispose() {
    _driverNotesController.dispose();
    _dhabaNotesController.dispose();
    super.dispose();
  }

  void _submitReview() async {
    setState(() => _isSubmitting = true);

    final avgDishRating = _dishRatings.values.isEmpty
        ? 5.0
        : (_dishRatings.values.reduce((a, b) => a + b) / _dishRatings.values.length).toDouble();

    final reviewText = _dhabaNotesController.text.trim().isNotEmpty
        ? _dhabaNotesController.text.trim()
        : _driverNotesController.text.trim();

    final messenger = ScaffoldMessenger.of(context);
    await CustomerApiService.submitReview(
      orderId: widget.orderId,
      dhabaRating: avgDishRating,
      driverRating: _driverRating.toDouble(),
      reviewText: reviewText,
    );

    if (mounted) {
      widget.onReviewSubmitted(10);
      Navigator.of(context).pop();
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(buildKSnack('Thanks for rating! +10 Kraveo Coins added to your wallet.', icon: LucideIcons.coins, duration: const Duration(seconds: 4)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KSheetFrame(
      title: 'Rate ${widget.dhabaName}',
      subtitle: Row(children: [
        Icon(LucideIcons.coins, size: 15, color: k.brand),
        const SizedBox(width: 6),
        Flexible(child: Text('Earn 10 Kraveo Coins for your feedback', style: KraveoType.bodySm.copyWith(color: k.brand, fontWeight: FontWeight.w700))),
      ]),
      children: [
        if (widget.driverName != null) ...[
          _SectionLabel(icon: LucideIcons.bike, label: 'Your runner · ${widget.driverName}'),
          const SizedBox(height: 10),
          Center(child: _Stars(rating: _driverRating, size: 40, onChanged: (v) => setState(() => _driverRating = v))),
          const SizedBox(height: 12),
          _TagWrap(options: _driverTagOptions, selected: _selectedDriverTags, onToggle: (t) => setState(() => _toggle(_selectedDriverTags, t))),
          const SizedBox(height: 12),
          TextField(
            controller: _driverNotesController,
            decoration: const InputDecoration(hintText: 'Private note for Kraveo (optional)'),
          ),
          const SizedBox(height: 22),
        ],
        if (widget.dishNames.isNotEmpty) ...[
          const _SectionLabel(icon: LucideIcons.utensils, label: 'Your dishes'),
          const SizedBox(height: 6),
          for (final dish in widget.dishNames)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(children: [
                Expanded(child: Text(dish, maxLines: 2, overflow: TextOverflow.ellipsis, style: KraveoType.body.copyWith(color: k.ink, fontWeight: FontWeight.w600))),
                const SizedBox(width: 8),
                _Stars(rating: _dishRatings[dish] ?? 5, size: 28, onChanged: (v) => setState(() => _dishRatings[dish] = v)),
              ]),
            ),
          const SizedBox(height: 12),
        ],
        _TagWrap(options: _dishTagOptions, selected: _selectedDishTags, onToggle: (t) => setState(() => _toggle(_selectedDishTags, t))),
        const SizedBox(height: 12),
        TextField(
          controller: _dhabaNotesController,
          decoration: const InputDecoration(hintText: 'A note for the kitchen (optional)'),
        ),
        const SizedBox(height: 4),
      ],
      footer: KButton(
        label: 'Submit and earn 10 coins',
        icon: LucideIcons.coins,
        loading: _isSubmitting,
        onPressed: _submitReview,
      ),
    );
  }

  void _toggle(Set<String> set, String tag) {
    if (!set.remove(tag)) set.add(tag);
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Row(children: [
      Icon(icon, size: 16, color: k.brand),
      const SizedBox(width: 8),
      Expanded(child: Text(label.toUpperCase(), maxLines: 1, overflow: TextOverflow.ellipsis, style: KraveoType.label.copyWith(color: k.inkMuted))),
    ]);
  }
}

class _Stars extends StatelessWidget {
  const _Stars({required this.rating, required this.size, required this.onChanged});

  final int rating;
  final double size;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      for (var i = 1; i <= 5; i++)
        KPressable(
          onTap: () => onChanged(i),
          semanticLabel: '$i ${i == 1 ? 'star' : 'stars'}',
          child: SizedBox(
            width: size + 4,
            height: size + 8,
            child: Center(
              child: AnimatedScale(
                scale: i <= rating ? 1 : 0.86,
                duration: KMotion.base,
                curve: KMotion.spring,
                child: KStarGlyph(size: size * 0.8, filled: i <= rating, color: i <= rating ? kStarColor : k.line),
              ),
            ),
          ),
        ),
    ]);
  }
}

class _TagWrap extends StatelessWidget {
  const _TagWrap({required this.options, required this.selected, required this.onToggle});

  final List<_Tag> options;
  final Set<String> selected;
  final ValueChanged<String> onToggle;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final tag in options)
          KChoiceChip(label: tag.label, icon: tag.icon, selected: selected.contains(tag.label), onTap: () => onToggle(tag.label)),
      ],
    );
  }
}
