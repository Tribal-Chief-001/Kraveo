// ignore_for_file: sort_child_properties_last
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/order.dart';
import 'ui/format.dart';
import 'ui/k_icon_button.dart';
import 'ui/sheet_chrome.dart';
import 'ui/snack.dart';

class SplitBillModal extends StatefulWidget {
  final OrderModel order;

  const SplitBillModal({super.key, required this.order});

  static Future<void> show(BuildContext context, {required OrderModel order}) {
    return showKSheet<void>(context, builder: (_) => SplitBillModal(order: order));
  }

  @override
  State<SplitBillModal> createState() => _SplitBillModalState();
}

class _SplitBillModalState extends State<SplitBillModal> {
  int _roommateCount = 2;

  String get _formattedPerPerson {
    return (widget.order.totalAmount / _roommateCount).round().toString();
  }

  String get _splitSummaryText {
    final perPerson = _formattedPerPerson;
    final buffer = StringBuffer();
    buffer.writeln('*KRAVEO LATE-NIGHT HOSTEL BILL SPLIT*');
    buffer.writeln('Kitchen: ${widget.order.dhabaName}');
    buffer.writeln('Drop-off: ${widget.order.hostel}');
    buffer.writeln('--------------------------------');
    if (widget.order.items.isNotEmpty) {
      for (final item in widget.order.items) {
        buffer.writeln('- ${item.quantity}x ${item.item.name} - ${rupee(item.totalPrice)}');
      }
      buffer.writeln('--------------------------------');
    }
    buffer.writeln('Total bill: ${rupee(widget.order.totalAmount)}');
    buffer.writeln('Split among $_roommateCount roommates: *₹$perPerson per person*');
    buffer.writeln('Pay via UPI to the one who ordered.');
    return buffer.toString();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final perPersonAmount = _formattedPerPerson;

    return KSheetFrame(
      title: 'Split the bill',
      subtitle: Text('Share what each roommate owes, ready for WhatsApp.', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
      children: [
        Row(children: [
          Expanded(child: Text('How many people are sharing?', style: KraveoType.titleMd.copyWith(color: k.ink))),
          const SizedBox(width: 8),
          KIconButton(
            icon: LucideIcons.minus,
            semanticLabel: 'One fewer person',
            onTap: _roommateCount > 1 ? () => setState(() => _roommateCount--) : null,
          ),
          SizedBox(
            width: 44,
            child: Text('$_roommateCount', textAlign: TextAlign.center, style: KraveoType.numericSm.copyWith(color: k.ink)),
          ),
          KIconButton(
            icon: LucideIcons.plus,
            semanticLabel: 'One more person',
            onTap: () => setState(() => _roommateCount++),
          ),
        ]),
        const SizedBox(height: 18),
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.xl)),
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('EACH PERSON PAYS', style: KraveoType.label.copyWith(color: k.brand)),
                const SizedBox(height: 4),
                Text('₹$perPersonAmount', style: KraveoType.displayMd.copyWith(color: k.ink)),
              ]),
            ),
            const SizedBox(width: 12),
            Text('of ${rupee(widget.order.totalAmount)}', style: KraveoType.body.copyWith(color: k.inkMuted, fontWeight: FontWeight.w700)),
          ]),
        ),
        const SizedBox(height: 18),
        Text('Message preview', style: KraveoType.label.copyWith(color: k.inkMuted)),
        const SizedBox(height: 8),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: k.surfaceAlt, borderRadius: BorderRadius.circular(KRadius.md)),
          child: Text(_splitSummaryText, style: KraveoType.bodySm.copyWith(color: k.ink, height: 1.5)),
        ),
        const SizedBox(height: 4),
      ],
      footer: KButton(
        label: 'Copy for WhatsApp',
        icon: LucideIcons.copy,
        onPressed: () {
          Clipboard.setData(ClipboardData(text: _splitSummaryText));
          final messenger = ScaffoldMessenger.of(context);
          Navigator.pop(context);
          messenger
            ..hideCurrentSnackBar()
            ..showSnackBar(buildKSnack('Bill copied. Paste it in your roommates’ WhatsApp group.', icon: LucideIcons.copyCheck));
        },
      ),
    );
  }
}
