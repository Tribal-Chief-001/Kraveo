import 'package:flutter/material.dart';

class DutyToggle extends StatelessWidget {
  final bool isOnline;
  final ValueChanged<bool> onChanged;

  const DutyToggle({
    super.key,
    required this.isOnline,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    const emerald = Color(0xFF00450D);
    const emeraldLight = Color(0xFF91D78A);
    final offlineBg = Colors.red.withValues(alpha: 0.15);
    final offlineText = Colors.redAccent.shade100;

    return GestureDetector(
      onTap: () => onChanged(!isOnline),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 250),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: isOnline ? emerald : offlineBg,
          borderRadius: BorderRadius.circular(24),
          border: Border.all(
            color: isOnline ? emeraldLight : Colors.red.shade400,
            width: 1.5,
          ),
          boxShadow: isOnline
              ? [
                  BoxShadow(
                    color: emeraldLight.withValues(alpha: 0.3),
                    blurRadius: 10,
                    spreadRadius: 1,
                  )
                ]
              : [],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 250),
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: isOnline ? emeraldLight : Colors.red,
                boxShadow: [
                  BoxShadow(
                    color: isOnline ? emeraldLight : Colors.red,
                    blurRadius: isOnline ? 6 : 2,
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              isOnline ? 'DUTY ONLINE' : 'OFFLINE',
              style: TextStyle(
                color: isOnline ? emeraldLight : offlineText,
                fontWeight: FontWeight.w900,
                fontSize: 11,
                letterSpacing: 0.8,
              ),
            ),
            const SizedBox(width: 6),
            Switch.adaptive(
              value: isOnline,
              onChanged: onChanged,
              activeThumbColor: const Color(0xFFFDD400),
              activeTrackColor: const Color(0xFF00450D),
              inactiveThumbColor: Colors.grey.shade400,
              inactiveTrackColor: Colors.black45,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ],
        ),
      ),
    );
  }
}
