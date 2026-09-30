import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kraveo_ui/kraveo_ui.dart';

void main() {
  Widget host(Widget child) => MaterialApp(theme: KraveoTheme.customer(), home: Scaffold(body: Center(child: child)));

  testWidgets('KAvatar renders ids 0..16 (valid, placeholder, out of range) without exceptions', (tester) async {
    for (var id = 0; id <= kAvatarCount + 1; id++) {
      await tester.pumpWidget(host(KAvatar(id: id, size: 120)));
      expect(tester.takeException(), isNull, reason: 'id $id');
      await tester.pumpWidget(host(KAvatar(id: id, size: 40, ring: true)));
      expect(tester.takeException(), isNull, reason: 'ring id $id');
    }
    await tester.pumpWidget(host(const KAvatar(id: null)));
    expect(tester.takeException(), isNull);
  });

  testWidgets('KAvatar keeps its requested size, with or without ring', (tester) async {
    await tester.pumpWidget(host(const KAvatar(id: 3, size: 72)));
    expect(tester.getSize(find.byType(KAvatar)), const Size(72, 72));
    await tester.pumpWidget(host(const KAvatar(id: 3, size: 72, ring: true)));
    expect(tester.getSize(find.byType(KAvatar)), const Size(72, 72));
  });

  testWidgets('KAvatar exposes a semantic label per creature and a placeholder label', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(host(const KAvatar(id: 1)));
    expect(find.bySemanticsLabel('Garuda avatar'), findsOneWidget);
    await tester.pumpWidget(host(const KAvatar(id: 15)));
    expect(find.bySemanticsLabel('Pegasus avatar'), findsOneWidget);
    await tester.pumpWidget(host(const KAvatar(id: 99)));
    expect(find.bySemanticsLabel('Avatar placeholder'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('KAvatarPicker shows all avatars and reports the tapped id', (tester) async {
    int? picked;
    await tester.pumpWidget(host(SizedBox(width: 360, child: KAvatarPicker(selectedId: 2, onChanged: (v) => picked = v))));
    expect(find.byType(KAvatar), findsNWidgets(kAvatarCount));
    await tester.tap(find.byType(KAvatar).at(6));
    expect(picked, 7);
  });
}
