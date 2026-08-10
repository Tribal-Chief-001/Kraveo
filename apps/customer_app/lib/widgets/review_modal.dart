import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../services/customer_api_service.dart';

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

  @override
  State<ReviewModal> createState() => _ReviewModalState();
}

class _ReviewModalState extends State<ReviewModal> {
  int _driverRating = 5;
  final Set<String> _selectedDriverTags = {'⚡ Super Fast', '🤝 Polite Runner'};
  final TextEditingController _driverNotesController = TextEditingController();

  final Map<String, int> _dishRatings = {};
  final Set<String> _selectedDishTags = {'🔥 Hot & Fresh', '😋 Delicious Taste'};
  final TextEditingController _dhabaNotesController = TextEditingController();

  bool _isSubmitting = false;

  final List<String> _driverTagOptions = [
    '⚡ Super Fast',
    '🤝 Polite Runner',
    '📦 Careful Handling',
    '📞 Great Call Info',
  ];

  final List<String> _dishTagOptions = [
    '🔥 Hot & Fresh',
    '😋 Delicious Taste',
    '🍱 Great Packaging',
    '🌶️ Perfect Spice',
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

    await CustomerApiService.submitReview(
      orderId: widget.orderId,
      dhabaRating: avgDishRating,
      driverRating: _driverRating.toDouble(),
      reviewText: reviewText,
    );

    if (mounted) {
      widget.onReviewSubmitted(10);
      Navigator.of(context).pop();

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Row(
            children: [
              Icon(Icons.monetization_on, color: Color(0xFFFDD400)),
              SizedBox(width: 10),
              Expanded(
                child: Text(
                  '🎉 Review Submitted! +10 Kraveo Coins Added to Wallet!',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
              ),
            ],
          ),
          backgroundColor: AppTheme.primaryEmerald,
          duration: Duration(seconds: 4),
        ),
      );
    }
  }


  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.only(
          topLeft: Radius.circular(24),
          topRight: Radius.circular(24),
        ),
      ),
      padding: EdgeInsets.only(
        top: 20,
        left: 20,
        right: 20,
        bottom: MediaQuery.of(context).viewInsets.bottom + 20,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header Banner with Kuvera Coin Reward Callout
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'RATE YOUR MEAL',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                        color: AppTheme.primaryEmerald,
                        letterSpacing: 0.8,
                      ),
                    ),
                    Text(
                      widget.dhabaName,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w900,
                        color: AppTheme.textDark,
                      ),
                    ),
                  ],
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFDD400).withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: const Color(0xFFFDD400), width: 1.5),
                  ),
                  child: Row(
                    children: const [
                      Icon(Icons.monetization_on, color: Color(0xFFB78100), size: 16),
                      SizedBox(width: 4),
                      Text(
                        '+10 COINS',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w900,
                          color: Color(0xFF7A5600),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),

            const SizedBox(height: 16),
            const Divider(),

            // 1. RATE RUNNER SECTION
            if (widget.driverName != null) ...[
              Text(
                '🛵 RATE RUNNER (${widget.driverName})',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  color: AppTheme.textMuted,
                  letterSpacing: 0.5,
                ),
              ),
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(5, (index) {
                  final starIndex = index + 1;
                  return IconButton(
                    icon: Icon(
                      starIndex <= _driverRating ? Icons.star : Icons.star_border,
                      color: const Color(0xFFFDD400),
                      size: 32,
                    ),
                    onPressed: () => setState(() => _driverRating = starIndex),
                  );
                }),
              ),
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                runSpacing: 6,
                children: _driverTagOptions.map((tag) {
                  final isSelected = _selectedDriverTags.contains(tag);
                  return FilterChip(
                    label: Text(tag, style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: isSelected ? Colors.white : AppTheme.textDark)),
                    selected: isSelected,
                    selectedColor: AppTheme.primaryEmerald,
                    backgroundColor: Colors.grey.shade100,
                    onSelected: (selected) {
                      setState(() {
                        if (selected) {
                          _selectedDriverTags.add(tag);
                        } else {
                          _selectedDriverTags.remove(tag);
                        }
                      });
                    },
                  );
                }).toList(),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _driverNotesController,
                style: const TextStyle(fontSize: 12),
                decoration: InputDecoration(
                  hintText: 'Private note for Kraveo Admin Ops (optional)...',
                  hintStyle: TextStyle(color: Colors.grey.shade400, fontSize: 12),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                  focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: AppTheme.primaryEmerald)),
                ),
              ),
              const SizedBox(height: 16),
              const Divider(),
            ],

            // 2. RATE DISHES SECTION
            Text(
              '🍲 RATE YOUR DISHES',
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w800,
                color: AppTheme.textMuted,
                letterSpacing: 0.5,
              ),
            ),
            const SizedBox(height: 8),

            ...widget.dishNames.map((dish) {
              final rating = _dishRatings[dish] ?? 5;
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 4.0),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Expanded(
                      child: Text(
                        dish,
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                      ),
                    ),
                    Row(
                      children: List.generate(5, (index) {
                        final starIndex = index + 1;
                        return GestureDetector(
                          onTap: () => setState(() => _dishRatings[dish] = starIndex),
                          child: Icon(
                            starIndex <= rating ? Icons.star : Icons.star_border,
                            color: const Color(0xFFFDD400),
                            size: 24,
                          ),
                        );
                      }),
                    ),
                  ],
                ),
              );
            }),

            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: _dishTagOptions.map((tag) {
                final isSelected = _selectedDishTags.contains(tag);
                return FilterChip(
                  label: Text(tag, style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: isSelected ? Colors.white : AppTheme.textDark)),
                  selected: isSelected,
                  selectedColor: AppTheme.primaryEmerald,
                  backgroundColor: Colors.grey.shade100,
                  onSelected: (selected) {
                    setState(() {
                      if (selected) {
                        _selectedDishTags.add(tag);
                      } else {
                        _selectedDishTags.remove(tag);
                      }
                    });
                  },
                );
              }).toList(),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _dhabaNotesController,
              style: const TextStyle(fontSize: 12),
              decoration: InputDecoration(
                hintText: 'Feedback note for Dhaba Owner (optional)...',
                hintStyle: TextStyle(color: Colors.grey.shade400, fontSize: 12),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
                focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: AppTheme.primaryEmerald)),
              ),
            ),

            const SizedBox(height: 20),

            // SUBMIT BUTTON
            SizedBox(
              width: double.infinity,
              height: 50,
              child: ElevatedButton(
                onPressed: _isSubmitting ? null : _submitReview,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.primaryEmerald,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
                child: _isSubmitting
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: const [
                          Icon(Icons.monetization_on, color: Color(0xFFFDD400)),
                          SizedBox(width: 8),
                          Text('SUBMIT & CLAIM +10 KRAVEO COINS', style: TextStyle(fontWeight: FontWeight.w900, fontSize: 13)),
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
