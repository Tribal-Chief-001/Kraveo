import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

class HostelDropdown extends StatelessWidget {
  final String selectedHostel;
  final ValueChanged<String?> onChanged;
  final List<String> hostelBlocks;

  const HostelDropdown({
    super.key,
    required this.selectedHostel,
    required this.onChanged,
    required this.hostelBlocks,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: const [
            Icon(Icons.location_on, color: AppTheme.primaryEmerald, size: 16),
            SizedBox(width: 4),
            Text(
              'DELIVERING TO',
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w800,
                color: AppTheme.primaryEmerald,
                letterSpacing: 0.5,
              ),
            ),
          ],
        ),
        DropdownButtonHideUnderline(
          child: DropdownButton<String>(
            value: selectedHostel,
            isDense: true,
            icon: const Icon(Icons.keyboard_arrow_down, size: 18, color: AppTheme.textDark),
            style: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w800,
              color: AppTheme.textDark,
            ),
            onChanged: onChanged,
            items: hostelBlocks.map((hostel) {
              return DropdownMenuItem(
                value: hostel,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.location_city, size: 16, color: AppTheme.textMuted),
                    const SizedBox(width: 6),
                    Text(hostel),
                  ],
                ),
              );
            }).toList(),
          ),
        ),
      ],
    );
  }
}
