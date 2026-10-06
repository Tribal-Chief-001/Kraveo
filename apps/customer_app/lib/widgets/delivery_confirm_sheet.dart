import 'dart:async';

import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/drop_point.dart';
import 'ui/hostel_pill.dart';
import 'ui/sheet_chrome.dart';

/// "Confirm your delivery point": shown once when the student taps Pay, before the order is
/// created. The current point is preselected; tapping another chip only changes this order.
/// Returns the point to deliver to, or null when the student cancels (nothing is placed).
Future<String?> showConfirmDeliveryPoint(BuildContext context, {required String current, List<String>? blocks}) {
  return showKSheet<String>(
    context,
    builder: (ctx) => _ConfirmDeliveryBody(current: current, blocks: blocks ?? kDropPointNames),
  );
}

class _ConfirmDeliveryBody extends StatefulWidget {
  const _ConfirmDeliveryBody({required this.current, required this.blocks});

  final String current;
  final List<String> blocks;

  @override
  State<_ConfirmDeliveryBody> createState() => _ConfirmDeliveryBodyState();
}

class _ConfirmDeliveryBodyState extends State<_ConfirmDeliveryBody> {
  late String _selected = widget.current;

  /// How long the primary button stays disabled after the sheet opens. A double tap on "Pay"
  /// would otherwise land on this button (it slides up under the finger) and confirm a delivery
  /// point the student never read.
  static const Duration armDelay = Duration(milliseconds: 400);

  bool _armed = false;
  Timer? _armTimer;

  @override
  void initState() {
    super.initState();
    _armTimer = Timer(armDelay, () {
      if (mounted) setState(() => _armed = true);
    });
  }

  @override
  void dispose() {
    _armTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return KSheetFrame(
      title: 'Confirm your delivery point',
      subtitle: Text('Your runner meets you at this gate.', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
      footer: Column(mainAxisSize: MainAxisSize.min, children: [
        KButton(label: 'Confirm and pay', onPressed: _armed ? () => Navigator.of(context).pop(_selected) : null),
        const SizedBox(height: 4),
        KPressable(
          semanticLabel: 'Cancel. Do not place the order',
          onTap: () => Navigator.of(context).pop(),
          child: Container(
            height: 44,
            width: double.infinity,
            alignment: Alignment.center,
            child: Text('Cancel', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 14)),
          ),
        ),
      ]),
      children: [
        DropPointChips(blocks: widget.blocks, selected: _selected, onSelected: (b) => setState(() => _selected = b)),
        const SizedBox(height: 8),
      ],
    );
  }
}
