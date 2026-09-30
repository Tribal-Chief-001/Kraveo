import 'dart:ui';

import 'art_kit.dart';

/// 2 - Naga: hooded cobra, frontal, belly scutes, forked tongue.
void paintNaga(Canvas c) {
  // hood
  final hood = blob([50, 4, 76, 14, 90, 40, 80, 64, 60, 82, 50, 100, 40, 82, 20, 64, 10, 40, 24, 14]);
  fill(c, hood, Hue.forest);
  c.save();
  c.translate(50, 48);
  c.scale(0.8);
  c.translate(-50, -48);
  fill(c, hood, Hue.forestMid);
  c.restore();
  // hood pattern
  mirrored(c, (c) {
    dot(c, 26, 38, 3.2, Hue.goldSoft);
    dot(c, 29, 52, 2.6, Hue.goldSoft);
    dot(c, 36, 64, 2.2, Hue.goldSoft);
  });
  // belly scutes
  for (var i = 0; i < 4; i++) {
    final w = 26.0 - i * 4.0;
    rrect(c, 50 - w / 2, 70.0 + i * 8.5, 50 + w / 2, 77.0 + i * 8.5, 3.5, Hue.goldSoft);
  }
  // head
  fill(c, blob([50, 20, 66, 28, 70, 46, 62, 62, 50, 66, 38, 62, 30, 46, 34, 28]), Hue.leaf);
  mirrored(c, (c) {
    dot(c, 41, 42, 5.6, Hue.gold);
    oval(c, 41, 42, 1.5, 4.6, Hue.ink);
    dot(c, 45.5, 57, 1.1, Hue.forest);
    line(c, Path()..moveTo(32, 33)..lineTo(45, 38), Hue.forest, 2.6);
  });
  // tongue
  final t = Path()
    ..moveTo(50, 63)
    ..lineTo(50, 72)
    ..moveTo(50, 72)
    ..lineTo(46, 78)
    ..moveTo(50, 72)
    ..lineTo(54, 78);
  line(c, t, Hue.rose, 2.4);
}

/// 3 - Makara: crocodile jaws with a curled elephant trunk, big ear and crest; profile facing right.
void paintMakara(Canvas c) {
  c.translate(-2, 6);
  // body / neck
  fill(c, blob([2, 106, 6, 76, 24, 58, 44, 64, 60, 84, 64, 106]), Hue.tealDeep);
  for (final p in const [[18.0, 86.0], [32.0, 94.0], [16.0, 100.0], [46.0, 100.0], [30.0, 76.0]]) {
    line(c, Path()..moveTo(p[0] - 4, p[1])..quadraticBezierTo(p[0], p[1] - 4, p[0] + 4, p[1]), Hue.teal, 2);
  }
  // crest
  for (var i = 0; i < 4; i++) {
    at(c, 20.0 + i * 8.5, 46.0 - i * 2.5, -26, (c) => fill(c, drop(18, 10), i.isEven ? Hue.gold : Hue.goldSoft));
  }
  // head (upper jaw)
  fill(c, blob([14, 52, 22, 34, 46, 28, 70, 36, 88, 46, 96, 54, 84, 62, 56, 62, 28, 64]), Hue.teal);
  // elephant ear
  fill(c, blob([22, 38, 12, 24, 26, 14, 42, 26, 40, 42]), Hue.indigo);
  fill(c, blob([24, 36, 18, 26, 27, 20, 37, 28, 36, 38]), Hue.roseSoft);
  // lower jaw
  fill(c, blob([30, 60, 56, 62, 86, 62, 88, 70, 70, 78, 46, 76, 28, 70]), Hue.leaf);
  line(c, Path()..moveTo(34, 62)..lineTo(86, 62), Hue.forest.withValues(alpha: .6), 2);
  // teeth
  for (final x in const [58.0, 67.0, 76.0]) {
    fill(c, poly([x - 3, 62, x + 3, 62, x, 68]), Hue.white);
  }
  // trunk curl
  final trunk = Path()
    ..moveTo(88, 50)
    ..cubicTo(100, 46, 101, 22, 88, 19)
    ..cubicTo(78, 18, 77, 30, 85, 31);
  line(c, trunk, Hue.teal, 10);
  line(c, trunk, Hue.tealSoft.withValues(alpha: .35), 3.5);
  // eye
  eye(c, 50, 45, 6);
  line(c, Path()..moveTo(42, 36)..lineTo(58, 40), Hue.tealDeep, 3);
  blush(c, 40, 57, 4, Hue.rose);
}

/// 11 - Dragon: friendly eastern dragon, frontal, antlers, whiskers, mane.
void paintDragon(Canvas c) {
  // neck + mane
  fill(c, blob([30, 106, 34, 76, 50, 70, 66, 76, 70, 106]), Hue.forestMid);
  for (var i = 0; i < 3; i++) {
    rrect(c, 40.0 + i * 0, 80.0 + i * 8, 60.0, 85.0 + i * 8, 2.5, Hue.leaf);
  }
  // whiskers
  mirrored(c, (c) {
    line(c, Path()..moveTo(34, 64)..cubicTo(18, 62, 8, 72, 10, 88), Hue.gold, 3.2);
    line(c, Path()..moveTo(32, 54)..cubicTo(18, 50, 8, 54, 4, 44), Hue.goldSoft, 2.6);
    dot(c, 10, 88, 3, Hue.gold);
  });
  // antlers
  mirrored(c, (c) {
    line(c, Path()..moveTo(38, 30)..cubicTo(34, 20, 30, 14, 32, 4), Hue.gold, 5);
    line(c, Path()..moveTo(34, 18)..lineTo(24, 14), Hue.gold, 4);
  });
  // fin ears
  mirrored(c, (c) {
    at(c, 27, 50, -74, (c) => fill(c, drop(22, 15), Hue.leaf));
  });
  // head
  fill(c, blob([26, 44, 32, 24, 50, 18, 68, 24, 74, 44, 72, 64, 50, 72, 28, 64]), Hue.forestMid);
  // snout
  oval(c, 50, 62, 19, 12.5, Hue.leaf);
  mirrored(c, (c) => oval(c, 43.5, 58, 2.4, 3.2, Hue.forest));
  smile(c, 50, 67, 12, col: Hue.forest, sw: 2.2);
  // brows + eyes
  mirrored(c, (c) {
    eye(c, 39, 43, 5.4);
    line(c, Path()..moveTo(30, 32)..lineTo(45, 36), Hue.forest, 3.2);
  });
  // forehead pearl-spot
  dot(c, 50, 30, 3.4, Hue.goldSoft);
}
