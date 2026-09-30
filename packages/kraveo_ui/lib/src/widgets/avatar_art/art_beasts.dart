import 'dart:math' as math;
import 'dart:ui';

import 'art_kit.dart';

/// 4 - Airavata: white elephant, frontal, big soft ears, curved tusks, small gold headpiece.
void paintAiravata(Canvas c) {
  // ears
  mirrored(c, (c) {
    fill(c, blob([36, 24, 12, 16, 2, 42, 8, 70, 30, 72, 38, 52]), Hue.mist);
    fill(c, blob([33, 32, 17, 28, 11, 44, 15, 62, 29, 63, 34, 50]), Hue.roseSoft);
  });
  // shoulders + gold cloth
  fill(c, blob([16, 106, 20, 88, 50, 80, 80, 88, 84, 106]), Hue.snow);
  fill(c, poly([22, 106, 50, 91, 78, 106, 67, 106, 50, 98, 33, 106]), Hue.gold);
  // head
  fill(c, blob([24, 40, 34, 16, 66, 16, 76, 40, 70, 64, 50, 72, 30, 64]), Hue.snow);
  // tusks
  mirrored(c, (c) {
    line(c, Path()..moveTo(36, 62)..cubicTo(30, 80, 16, 80, 13, 64), Hue.cream, 5.5);
  });
  // trunk
  final trunk = Path()
    ..moveTo(38, 48)
    ..cubicTo(38, 70, 40, 92, 50, 92)
    ..cubicTo(60, 92, 62, 70, 62, 48)
    ..close();
  fill(c, trunk, Hue.mist);
  for (final y in const [60.0, 69.0, 78.0]) {
    line(c, Path()..moveTo(43, y)..quadraticBezierTo(50, y + 3.5, 57, y), Hue.white.withValues(alpha: .85), 1.8);
  }
  // gold forehead cloth
  final cap = Path()
    ..moveTo(33, 34)
    ..quadraticBezierTo(50, 18, 67, 34)
    ..lineTo(60, 45)
    ..quadraticBezierTo(50, 37, 40, 45)
    ..close();
  fill(c, cap, Hue.gold);
  dot(c, 50, 35, 3.6, Hue.forestMid);
  mirrored(c, (c) {
    bead(c, 34, 52, 3.4);
    blush(c, 30, 60, 4, Hue.rose);
  });
}

/// 5 - Nandi: calm white bull, frontal, upswept horns, nose ring, bell collar.
void paintNandi(Canvas c) {
  // horns
  mirrored(c, (c) {
    final h = Path()..moveTo(33, 36)..cubicTo(14, 40, 8, 26, 14, 8);
    line(c, h, Hue.goldDeep, 9);
    line(c, h, Hue.sandSoft, 4.5);
  });
  // ears
  mirrored(c, (c) {
    at(c, 22, 46, -84, (c) => fill(c, drop(22, 17), Hue.mist));
    at(c, 22, 45.5, -84, (c) => fill(c, drop(14, 9), Hue.roseSoft));
  });
  // bust
  fill(c, blob([20, 106, 24, 88, 50, 82, 76, 88, 80, 106]), Hue.snow);
  // head
  fill(c, blob([28, 30, 50, 22, 72, 30, 69, 52, 64, 72, 50, 80, 36, 72, 31, 52]), Hue.snow);
  // forehead curl
  line(c, Path()..moveTo(43, 30)..quadraticBezierTo(50, 38, 57, 30), Hue.mist, 3.2);
  // muzzle
  oval(c, 50, 69, 15.5, 10.5, Hue.roseSoft);
  mirrored(c, (c) => oval(c, 44, 68.5, 2, 3, Hue.terracottaDeep));
  line(c, Path()..addArc(Rect.fromCircle(center: const Offset(50, 76.5), radius: 4.2), 0, math.pi * 2), Hue.goldDeep, 1.8);
  // calm closed eyes
  mirrored(c, (c) {
    final p = Path()..moveTo(34, 48)..quadraticBezierTo(40, 54, 46, 48);
    line(c, p, Hue.ink, 2.6);
    blush(c, 35.5, 57, 4.5, Hue.terracotta);
  });
  // collar with bell
  line(c, Path()..moveTo(26, 92)..quadraticBezierTo(50, 104, 74, 92), Hue.terracotta, 5);
  dot(c, 50, 98, 5, Hue.gold);
  rrect(c, 48.6, 99, 51.4, 103.5, 1.4, Hue.goldDeep);
}

/// 9 - Kamadhenu: gentle cream cow, small wings, patch over one eye, gold horns.
void paintKamadhenu(Canvas c) {
  // little wings
  mirrored(c, (c) {
    at(c, 34, 50, -70, (c) => fill(c, drop(34, 14), Hue.mist));
    at(c, 34, 50, -46, (c) => fill(c, drop(38, 16), Hue.white));
    at(c, 34, 50, -22, (c) => fill(c, drop(32, 14), Hue.snow));
  });
  // ears
  mirrored(c, (c) {
    at(c, 24, 47, -82, (c) => fill(c, drop(22, 16), Hue.cream));
  });
  at(c, 24, 47, -82, (c) => fill(c, drop(22, 16), const Color(0xFFC98A5E)));
  // horns
  mirrored(c, (c) {
    line(c, Path()..moveTo(37, 31)..quadraticBezierTo(30, 19, 36, 12), Hue.gold, 6.5);
  });
  // bust
  fill(c, blob([20, 106, 24, 88, 50, 82, 76, 88, 80, 106]), Hue.cream);
  // head
  fill(c, blob([30, 30, 50, 24, 70, 30, 69, 52, 64, 72, 50, 80, 36, 72, 31, 52]), Hue.cream);
  // patch over one eye
  fill(c, blob([33, 34, 46, 28, 54, 34, 46, 56, 36, 56, 30, 46]), const Color(0xFFC98A5E));
  fill(c, blob([44, 28, 50, 20, 57, 28, 50, 34]), const Color(0xFFC98A5E));
  // muzzle
  oval(c, 50, 68, 16, 11, Hue.roseSoft);
  mirrored(c, (c) => oval(c, 44, 67, 2, 3, Hue.terracottaDeep));
  smile(c, 50, 73.5, 9, col: Hue.terracottaDeep, sw: 1.8);
  // gentle eyes
  mirrored(c, (c) {
    eye(c, 39, 48, 4.3);
    blush(c, 33, 57, 4.5, Hue.rose);
  });
  // bell
  line(c, Path()..moveTo(26, 92)..quadraticBezierTo(50, 104, 74, 92), Hue.teal, 5);
  dot(c, 50, 98, 5, Hue.gold);
  rrect(c, 48.6, 99, 51.4, 103.5, 1.4, Hue.goldDeep);
}

/// 7 - Sharabha: lion-faced chimera with a hooked beak, feather mane and small wings.
void paintSharabha(Canvas c) {
  // wings
  mirrored(c, (c) {
    at(c, 24, 54, -48, (c) => fill(c, drop(46, 18), Hue.indigo));
    at(c, 24, 54, -76, (c) => fill(c, drop(40, 15), Hue.teal));
  });
  // mane - alternating feather spikes
  for (var i = 0; i < 12; i++) {
    at(c, 50, 54, i * 30.0, (c) => fill(c, drop(i.isEven ? 42 : 36, 15), i.isEven ? Hue.terracotta : Hue.amber));
  }
  dot(c, 50, 54, 29, Hue.terracottaDeep);
  // ears
  mirrored(c, (c) => dot(c, 32, 33, 6.5, Hue.amber));
  // face
  dot(c, 50, 54, 22, Hue.goldSoft);
  mirrored(c, (c) {
    oval(c, 41, 65, 9, 7, Hue.cream);
    eye(c, 41, 49, 5);
    line(c, Path()..moveTo(32, 40)..lineTo(46, 45), Hue.terracottaDeep, 2.8);
  });
  // beak
  final beak = Path()
    ..moveTo(43, 56)
    ..cubicTo(43, 52, 57, 52, 57, 56)
    ..cubicTo(57, 65, 55, 73, 50, 77)
    ..cubicTo(51, 70, 44, 66, 43, 56)
    ..close();
  fill(c, beak, Hue.indigoDeep);
  mirrored(c, (c) => dot(c, 47, 57, 1.2, Hue.goldSoft));
}

/// 8 - Yali: lion with an elephant's trunk and tusks, scalloped mane.
void paintYali(Canvas c) {
  // mane
  for (var i = 0; i < 10; i++) {
    final a = i * math.pi / 5;
    dot(c, 50 + math.sin(a) * 31, 52 - math.cos(a) * 31, 13, i.isEven ? Hue.terracotta : Hue.terracottaDeep);
  }
  dot(c, 50, 52, 32, Hue.terracotta);
  // ears
  mirrored(c, (c) {
    dot(c, 30, 30, 8, Hue.goldSoft);
    dot(c, 30, 30, 4.5, Hue.terracottaSoft);
  });
  // face
  dot(c, 50, 52, 24, Hue.goldSoft);
  // tusks
  mirrored(c, (c) {
    fill(c, Path()..moveTo(38, 66)..cubicTo(28, 68, 25, 78, 29, 85)..cubicTo(33, 79, 38, 76, 44, 74)..close(), Hue.white);
  });
  // trunk
  final trunk = Path()
    ..moveTo(50, 46)
    ..cubicTo(50, 70, 48, 82, 60, 88)
    ..cubicTo(70, 92, 76, 82, 68, 78);
  line(c, trunk, Hue.amber, 13);
  dot(c, 68, 78, 1.8, Hue.terracottaDeep);
  mirrored(c, (c) {
    bead(c, 40.5, 46, 4.2);
    line(c, Path()..moveTo(32, 37)..lineTo(46, 42), Hue.terracottaDeep, 2.8);
  });
}
