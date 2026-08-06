import 'package:flutter/material.dart';
import '../models/dish_model.dart';

class StockCard extends StatelessWidget {
  final DishModel dish;
  final VoidCallback onToggleStock;
  final Function(double newPrice) onUpdatePrice;

  const StockCard({
    super.key,
    required this.dish,
    required this.onToggleStock,
    required this.onUpdatePrice,
  });

  void _showPriceEditDialog(BuildContext context) {
    final textController = TextEditingController(text: dish.price.toStringAsFixed(0));
    showDialog(
      context: context,
      builder: (context) {
        return AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
          title: Text(
            'Edit Price: ${dish.name}',
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18, color: Color(0xFF1B1C1C)),
          ),
          content: TextField(
            controller: textController,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            autofocus: true,
            decoration: InputDecoration(
              labelText: 'Price (₹)',
              prefixText: '₹ ',
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('CANCEL', style: TextStyle(color: Colors.grey, fontWeight: FontWeight.bold)),
            ),
            ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF00450D),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              onPressed: () {
                final double? parsed = double.tryParse(textController.text);
                if (parsed != null && parsed >= 0) {
                  onUpdatePrice(parsed);
                }
                Navigator.pop(context);
              },
              child: const Text('SAVE PRICE', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: dish.inStock ? const Color(0xFF00450D) : const Color(0xFFBA1A1A),
          width: 2,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 8,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(14.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Category Badge & Quick Edit Icon
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFCF9F8),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFE5E2E1)),
                  ),
                  child: Text(
                    dish.category.toUpperCase(),
                    style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Colors.grey),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.edit_note_rounded, size: 22, color: Color(0xFF00450D)),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                  onPressed: () => _showPriceEditDialog(context),
                  tooltip: 'Edit Price',
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Dish Name
            Text(
              dish.name,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 16,
                color: dish.inStock ? const Color(0xFF1B1C1C) : Colors.grey,
                decoration: dish.inStock ? null : TextDecoration.lineThrough,
              ),
            ),
            const Spacer(),

            // Price & 1-Tap Greasy-Hands Steppers (+10 / -10)
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                IconButton(
                  onPressed: () {
                    if (dish.price >= 10) {
                      onUpdatePrice(dish.price - 10);
                    }
                  },
                  icon: const Icon(Icons.remove_circle_outline, color: Color(0xFFBA1A1A), size: 22),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                  tooltip: '-10 Price',
                ),
                InkWell(
                  onTap: () => _showPriceEditDialog(context),
                  borderRadius: BorderRadius.circular(8),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 6),
                    child: Text(
                      '₹${dish.price.toStringAsFixed(0)}',
                      style: const TextStyle(
                        color: Color(0xFF00450D),
                        fontWeight: FontWeight.w900,
                        fontSize: 20,
                      ),
                    ),
                  ),
                ),
                IconButton(
                  onPressed: () {
                    onUpdatePrice(dish.price + 10);
                  },
                  icon: const Icon(Icons.add_circle_outline, color: Color(0xFF00450D), size: 22),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                  tooltip: '+10 Price',
                ),
              ],
            ),
            const SizedBox(height: 10),

            // Instant IN STOCK / SOLD OUT Toggle Button
            ElevatedButton.icon(
              onPressed: onToggleStock,
              icon: Icon(
                dish.inStock ? Icons.check_circle : Icons.block,
                color: Colors.white,
                size: 18,
              ),
              label: Text(
                dish.inStock ? 'IN STOCK' : 'SOLD OUT',
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w900,
                  fontSize: 13,
                  letterSpacing: 0.5,
                ),
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: dish.inStock ? const Color(0xFF00450D) : const Color(0xFFBA1A1A),
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                elevation: 2,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
