import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vendor_app/services/audio_alert_service.dart';

class FakeAlarmPlayer implements AlarmPlayer {
  FakeAlarmPlayer(this.owner);
  final FakeAlarmPlayers owner;
  final List<String> played = [];
  bool active = false;
  bool stopped = false;
  bool disposed = false;
  bool failToPlay = false;

  @override
  bool get isActive => active && !disposed;

  @override
  Future<void> playLooping(String assetPath) async {
    if (failToPlay) throw PlatformException(code: 'asset');
    played.add(assetPath);
    active = true;
  }

  @override
  Future<void> stop() async {
    stopped = true;
    active = false;
  }

  @override
  Future<void> dispose() async => disposed = true;
}

class FakeAlarmPlayers {
  final List<FakeAlarmPlayer> created = [];
  bool failToPlay = false;

  AlarmPlayer create() {
    final p = FakeAlarmPlayer(this)..failToPlay = failToPlay;
    created.add(p);
    return p;
  }

  int get alive => created.where((p) => !p.disposed).length;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeAlarmPlayers players;
  late AlarmPlayer Function() original;

  setUp(() {
    original = AudioAlertService.playerFactory;
    players = FakeAlarmPlayers();
    AudioAlertService.playerFactory = players.create;
  });

  tearDown(() async {
    await AudioAlertService.stopAlarm();
    AudioAlertService.playerFactory = original;
  });

  test('the alarm plays the bundled asset (no network source)', () async {
    await AudioAlertService.startLoudAlarm();
    expect(AudioAlertService.isPlaying, isTrue);
    expect(players.created, hasLength(1));
    expect(players.created.single.played, ['audio/new_order_alarm.ogg']);
    expect(AudioAlertService.alarmAsset, 'audio/new_order_alarm.ogg');
  });

  test('the asset file exists, is declared in pubspec and is the same tone as the Android channel sound', () {
    final asset = File('assets/audio/new_order_alarm.ogg');
    expect(asset.existsSync(), isTrue);
    expect(asset.lengthSync(), lessThan(700 * 1024));
    expect(File('pubspec.yaml').readAsStringSync(), contains('assets/audio/new_order_alarm.ogg'));
    expect(File('android/app/src/main/res/raw/new_order_alarm.ogg').readAsBytesSync(), asset.readAsBytesSync());
  });

  test('starting while it already rings does nothing; stopping releases the player', () async {
    await AudioAlertService.startLoudAlarm();
    await AudioAlertService.startLoudAlarm();
    expect(players.created, hasLength(1));
    await AudioAlertService.stopAlarm();
    expect(AudioAlertService.isPlaying, isFalse);
    expect(players.created.single.stopped, isTrue);
    expect(players.created.single.disposed, isTrue);
    await AudioAlertService.stopAlarm(); // stopping twice is harmless
  });

  test('start, stop, start in a row never leaves a second player ringing', () async {
    final first = AudioAlertService.startLoudAlarm();
    final stop = AudioAlertService.stopAlarm();
    final second = AudioAlertService.startLoudAlarm();
    await Future.wait([first, stop, second]);
    expect(AudioAlertService.isPlaying, isTrue);
    expect(players.alive, lessThanOrEqualTo(1));
    await AudioAlertService.stopAlarm();
    expect(players.alive, 0);
  });

  test('a player that cannot start leaves the alarm marked ringing (system beep + watchdog retry), never silently off', () async {
    players.failToPlay = true;
    await AudioAlertService.startLoudAlarm();
    expect(AudioAlertService.isPlaying, isTrue);
    await AudioAlertService.stopAlarm();
    expect(players.alive, 0);
  });

  testWidgets('watchdog: a healthy alarm is left alone, a stopped one is brought back', (tester) async {
    await AudioAlertService.startLoudAlarm();
    await tester.pump(const Duration(seconds: 5));
    expect(players.created, hasLength(1)); // still playing: nothing to do

    players.created.single.active = false; // e.g. another app took audio focus
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(players.created, hasLength(2));
    expect(players.created.last.played, ['audio/new_order_alarm.ogg']);
    expect(players.created.first.disposed, isTrue);

    await AudioAlertService.stopAlarm();
    await tester.pump(const Duration(seconds: 5));
    expect(players.created, hasLength(2)); // stopped for good
    expect(players.alive, 0);
  });
}
