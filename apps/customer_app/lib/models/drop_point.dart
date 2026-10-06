/// Campus drop points (Docs/19_campus_maps_contract.md section 1).
///
/// The backend (`src/config/campus.ts`) is the source of truth; these constants mirror it so the
/// pickers, the checkout sheet and the tracking map work offline. Several names share one pin on
/// purpose (the blocks are close together).
library;

enum DropGroup { boys, girls }

extension DropGroupX on DropGroup {
  String get label => this == DropGroup.boys ? 'Boys' : 'Girls';
}

/// One place the runner can deliver to. [name] is also the id sent to the server.
class DropPoint {
  const DropPoint(this.name, this.group, this.lat, this.lng);

  final String name;
  final DropGroup group;
  final double lat;
  final double lng;

  @override
  String toString() => 'DropPoint($name)';
}

/// Display and list order is exactly this order.
const List<DropPoint> kDropPoints = [
  DropPoint('BH1', DropGroup.boys, 23.074861, 76.859889),
  DropPoint('BH2', DropGroup.boys, 23.073556, 76.859861),
  DropPoint('BH3', DropGroup.boys, 23.073556, 76.859861),
  DropPoint('BH4', DropGroup.boys, 23.073361, 76.858389),
  DropPoint('BH5', DropGroup.boys, 23.073361, 76.858389),
  DropPoint('Special Block', DropGroup.boys, 23.073361, 76.858389),
  DropPoint('BH6', DropGroup.boys, 23.072750, 76.860000),
  DropPoint('BH7', DropGroup.boys, 23.072889, 76.859222),
  DropPoint('BH8', DropGroup.boys, 23.072889, 76.859222),
  DropPoint('GH1', DropGroup.girls, 23.074778, 76.851972),
  DropPoint('GH2', DropGroup.girls, 23.074917, 76.853194),
];

/// The canonical names, in display order.
final List<String> kDropPointNames = List.unmodifiable([for (final p in kDropPoints) p.name]);

/// The drop point called [name] (canonical or legacy spelling), or null.
DropPoint? dropPointByName(String? name) {
  final canonical = normalizeDropPoint(name);
  if (canonical == null) return null;
  for (final p in kDropPoints) {
    if (p.name == canonical) return p;
  }
  return null;
}

final RegExp _canonicalRe = RegExp(r'^(bh|gh)\s*[-#]?\s*(\d{1,2})$');
final RegExp _legacyBlockRe = RegExp(r'^(?:boys\s+hostel\s+)?block\s*[-#]?\s*(\d{1,2})$');
final RegExp _legacyGateRe = RegExp(r'^girls\s+(?:hostel\s+)?gate\s*[-#]?\s*(\d{1,2})$');

/// Maps what the server (or an older app) has stored onto a canonical drop point name.
///
/// Accepts the canonical names (`BH3`, `GH1`, `Special Block`) and the legacy spellings
/// (`Block 3`, `Boys Hostel Block 3` for 1..6, `Girls Gate 1`, `Girls Hostel Gate 1` for 1..2),
/// case-insensitive and with extra spaces. Everything else (including `VIT Main Gate`) returns
/// null: the student is asked to choose again.
String? normalizeDropPoint(String? raw) {
  final value = (raw ?? '').trim().toLowerCase().replaceAll(RegExp(r'\s+'), ' ');
  if (value.isEmpty) return null;
  if (value == 'special block') return 'Special Block';

  final canonical = _canonicalRe.firstMatch(value);
  if (canonical != null) {
    final n = int.parse(canonical.group(2)!);
    if (canonical.group(1) == 'bh') return n >= 1 && n <= 8 ? 'BH$n' : null;
    return n >= 1 && n <= 2 ? 'GH$n' : null;
  }
  final block = _legacyBlockRe.firstMatch(value);
  if (block != null) {
    final n = int.parse(block.group(1)!);
    return n >= 1 && n <= 6 ? 'BH$n' : null;
  }
  final gate = _legacyGateRe.firstMatch(value);
  if (gate != null) {
    final n = int.parse(gate.group(1)!);
    return n >= 1 && n <= 2 ? 'GH$n' : null;
  }
  return null;
}

/// How to show a stored drop point: the canonical name when it can be recognised ("Block 3" ->
/// "BH3"), otherwise the stored text as is.
String displayDropPoint(String? raw) => normalizeDropPoint(raw) ?? (raw ?? '').trim();
