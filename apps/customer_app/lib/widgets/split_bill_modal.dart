import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/app_theme.dart';
import '../models/order.dart';

class SplitBillModal extends StatefulWidget {
  final OrderModel order;

  const SplitBillModal({super.key, required this.order});

  @override
  State<SplitBillModal> createState() => _SplitBillModalState();
}

class _SplitBillModalState extends State<SplitBillModal> {
  int _roommateCount = 2;

  String get _splitSummaryText {
    final perPerson = (widget.order.totalAmount / _roommateCount).toStringAsFixed(0);
    final buffer = StringBuffer();
    buffer.writeln('🛵 *KRAVEO LATE-NIGHT HOSTEL BILL SPLIT* 🍕');
    buffer.writeln('📍 Dhaba: ${widget.order.dhabaName}');
    buffer.writeln('🏢 Dropoff: ${widget.order.hostel}');
    buffer.writeln('--------------------------------');
    for (final item in widget.order.items) {
      buffer.writeln('• ${item.quantity}x ${item.item.name} - ₹${(item.quantity * item.item.price).toInt()}');
    }
    buffer.writeln('--------------------------------');
    buffer.writeln('💰 Total Bill: ₹${widget.order.totalAmount.toInt()}');
    buffer.writeln('👥 Split among $_roommateCount roommates: *₹$perPerson per person*');
    buffer.writeln('📲 Pay via UPI to hosteller!');
    return buffer.toString();
  }

  @override
  Widget build(BuildContext context) {
    final perPersonAmount = (widget.order.totalAmount / _roommateCount).toStringAsFixed(0);

    return Container(
      padding: const EdgeInsets.all(24),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: const [
                  Icon(Icons.groups, color: AppTheme.primaryEmerald, size: 24),
                  SizedBox(width: 8),
                  Text(
                    'Roommate Split-Bill Generator',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppTheme.textDark),
                  ),
                ],
              ),
              IconButton(
                icon: const Icon(Icons.close, color: AppTheme.textMuted),
                onPressed: () => Navigator.pop(context),
              ),
            ],
          ),
          const Divider(height: 20, color: AppTheme.borderLight),
          const SizedBox(height: 8),

          // Roommate Count Stepper
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Split among how many roommates?', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
              Row(
                children: [
                  IconButton(
                    icon: const Icon(Icons.remove_circle_outline, color: AppTheme.accentRed),
                    onPressed: _roommateCount > 1 ? () => setState(() => _roommateCount--) : null,
                  ),
                  Text('$_roommateCount', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  IconButton(
                    icon: const Icon(Icons.add_circle_outline, color: AppTheme.primaryEmerald),
                    onPressed: () => setState(() => _roommateCount++),
                  ),
                ],
              ),
            ],
          ),

          const SizedBox(height: 16),

          // Per Person Calculation Banner
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: AppTheme.secondaryGold.withValues(alpha: 0.2),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppTheme.secondaryGold),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('EACH ROOMMATE PAYS', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppTheme.secondaryTextGold)),
                    Text('₹$perPersonAmount', style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w900, color: AppTheme.textDark)),
                  ],
                ),
                Text('Total ₹${widget.order.totalAmount.toInt()}', style: const TextStyle(color: AppTheme.textMuted, fontSize: 13, fontWeight: FontWeight.bold)),
              ],
            ),
          ),

          const SizedBox(height: 16),

          // Preview Text Box
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppTheme.surfaceBackground,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppTheme.borderLight),
            ),
            child: Text(
              _splitSummaryText,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: AppTheme.textDark),
            ),
          ),

          const SizedBox(height: 20),

          // Copy / Share Buttons
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton.icon(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: _splitSummaryText));
                Navigator.pop(context);
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('Itemized Split Bill copied to clipboard! Paste in WhatsApp group.'),
                    backgroundColor: AppTheme.primaryEmerald,
                  ),
                );
              },
              icon: const Icon(Icons.copy, color: Colors.white),
              label: const Text('COPY BILL SUMMARY TO PASTE IN WHATSAPP', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13)),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.primaryEmerald,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
