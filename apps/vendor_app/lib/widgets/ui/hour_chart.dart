import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Simple custom-painted bar chart: one bar per hour, the busiest hour highlighted.
/// No chart package - just rounded rects and a count above each bar.
class VHourChart extends StatelessWidget {
  const VHourChart({super.key, required this.hours, required this.counts, required this.semanticsLabel, this.height = 150});

  /// Hour of day (0-23) for each bar, in display order.
  final List<int> hours;

  /// Number of orders in each hour. Same length as [hours].
  final List<int> counts;
  final String semanticsLabel;
  final double height;

  static String _hour12(int h) => '${h % 12 == 0 ? 12 : h % 12}';
  static String _ampm(int h) => h < 12 ? 'AM' : 'PM';

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final maxCount = counts.fold<int>(0, (a, b) => a > b ? a : b);
    final peak = maxCount == 0 ? -1 : counts.indexOf(maxCount);
    final scaler = MediaQuery.textScalerOf(context);
    return Semantics(
      label: semanticsLabel,
      image: true,
      excludeSemantics: true,
      child: Column(children: [
        SizedBox(
          height: height,
          width: double.infinity,
          child: CustomPaint(
            painter: _BarsPainter(
              counts: counts,
              peak: peak,
              maxCount: maxCount,
              peakColor: k.brand,
              barColor: Color.alphaBlend(k.brand.withValues(alpha: 0.28), k.surface),
              stubColor: k.line,
              labelStyle: KraveoType.headlineSm.copyWith(color: k.ink, fontSize: 18),
              scaler: scaler,
            ),
          ),
        ),
        const SizedBox(height: 8),
        Row(children: [
          for (var i = 0; i < hours.length; i++)
            Expanded(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(_hour12(hours[i]),
                      style: KraveoType.titleMd.copyWith(color: i == peak ? k.brand : k.ink, fontWeight: i == peak ? FontWeight.w800 : FontWeight.w700)),
                ),
                FittedBox(fit: BoxFit.scaleDown, child: Text(_ampm(hours[i]), style: KraveoType.caption.copyWith(color: k.inkMuted))),
              ]),
            ),
        ]),
      ]),
    );
  }
}

class _BarsPainter extends CustomPainter {
  _BarsPainter({
    required this.counts,
    required this.peak,
    required this.maxCount,
    required this.peakColor,
    required this.barColor,
    required this.stubColor,
    required this.labelStyle,
    required this.scaler,
  });

  final List<int> counts;
  final int peak, maxCount;
  final Color peakColor, barColor, stubColor;
  final TextStyle labelStyle;
  final TextScaler scaler;

  @override
  void paint(Canvas canvas, Size size) {
    if (counts.isEmpty) return;
    final slot = size.width / counts.length;
    final barW = (slot * 0.62).clamp(8.0, 46.0);
    const labelRoom = 38.0;
    final maxBarH = size.height - labelRoom;
    for (var i = 0; i < counts.length; i++) {
      final cx = slot * i + slot / 2;
      final c = counts[i];
      final h = c == 0 || maxCount == 0 ? 5.0 : (c / maxCount) * maxBarH;
      final rect = RRect.fromRectAndCorners(
        Rect.fromLTWH(cx - barW / 2, size.height - h, barW, h),
        topLeft: const Radius.circular(10),
        topRight: const Radius.circular(10),
        bottomLeft: const Radius.circular(3),
        bottomRight: const Radius.circular(3),
      );
      canvas.drawRRect(rect, Paint()..color = c == 0 ? stubColor : (i == peak ? peakColor : barColor));
      if (c > 0) {
        final tp = TextPainter(
          text: TextSpan(text: '$c', style: labelStyle.copyWith(color: i == peak ? peakColor : labelStyle.color)),
          textDirection: TextDirection.ltr,
          textScaler: scaler,
          maxLines: 1,
        )..layout(maxWidth: slot);
        tp.paint(canvas, Offset(cx - tp.width / 2, size.height - h - tp.height - 2));
      }
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) =>
      old.counts != counts || old.peak != peak || old.peakColor != peakColor || old.barColor != barColor || old.scaler != scaler;
}
