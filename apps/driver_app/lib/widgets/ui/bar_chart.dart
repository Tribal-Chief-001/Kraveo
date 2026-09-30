import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

/// Simple painted bar chart (no chart package). Tap a bar to select it.
class KBarChart extends StatelessWidget {
  const KBarChart({super.key, required this.values, required this.labels, required this.selected, required this.onSelect, this.height = 150})
      : assert(values.length == labels.length);

  final List<double> values;
  final List<String> labels;
  final int selected;
  final ValueChanged<int> onSelect;
  final double height;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return LayoutBuilder(builder: (context, c) {
      void pick(Offset p) {
        if (values.isEmpty || c.maxWidth <= 0) return;
        final i = (p.dx / c.maxWidth * values.length).floor().clamp(0, values.length - 1);
        if (i != selected) onSelect(i);
      }

      return Semantics(
        label: 'Earnings chart. Selected ${labels[selected]}.',
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (d) => pick(d.localPosition),
          onHorizontalDragUpdate: (d) => pick(d.localPosition),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            SizedBox(
              height: height,
              width: double.infinity,
              child: CustomPaint(
                painter: _BarPainter(
                  values: values,
                  selected: selected,
                  base: k.brand.withValues(alpha: 0.35),
                  highlight: k.accent,
                  grid: k.line,
                ),
              ),
            ),
            const SizedBox(height: 8),
            Row(children: [
              for (var i = 0; i < labels.length; i++)
                Expanded(
                  child: Text(
                    labels[i],
                    textAlign: TextAlign.center,
                    maxLines: 1,
                    overflow: TextOverflow.clip,
                    softWrap: false,
                    style: KraveoType.label.copyWith(color: i == selected ? k.ink : k.inkFaint),
                  ),
                ),
            ]),
          ]),
        ),
      );
    });
  }
}

class _BarPainter extends CustomPainter {
  _BarPainter({required this.values, required this.selected, required this.base, required this.highlight, required this.grid});

  final List<double> values;
  final int selected;
  final Color base, highlight, grid;

  @override
  void paint(Canvas canvas, Size size) {
    final maxV = values.fold<double>(0, (m, v) => v > m ? v : m);
    final slot = size.width / values.length;
    final barW = (slot * 0.56).clamp(8.0, 36.0);
    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (var g = 0; g <= 2; g++) {
      final y = size.height * g / 2;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), gridPaint);
    }
    for (var i = 0; i < values.length; i++) {
      final f = maxV <= 0 ? 0.0 : values[i] / maxV;
      final h = (size.height - 8) * f;
      final left = slot * i + (slot - barW) / 2;
      final rect = RRect.fromRectAndRadius(
        Rect.fromLTWH(left, size.height - h.clamp(6.0, size.height), barW, h.clamp(6.0, size.height)),
        const Radius.circular(10),
      );
      canvas.drawRRect(rect, Paint()..color = i == selected ? highlight : base);
    }
  }

  @override
  bool shouldRepaint(_BarPainter old) => old.values != values || old.selected != selected || old.base != base || old.highlight != highlight;
}
