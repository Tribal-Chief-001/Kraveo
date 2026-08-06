import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/order.dart';

class AnimatedRiderMap extends StatefulWidget {
  final OrderProgressStatus status;
  final String hostel;
  final String dhabaName;

  const AnimatedRiderMap({
    super.key,
    required this.status,
    required this.hostel,
    required this.dhabaName,
  });

  @override
  State<AnimatedRiderMap> createState() => _AnimatedRiderMapState();
}

class _AnimatedRiderMapState extends State<AnimatedRiderMap> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    _animation = Tween<double>(
      begin: 0.0,
      end: widget.status.progressValue,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));
    _controller.forward();
  }

  @override
  void didUpdateWidget(covariant AnimatedRiderMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.status != widget.status) {
      _animation = Tween<double>(
        begin: _animation.value,
        end: widget.status.progressValue,
      ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));
      _controller.forward(from: 0.0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 180,
      width: double.infinity,
      decoration: BoxDecoration(
        color: const Color(0xFF1E2620), // Dark map aesthetic
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppTheme.borderLight),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.1),
            blurRadius: 10,
            offset: const Offset(0, 4),
          )
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(20),
        child: AnimatedBuilder(
          animation: _animation,
          builder: (context, child) {
            final progress = _animation.value;

            return Stack(
              children: [
                // Simulated Map Grid Background Lines
                CustomPaint(
                  size: Size.infinite,
                  painter: MapGridPainter(progress: progress),
                ),

                // Top Info Badge
                Positioned(
                  top: 12,
                  left: 12,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    decoration: BoxDecoration(
                      color: AppTheme.primaryEmerald,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.navigation, color: AppTheme.secondaryGold, size: 14),
                        const SizedBox(width: 4),
                        Text(
                          progress >= 0.95 ? 'ARRIVED AT GATE' : '${((1 - progress) * 3.5).toStringAsFixed(1)} KM AWAY',
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),

                // Map Pin 1: Dhaba (Start)
                Positioned(
                  left: 24,
                  top: 80,
                  child: Column(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(6),
                        decoration: const BoxDecoration(
                          color: AppTheme.secondaryGold,
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.storefront, color: AppTheme.secondaryTextGold, size: 16),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        widget.dhabaName.split(' ').first,
                        style: const TextStyle(color: Colors.white70, fontSize: 10, fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                ),

                // Map Pin 2: Gate Handshake (End)
                Positioned(
                  right: 24,
                  top: 80,
                  child: Column(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(6),
                        decoration: const BoxDecoration(
                          color: AppTheme.accentGreen,
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.sensor_door, color: Colors.white, size: 16),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        widget.hostel,
                        style: const TextStyle(color: Colors.white70, fontSize: 10, fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                ),

                // Animated Rider Marker
                LayoutBuilder(
                  builder: (context, constraints) {
                    final startX = 40.0;
                    final endX = constraints.maxWidth - 50.0;
                    final currentX = startX + (endX - startX) * progress.clamp(0.0, 1.0);

                    return Positioned(
                      left: currentX,
                      top: 70,
                      child: Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: AppTheme.primaryEmerald,
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: AppTheme.secondaryGold.withValues(alpha: 0.6),
                              blurRadius: 10,
                              spreadRadius: 2,
                            ),
                          ],
                        ),
                        child: const Icon(
                          Icons.two_wheeler,
                          color: AppTheme.secondaryGold,
                          size: 20,
                        ),
                      ),
                    );
                  },
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class MapGridPainter extends CustomPainter {
  final double progress;

  MapGridPainter({required this.progress});

  @override
  void paint(Canvas canvas, Size size) {
    final paintGrid = Paint()
      ..color = Colors.white.withValues(alpha: 0.05)
      ..strokeWidth = 1.0;

    // Draw Grid Lines
    for (double i = 0; i < size.width; i += 30) {
      canvas.drawLine(Offset(i, 0), Offset(i, size.height), paintGrid);
    }
    for (double j = 0; j < size.height; j += 30) {
      canvas.drawLine(Offset(0, j), Offset(size.width, j), paintGrid);
    }

    // Draw Route Path Track
    final pathPaint = Paint()
      ..color = Colors.white24
      ..strokeWidth = 4.0
      ..style = PaintingStyle.stroke;

    final activePathPaint = Paint()
      ..color = AppTheme.secondaryGold
      ..strokeWidth = 4.0
      ..style = PaintingStyle.stroke;

    final start = Offset(40, size.height / 2 + 10);
    final end = Offset(size.width - 40, size.height / 2 + 10);

    canvas.drawLine(start, end, pathPaint);

    final currentX = start.dx + (end.dx - start.dx) * progress.clamp(0.0, 1.0);
    canvas.drawLine(start, Offset(currentX, size.height / 2 + 10), activePathPaint);
  }

  @override
  bool shouldRepaint(covariant MapGridPainter oldDelegate) {
    return oldDelegate.progress != progress;
  }
}
