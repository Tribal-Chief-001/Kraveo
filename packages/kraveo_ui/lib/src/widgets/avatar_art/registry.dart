import 'dart:ui';

import '../../tokens/colors.dart';
import 'art_beasts.dart';
import 'art_birds.dart';
import 'art_fabled.dart';
import 'art_kit.dart';
import 'art_scaled.dart';

/// One built-in avatar: a name, a soft badge colour and the drawing routine.
class AvatarSpec {
  const AvatarSpec(this.name, this.bg, this.paint);
  final String name;
  final Color bg;
  final void Function(Canvas canvas) paint;
}

/// Avatar id (1-based) -> spec. Index 0 is id 1.
const List<AvatarSpec> kAvatarSpecs = [
  AvatarSpec('Garuda', Color(0xFFBDE6C2), paintGaruda),
  AvatarSpec('Naga', Color(0xFFFFEFB3), paintNaga),
  AvatarSpec('Makara', Color(0xFFD3D1F4), paintMakara),
  AvatarSpec('Airavata', Color(0xFFA9DCD6), paintAiravata),
  AvatarSpec('Nandi', Color(0xFFF6CDB8), paintNandi),
  AvatarSpec('Hamsa', Color(0xFFB5B2EA), paintHamsa),
  AvatarSpec('Sharabha', Color(0xFFF8EDD0), paintSharabha),
  AvatarSpec('Yali', Color(0xFFD5EFD8), paintYali),
  AvatarSpec('Kamadhenu', Color(0xFFF9D0DB), paintKamadhenu),
  AvatarSpec('Phoenix', Color(0xFF8E8BDD), paintPhoenix),
  AvatarSpec('Dragon', Color(0xFFFFE9A0), paintDragon),
  AvatarSpec('Unicorn', Color(0xFFBFE6E0), paintUnicorn),
  AvatarSpec('Griffin', Color(0xFFF1C7A8), paintGriffin),
  AvatarSpec('Kitsune', Color(0xFF9FD8D0), paintKitsune),
  AvatarSpec('Pegasus', Color(0xFF6FA8DC), paintPegasus),
];

/// Neutral silhouette used for unknown / unset ids.
void paintSilhouette(Canvas c) {
  const tone = Color(0xFFBDB6A2);
  dot(c, 50, 38, 15, tone);
  fill(c, blob([20, 108, 24, 76, 50, 62, 76, 76, 80, 108]), tone);
}

bool isValidAvatarId(int? id) => id != null && id >= 1 && id <= kAvatarSpecs.length;

/// Draws avatar [id] (1-based; null or out of range = placeholder) filling [size].
void paintAvatar(Canvas canvas, Size size, int? id) {
  canvas.save();
  canvas.scale(size.shortestSide / 100);
  final valid = isValidAvatarId(id);
  canvas.drawRect(const Rect.fromLTWH(0, 0, 100, 100), Paint()..color = valid ? kAvatarSpecs[id! - 1].bg : KraveoPalette.sand);
  // subtle radial highlight, top-left
  canvas.drawRect(
    const Rect.fromLTWH(0, 0, 100, 100),
    Paint()
      ..shader = Gradient.radial(const Offset(28, 20), 95, const [Color(0x59FFFFFF), Color(0x00FFFFFF)]),
  );
  if (valid) {
    kAvatarSpecs[id! - 1].paint(canvas);
  } else {
    paintSilhouette(canvas);
  }
  canvas.restore();
}
