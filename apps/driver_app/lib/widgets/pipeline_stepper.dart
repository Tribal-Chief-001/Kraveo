import 'package:flutter/material.dart';

class PipelineStepper extends StatelessWidget {
  final int currentStep; // 0 to 3
  final ValueChanged<int>? onStepTapped;

  const PipelineStepper({
    super.key,
    required this.currentStep,
    this.onStepTapped,
  });

  static const List<Map<String, dynamic>> steps = [
    {
      'title': '1. NAVIGATE TO DHABA',
      'subtitle': 'FC Night Mess (Gate 1)',
      'icon': Icons.directions_bike,
    },
    {
      'title': '2. CONFIRM PICKUP',
      'subtitle': 'Verify order item list & receipt',
      'icon': Icons.takeout_dining,
    },
    {
      'title': '3. NAVIGATE TO HOSTEL GATE',
      'subtitle': 'Boys Hostel Block 1 (Gate 2)',
      'icon': Icons.map_outlined,
    },
    {
      'title': '4. GATE HANDSHAKE & DELIVER',
      'subtitle': 'Verify 4-digit student OTP',
      'icon': Icons.lock_open_rounded,
    },
  ];

  @override
  Widget build(BuildContext context) {
    const emerald = Color(0xFF00450D);
    const emeraldLight = Color(0xFF91D78A);
    const gold = Color(0xFFFDD400);

    return Column(
      children: [
        // Top Horizontal Step Bar
        Row(
          children: List.generate(steps.length * 2 - 1, (index) {
            if (index.isOdd) {
              // Line separator
              final stepIndex = index ~/ 2;
              final isPassed = currentStep > stepIndex;
              return Expanded(
                child: Container(
                  height: 3,
                  color: isPassed ? emeraldLight : Colors.grey.shade800,
                ),
              );
            }

            // Circle step index
            final stepIndex = index ~/ 2;
            final isCompleted = currentStep > stepIndex;
            final isCurrent = currentStep == stepIndex;

            return GestureDetector(
              onTap: onStepTapped != null ? () => onStepTapped!(stepIndex) : null,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 250),
                width: isCurrent ? 36 : 28,
                height: isCurrent ? 36 : 28,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isCompleted
                      ? emerald
                      : isCurrent
                          ? gold
                          : Colors.grey.shade900,
                  border: Border.all(
                    color: isCompleted
                        ? emeraldLight
                        : isCurrent
                            ? gold
                            : Colors.grey.shade700,
                    width: 2,
                  ),
                  boxShadow: isCurrent
                      ? [
                          BoxShadow(
                            color: gold.withValues(alpha: 0.5),
                            blurRadius: 10,
                          ),
                        ]
                      : [],
                ),
                child: Center(
                  child: isCompleted
                      ? const Icon(Icons.check, color: emeraldLight, size: 16)
                      : Text(
                          '${stepIndex + 1}',
                          style: TextStyle(
                            color: isCurrent
                                ? Colors.black
                                : Colors.grey.shade400,
                            fontWeight: FontWeight.bold,
                            fontSize: isCurrent ? 14 : 12,
                          ),
                        ),
                ),
              ),
            );
          }),
        ),
        const SizedBox(height: 20),

        // List of Steps with highlights for current step
        ...List.generate(steps.length, (index) {
          final isCompleted = currentStep > index;
          final isCurrent = currentStep == index;
          final step = steps[index];

          return Padding(
            padding: const EdgeInsets.only(bottom: 10.0),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 250),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: isCurrent
                    ? emerald.withValues(alpha: 0.25)
                    : isCompleted
                        ? Colors.black26
                        : const Color(0xFF0F141F),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: isCurrent
                      ? gold
                      : isCompleted
                          ? emeraldLight.withValues(alpha: 0.5)
                          : Colors.white10,
                  width: isCurrent ? 2 : 1,
                ),
              ),
              child: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: isCompleted
                          ? emerald
                          : isCurrent
                              ? gold.withValues(alpha: 0.2)
                              : Colors.grey.shade800,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      step['icon'] as IconData,
                      color: isCompleted
                          ? emeraldLight
                          : isCurrent
                              ? gold
                              : Colors.grey,
                      size: 20,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          step['title'] as String,
                          style: TextStyle(
                            color: isCurrent
                                ? gold
                                : isCompleted
                                    ? Colors.white70
                                    : Colors.grey,
                            fontWeight: FontWeight.bold,
                            fontSize: 14,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          step['subtitle'] as String,
                          style: TextStyle(
                            color: isCurrent
                                ? Colors.white
                                : Colors.grey.shade500,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (isCompleted)
                    const Icon(Icons.check_circle, color: emeraldLight, size: 20)
                  else if (isCurrent)
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: gold,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Text(
                        'ACTIVE',
                        style: TextStyle(
                          color: Colors.black,
                          fontSize: 10,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          );
        }),
      ],
    );
  }
}
