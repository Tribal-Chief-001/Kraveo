import 'dart:math' as math;
import 'dart:ui';

import '../../tokens/colors.dart';

/// Shared drawing kit for the built-in avatars.
///
/// Every creature is drawn on a virtual 100 x 100 canvas (the badge is the circle
/// inscribed in it); the caller scales the canvas, so art is resolution independent.
/// Only brand colours plus a small family of complementary tints are used.
class Hue {
  Hue._();

  // Brand
  static const forest = KraveoPalette.g800;
  static const forestMid = KraveoPalette.g600;
  static const leaf = KraveoPalette.g300;
  static const mint = KraveoPalette.g100;
  static const gold = KraveoPalette.y400;
  static const goldSoft = KraveoPalette.y300;
  static const goldDeep = KraveoPalette.y500;
  static const cream = Color(0xFFFFF6DC);

  // Complementary family
  static const terracotta = Color(0xFFD1583A);
  static const terracottaDeep = Color(0xFF9E3B26);
  static const terracottaSoft = Color(0xFFF6CDB8);
  static const amber = Color(0xFFF29A2E);
  static const teal = Color(0xFF1E8C8A);
  static const tealDeep = Color(0xFF136766);
  static const tealSoft = Color(0xFFBFE6E0);
  static const indigo = Color(0xFF4A47A8);
  static const indigoDeep = Color(0xFF2F2D78);
  static const indigoSoft = Color(0xFFD3D1F4);
  static const rose = Color(0xFFDD5C82);
  static const roseSoft = Color(0xFFF9D0DB);
  static const sand = Color(0xFFEFD9A8);
  static const sandSoft = Color(0xFFF8EDD0);

  static const ink = Color(0xFF16241C);
  static const white = Color(0xFFFFFFFF);
  static const snow = Color(0xFFFAF8F3);
  static const mist = Color(0xFFDCDCEE);
}

final Paint _p = Paint()..isAntiAlias = true;

Paint _fillPaint(Color c) => _p
  ..style = PaintingStyle.fill
  ..strokeWidth = 0
  ..color = c;

/// Fill a path.
void fill(Canvas c, Path path, Color col) => c.drawPath(path, _fillPaint(col));

void oval(Canvas c, double cx, double cy, double rx, double ry, Color col) =>
    c.drawOval(Rect.fromCenter(center: Offset(cx, cy), width: rx * 2, height: ry * 2), _fillPaint(col));

void dot(Canvas c, double cx, double cy, double r, Color col) => c.drawCircle(Offset(cx, cy), r, _fillPaint(col));

void rrect(Canvas c, double l, double t, double r, double b, double rad, Color col) =>
    c.drawRRect(RRect.fromLTRBR(l, t, r, b, Radius.circular(rad)), _fillPaint(col));

/// Stroke a path with round caps.
void line(Canvas c, Path path, Color col, double w) => c.drawPath(
    path,
    _p
      ..style = PaintingStyle.stroke
      ..strokeWidth = w
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = col);

/// Smooth closed blob: the points act as control points of a rounded polygon.
Path blob(List<double> xy) {
  final n = xy.length ~/ 2;
  Offset pt(int i) => Offset(xy[(i % n) * 2], xy[(i % n) * 2 + 1]);
  Offset mid(int i) => Offset.lerp(pt(i), pt(i + 1), 0.5)!;
  final path = Path()..moveTo(mid(n - 1).dx, mid(n - 1).dy);
  for (var i = 0; i < n; i++) {
    final m = mid(i);
    path.quadraticBezierTo(pt(i).dx, pt(i).dy, m.dx, m.dy);
  }
  return path..close();
}

/// Sharp polygon.
Path poly(List<double> xy) {
  final path = Path()..moveTo(xy[0], xy[1]);
  for (var i = 2; i < xy.length; i += 2) {
    path.lineTo(xy[i], xy[i + 1]);
  }
  return path..close();
}

/// Leaf / flame / feather shape from base (0,0) up to tip (0,-len), max width [w].
Path drop(double len, double w) => Path()
  ..moveTo(0, 0)
  ..cubicTo(w * 0.75, -len * 0.05, w * 0.7, -len * 0.6, 0, -len)
  ..cubicTo(-w * 0.7, -len * 0.6, -w * 0.75, -len * 0.05, 0, 0)
  ..close();

/// Draw [art] at (x, y) rotated by [deg] (0 = pointing up) and scaled by [s].
void at(Canvas c, double x, double y, double deg, void Function(Canvas) art, {double s = 1}) {
  c.save();
  c.translate(x, y);
  c.rotate(deg * math.pi / 180);
  c.scale(s);
  art(c);
  c.restore();
}

/// Draw [art] as is and mirrored around the vertical centre line.
void mirrored(Canvas c, void Function(Canvas) art) {
  art(c);
  c.save();
  c.translate(100, 0);
  c.scale(-1, 1);
  art(c);
  c.restore();
}

/// Flip the whole drawing horizontally (so profile creatures can face either way).
void flipped(Canvas c, void Function(Canvas) art) {
  c.save();
  c.translate(100, 0);
  c.scale(-1, 1);
  art(c);
  c.restore();
}

/// Cute round eye with highlight.
void eye(Canvas c, double x, double y, double r, {Color iris = Hue.ink, Color white = Hue.white}) {
  dot(c, x, y, r, white);
  dot(c, x + r * 0.08, y + r * 0.1, r * 0.66, iris);
  dot(c, x - r * 0.12, y - r * 0.22, r * 0.24, Hue.white);
}

/// Solid dark eye with highlight (no white).
void bead(Canvas c, double x, double y, double r) {
  dot(c, x, y, r, Hue.ink);
  dot(c, x - r * 0.3, y - r * 0.32, r * 0.3, Hue.white);
}

/// Happy closed-eye arc (upward bow).
void happy(Canvas c, double x, double y, double w, {Color col = Hue.ink, double sw = 2.4}) {
  final p = Path()
    ..moveTo(x - w / 2, y + w * 0.12)
    ..quadraticBezierTo(x, y - w * 0.5, x + w / 2, y + w * 0.12);
  line(c, p, col, sw);
}

/// Gentle smile arc.
void smile(Canvas c, double x, double y, double w, {Color col = Hue.ink, double sw = 2.2}) {
  final p = Path()
    ..moveTo(x - w / 2, y)
    ..quadraticBezierTo(x, y + w * 0.55, x + w / 2, y);
  line(c, p, col, sw);
}

void blush(Canvas c, double x, double y, double r, Color col) => oval(c, x, y, r, r * 0.65, col.withValues(alpha: 0.55));
