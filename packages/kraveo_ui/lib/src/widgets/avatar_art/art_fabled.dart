import 'dart:ui';

import 'art_kit.dart';

const _fox = Color(0xFFF2782B);

/// 12 - Unicorn: frontal, spiral gold horn, rainbow mane tufts, sleepy sparkle eyes.
void paintUnicorn(Canvas c) {
  // mane tufts behind the face
  mirrored(c, (c) {
    fill(c, blob([36, 22, 18, 30, 10, 58, 16, 88, 30, 72, 34, 50]), Hue.indigo);
    fill(c, blob([36, 24, 24, 34, 18, 58, 22, 78, 30, 62, 34, 48]), Hue.rose);
    fill(c, blob([36, 26, 28, 36, 26, 54, 28, 66, 32, 54]), Hue.teal);
  });
  // ears
  mirrored(c, (c) {
    at(c, 37, 32, -24, (c) => fill(c, drop(24, 12), Hue.snow));
    at(c, 37, 32, -24, (c) => fill(c, drop(15, 6.5), Hue.roseSoft));
  });
  // neck
  fill(c, blob([30, 106, 36, 80, 64, 80, 70, 106]), Hue.snow);
  // face
  fill(c, blob([34, 30, 50, 24, 66, 30, 66, 52, 62, 72, 50, 84, 38, 72, 34, 52]), Hue.snow);
  // horn
  c.save();
  c.clipPath(poly([44, 28, 50, 0, 56, 28]));
  fill(c, poly([44, 28, 50, 0, 56, 28]), Hue.gold);
  for (var i = 0; i < 4; i++) {
    final y = 24.0 - i * 6.5;
    line(c, Path()..moveTo(42, y + 5)..lineTo(58, y - 3), Hue.goldDeep, 2.2);
  }
  c.restore();
  // forelock
  fill(c, blob([44, 28, 52, 26, 60, 34, 52, 42, 54, 32]), Hue.rose);
  // muzzle
  oval(c, 50, 74, 11, 8, Hue.roseSoft);
  mirrored(c, (c) => oval(c, 46, 74, 1.6, 2.4, Hue.terracottaDeep));
  // dreamy eyes with lashes
  mirrored(c, (c) {
    final p = Path()..moveTo(36, 52)..quadraticBezierTo(41.5, 59, 47, 52);
    line(c, p, Hue.ink, 2.8);
    line(c, Path()..moveTo(36, 52)..lineTo(33, 49), Hue.ink, 2);
    blush(c, 38, 62, 4.5, Hue.rose);
  });
  // sparkle
  dot(c, 80, 24, 2.6, Hue.white);
  dot(c, 86, 36, 1.6, Hue.white);
}

/// 15 - Pegasus: white winged horse in profile, flowing mane, gold bridle.
void paintPegasus(Canvas c) {
  c.translate(-4, 2);
  // wing
  at(c, 42, 84, -12, (c) => fill(c, drop(58, 24), Hue.indigoSoft));
  at(c, 42, 84, -34, (c) => fill(c, drop(62, 26), Hue.mist));
  at(c, 42, 84, -56, (c) => fill(c, drop(54, 22), Hue.white));
  // mane
  fill(c, blob([44, 24, 32, 32, 26, 54, 24, 82, 34, 72, 38, 54, 44, 44]), Hue.indigo);
  fill(c, blob([44, 30, 35, 38, 32, 56, 31, 72, 38, 62, 40, 50]), Hue.teal);
  // neck
  fill(c, blob([22, 106, 30, 72, 42, 42, 56, 36, 64, 56, 64, 82, 78, 106]), Hue.snow);
  // ear
  at(c, 50, 28, -4, (c) => fill(c, drop(24, 12), Hue.snow));
  at(c, 50, 28, -4, (c) => fill(c, drop(14, 6), Hue.roseSoft));
  // head
  fill(c, blob([42, 30, 56, 22, 68, 30, 82, 54, 90, 66, 88, 76, 76, 78, 64, 68, 54, 58, 44, 46]), Hue.snow);
  oval(c, 83, 70, 7, 6, Hue.roseSoft);
  // forelock
  fill(c, blob([44, 26, 54, 24, 56, 32, 48, 38]), Hue.indigo);
  // bridle
  line(c, Path()..moveTo(54, 40)..quadraticBezierTo(62, 50, 70, 64), Hue.gold, 2.8);
  line(c, Path()..moveTo(74, 62)..lineTo(77, 78), Hue.gold, 3.2);
  // face
  bead(c, 60, 44, 3.8);
  oval(c, 86, 69, 1.5, 2.3, Hue.terracottaDeep);
  blush(c, 60, 56, 4, Hue.rose);
}

/// 14 - Kitsune: nine-tailed fox; head in front, tail tips fanning behind.
void paintKitsune(Canvas c) {
  // tails (white-tipped)
  for (final t in const [[-58.0, 56.0], [-30.0, 70.0], [30.0, 70.0], [58.0, 56.0]]) {
    at(c, 50, 86, t[0], (c) {
      fill(c, drop(t[1], 22), Hue.amber);
      c.save();
      c.clipRect(Rect.fromLTRB(-30, -t[1] - 4, 30, -t[1] + 15));
      fill(c, drop(t[1], 22), Hue.cream);
      c.restore();
    });
  }
  // head group, slightly smaller so the tails read
  c.save();
  c.translate(50, 94);
  c.scale(0.82);
  c.translate(-50, -94);
  mirrored(c, (c) {
    fill(c, poly([24, 50, 22, 6, 52, 32]), _fox);
    fill(c, poly([22, 6, 33, 20, 20, 26]), Hue.ink);
    fill(c, poly([29, 38, 28, 20, 42, 32]), Hue.cream);
  });
  fill(c, blob([50, 26, 72, 34, 86, 56, 66, 80, 50, 84, 34, 80, 14, 56, 28, 34]), _fox);
  mirrored(c, (c) => fill(c, blob([50, 86, 14, 58, 26, 60, 50, 66]), Hue.cream));
  mirrored(c, (c) {
    line(c, Path()..moveTo(32, 52)..quadraticBezierTo(38, 46, 46, 54), Hue.ink, 3.2);
    line(c, Path()..moveTo(30, 50)..lineTo(22, 45), Hue.terracottaDeep, 2.6);
    line(c, Path()..moveTo(32, 57)..lineTo(24, 58), Hue.terracottaDeep, 2.6);
  });
  dot(c, 50, 69, 3.8, Hue.ink);
  line(c, Path()..moveTo(50, 72)..quadraticBezierTo(46, 77, 42, 75)..moveTo(50, 72)..quadraticBezierTo(54, 77, 58, 75), Hue.ink, 2);
  dot(c, 50, 38, 2.2, Hue.terracottaDeep);
  c.restore();
}
