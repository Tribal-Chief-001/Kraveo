import 'dart:ui';

import 'art_kit.dart';

const _flame = Color(0xFFE8452C);

/// 1 - Garuda: golden eagle-like bird, frontal, red crest and folded wings.
void paintGaruda(Canvas c) {
  mirrored(c, (c) {
    fill(c, blob([32, 82, 8, 62, 6, 30, 22, 40, 34, 58]), Hue.terracotta);
    fill(c, blob([32, 82, 15, 64, 14, 44, 25, 52, 34, 64]), Hue.terracottaDeep);
  });
  at(c, 50, 38, 0, (c) => fill(c, drop(32, 15), Hue.terracotta));
  mirrored(c, (c) {
    at(c, 40, 40, -32, (c) => fill(c, drop(24, 11), Hue.amber));
    at(c, 33, 44, -58, (c) => fill(c, drop(18, 9), Hue.terracotta));
  });
  // chest + collar
  fill(c, blob([16, 106, 18, 84, 36, 70, 50, 76, 64, 70, 82, 84, 84, 106]), Hue.gold);
  fill(c, poly([31, 72, 50, 92, 69, 72, 63, 69, 50, 80, 37, 69]), Hue.forestMid);
  dot(c, 50, 88, 3.4, Hue.goldSoft);
  // head
  dot(c, 50, 48, 24, Hue.gold);
  mirrored(c, (c) => oval(c, 41.5, 53, 10.5, 12, Hue.cream));
  mirrored(c, (c) {
    eye(c, 41, 48, 5.2);
    line(c, Path()..moveTo(31, 38)..lineTo(46, 43), Hue.ink, 2.8);
  });
  // hooked beak
  final beak = Path()
    ..moveTo(42.5, 55)
    ..cubicTo(42.5, 50, 57.5, 50, 57.5, 55)
    ..cubicTo(57.5, 64, 54.5, 72, 49, 75)
    ..cubicTo(50.5, 69, 43.5, 64, 42.5, 55)
    ..close();
  fill(c, beak, Hue.terracotta);
  mirrored(c, (c) => dot(c, 47, 55.5, 1.2, Hue.terracottaDeep));
}

/// 6 - Hamsa: elegant white swan in profile, facing right.
void paintHamsa(Canvas c) {
  // water ripples
  line(c, Path()..moveTo(6, 92)..quadraticBezierTo(18, 86, 30, 92), Hue.white.withValues(alpha: .55), 2.4);
  line(c, Path()..moveTo(70, 94)..quadraticBezierTo(84, 88, 96, 94), Hue.white.withValues(alpha: .55), 2.4);
  // body + tail
  fill(c, blob([8, 84, 26, 68, 58, 66, 80, 76, 92, 70, 84, 92, 50, 100, 18, 98]), Hue.white);
  // folded wing
  fill(c, blob([28, 80, 40, 70, 62, 72, 74, 82, 56, 90, 36, 90]), Hue.mist);
  fill(c, blob([36, 84, 46, 77, 62, 79, 66, 84, 52, 88]), Hue.indigoSoft);
  // neck
  final neck = Path()
    ..moveTo(32, 80)
    ..cubicTo(14, 62, 46, 62, 42, 42)
    ..cubicTo(40, 30, 54, 30, 58, 30);
  line(c, neck, Hue.white, 13);
  // head
  dot(c, 58, 30, 10, Hue.white);
  fill(c, poly([64, 25, 86, 33, 66, 40]), Hue.terracotta);
  fill(c, poly([64, 25, 69, 25, 69, 40, 66, 40]), Hue.ink);
  bead(c, 60, 28, 2.7);
  blush(c, 57, 35, 4, Hue.rose);
}

/// 10 - Phoenix: fire bird in profile, plume of flames trailing behind.
void paintPhoenix(Canvas c) {
  // trailing flames behind (left)
  at(c, 40, 76, -38, (c) => fill(c, drop(62, 26), _flame));
  at(c, 40, 76, -62, (c) => fill(c, drop(54, 20), Hue.amber));
  at(c, 42, 78, -16, (c) => fill(c, drop(54, 18), Hue.terracotta));
  at(c, 40, 76, -38, (c) => fill(c, drop(38, 14), Hue.gold));
  // body
  fill(c, blob([30, 104, 32, 78, 48, 60, 68, 62, 78, 78, 82, 104]), Hue.amber);
  // chest flames
  at(c, 62, 106, 0, (c) => fill(c, drop(32, 22), Hue.gold));
  at(c, 62, 106, 0, (c) => fill(c, drop(20, 12), Hue.cream));
  // crest flames
  at(c, 54, 38, -40, (c) => fill(c, drop(30, 11), _flame));
  at(c, 58, 36, -12, (c) => fill(c, drop(32, 12), Hue.gold));
  at(c, 62, 36, 18, (c) => fill(c, drop(24, 9), Hue.amber));
  // head
  dot(c, 62, 46, 16, Hue.amber);
  blush(c, 57, 54, 4.5, _flame);
  fill(c, poly([74, 40, 92, 50, 74, 57]), Hue.gold);
  fill(c, poly([74, 40, 92, 50, 75, 48]), Hue.goldDeep);
  bead(c, 64, 43, 3.5);
}

/// 13 - Griffin: white eagle head, swept tufted ears, lion-gold body with feather ruff, raised wing.
void paintGriffin(Canvas c) {
  // wing (rises behind, on the side away from the beak)
  at(c, 34, 76, -8, (c) => fill(c, drop(54, 22), Hue.terracotta));
  at(c, 34, 76, -30, (c) => fill(c, drop(56, 22), Hue.terracottaDeep));
  at(c, 34, 76, -52, (c) => fill(c, drop(46, 18), Hue.terracotta));
  // lion-gold shoulder
  fill(c, blob([26, 106, 26, 80, 42, 64, 68, 66, 86, 84, 90, 106]), Hue.amber);
  // feather ruff: two tidy scalloped rows
  for (var i = 0; i < 5; i++) {
    dot(c, 34.0 + i * 8.5, 72.0 + (i == 0 || i == 4 ? 3 : 0), 7, Hue.snow);
  }
  for (var i = 0; i < 4; i++) {
    dot(c, 38.0 + i * 8.5, 81, 7, Hue.cream);
  }
  // ears
  at(c, 54, 34, 24, (c) => fill(c, drop(30, 12), Hue.amber));
  at(c, 46, 30, -6, (c) => fill(c, drop(27, 11), Hue.goldDeep));
  // head
  dot(c, 46, 47, 20, Hue.snow);
  // beak (faces right)
  final beak = Path()
    ..moveTo(60, 36)
    ..cubicTo(72, 33, 85, 40, 85, 58)
    ..cubicTo(80, 54, 75, 55, 71, 61)
    ..lineTo(62, 58)
    ..close();
  fill(c, beak, Hue.gold);
  fill(c, poly([71, 61, 62, 58, 61, 63, 68, 65]), Hue.goldDeep);
  // eye
  dot(c, 55, 44, 6.4, Hue.gold);
  bead(c, 56, 44, 3.8);
  line(c, Path()..moveTo(64, 34)..lineTo(48, 39), Hue.ink, 3);
  blush(c, 50, 55, 4.4, Hue.terracotta);
}
