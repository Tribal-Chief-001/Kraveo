import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/order.dart';
import 'ui/status_map.dart';

/// Stylised route strip: kitchen -> your gate, with the rider marker placed by the order's status.
/// It shows status-driven progress only (no invented distances or timings). When the server
/// forwards the rider's GPS ([liveLocation]) the strip says so and when it was last updated; the
/// marker is not moved by coordinates because the app has no coordinates for the drop gates.
class AnimatedRiderMap extends StatefulWidget {
  final OrderProgressStatus status;
  final String hostel;
  final String dhabaName;
  final RiderLocation? liveLocation;

  const AnimatedRiderMap({
    super.key,
    required this.status,
    required this.hostel,
    required this.dhabaName,
    this.liveLocation,
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

  String get _caption => switch (widget.status) {
        OrderProgressStatus.placed => 'Waiting for the kitchen',
        OrderProgressStatus.accepted => 'Accepted',
        OrderProgressStatus.preparing => 'Being cooked',
        OrderProgressStatus.readyForPickup => 'Ready for pickup',
        OrderProgressStatus.pickedUp => 'On the way',
        OrderProgressStatus.arrivedAtGate => 'At your gate',
        OrderProgressStatus.delivered => 'Delivered',
        OrderProgressStatus.cancelled => 'Cancelled',
      };

  static String _liveLabel(RiderLocation loc) {
    final age = DateTime.now().difference(loc.receivedAt);
    if (age.inSeconds < 60) return 'GPS live';
    return 'GPS ${age.inMinutes} min ago';
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final statusColor = widget.status.kStatus.color;
    const night = KraveoPalette.g950;

    return Container(
      height: 188,
      width: double.infinity,
      decoration: BoxDecoration(
        color: night,
        borderRadius: BorderRadius.circular(KRadius.xl),
        boxShadow: KShadow.soft(k.shadowTint),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(KRadius.xl),
        child: AnimatedBuilder(
          animation: _animation,
          builder: (context, child) {
            final progress = _animation.value.clamp(0.0, 1.0);
            return Stack(children: [
              Positioned.fill(child: CustomPaint(painter: _MapPainter(progress: progress, trackColor: KraveoPalette.g700, activeColor: statusColor))),
              Positioned(
                top: 14,
                left: 14,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                  decoration: BoxDecoration(color: statusColor.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(KRadius.pill)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(LucideIcons.navigation, size: 14, color: statusColor),
                    const SizedBox(width: 6),
                    Text(_caption, style: KraveoType.label.copyWith(color: Colors.white, fontSize: 12.5)),
                  ]),
                ),
              ),
              if (widget.liveLocation != null)
                Positioned(
                  top: 14,
                  right: 14,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                    decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(KRadius.pill)),
                    child: Text(_liveLabel(widget.liveLocation!), style: KraveoType.label.copyWith(color: Colors.white, fontSize: 11.5)),
                  ),
                ),
              // Start pin: kitchen
              Positioned(left: 20, bottom: 14, width: 92, child: _Pin(icon: LucideIcons.store, label: widget.dhabaName, color: KraveoPalette.g400)),
              // End pin: gate
              Positioned(right: 20, bottom: 14, width: 92, child: _Pin(icon: LucideIcons.doorOpen, label: widget.hostel, color: statusColor)),
              // Rider
              Positioned.fill(
                child: LayoutBuilder(builder: (context, constraints) {
                  const startX = 50.0;
                  final endX = constraints.maxWidth - 90.0;
                  final x = startX + (endX - startX) * progress;
                  return Stack(children: [
                    Positioned(
                      left: x,
                      top: constraints.maxHeight / 2 - 8,
                      child: Container(
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          color: statusColor,
                          shape: BoxShape.circle,
                          boxShadow: [BoxShadow(color: statusColor.withValues(alpha: 0.55), blurRadius: 16, spreadRadius: 1)],
                        ),
                        child: const Icon(LucideIcons.bike, size: 20, color: Colors.white),
                      ),
                    ),
                  ]);
                }),
              ),
            ]);
          },
        ),
      ),
    );
  }
}

class _Pin extends StatelessWidget {
  const _Pin({required this.icon, required this.label, required this.color});

  final IconData icon;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Column(mainAxisSize: MainAxisSize.min, children: [
      Container(
        width: 30,
        height: 30,
        decoration: BoxDecoration(color: color.withValues(alpha: 0.25), shape: BoxShape.circle, border: Border.all(color: color, width: 1.6)),
        child: Icon(icon, size: 15, color: Colors.white),
      ),
      const SizedBox(height: 4),
      Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: KraveoType.caption.copyWith(color: Colors.white.withValues(alpha: 0.75), fontSize: 11)),
    ]);
  }
}

class _MapPainter extends CustomPainter {
  _MapPainter({required this.progress, required this.trackColor, required this.activeColor});

  final double progress;
  final Color trackColor;
  final Color activeColor;

  @override
  void paint(Canvas canvas, Size size) {
    final grid = Paint()
      ..color = Colors.white.withValues(alpha: 0.05)
      ..strokeWidth = 1.0;
    for (double i = 0; i < size.width; i += 30) {
      canvas.drawLine(Offset(i, 0), Offset(i, size.height), grid);
    }
    for (double j = 0; j < size.height; j += 30) {
      canvas.drawLine(Offset(0, j), Offset(size.width, j), grid);
    }

    final y = size.height / 2 + 12;
    final start = Offset(70, y);
    final end = Offset(size.width - 70, y);
    final track = Paint()
      ..color = trackColor.withValues(alpha: 0.9)
      ..strokeWidth = 5
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    final active = Paint()
      ..color = activeColor
      ..strokeWidth = 5
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;

    canvas.drawLine(start, end, track);
    canvas.drawLine(start, Offset(start.dx + (end.dx - start.dx) * progress, y), active);
  }

  @override
  bool shouldRepaint(covariant _MapPainter old) => old.progress != progress || old.activeColor != activeColor || old.trackColor != trackColor;
}
