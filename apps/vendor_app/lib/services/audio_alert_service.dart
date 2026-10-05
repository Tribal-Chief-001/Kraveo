import 'dart:async';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// One looping alarm sound. A small seam over the audio plugin so tests can see which sound is played.
abstract class AlarmPlayer {
  /// Starts [assetPath] (relative to the app's `assets/` folder) on repeat at full volume.
  Future<void> playLooping(String assetPath);

  /// True while the sound is really coming out of the speaker.
  bool get isActive;

  Future<void> stop();
  Future<void> dispose();
}

class AudioPlayersAlarmPlayer implements AlarmPlayer {
  final AudioPlayer _player = AudioPlayer();

  @override
  bool get isActive => _player.state == PlayerState.playing;

  @override
  Future<void> playLooping(String assetPath) async {
    // Alarm usage: plays at alarm volume and is not silenced by the media or ringer volume.
    await _player.setAudioContext(
      AudioContext(
        android: const AudioContextAndroid(
          audioMode: AndroidAudioMode.normal,
          contentType: AndroidContentType.sonification,
          usageType: AndroidUsageType.alarm,
          audioFocus: AndroidAudioFocus.gainTransientMayDuck,
        ),
        iOS: AudioContextIOS(
          category: AVAudioSessionCategory.playback,
          options: const {AVAudioSessionOptions.duckOthers},
        ),
      ),
    );
    await _player.setVolume(1.0);
    await _player.setReleaseMode(ReleaseMode.loop);
    await _player.play(AssetSource(assetPath));
  }

  @override
  Future<void> stop() => _player.stop();

  @override
  Future<void> dispose() => _player.dispose();
}

/// The loud new-order alarm. The tone is bundled with the app (no network), loops until [stopAlarm],
/// and a watchdog restarts it if the system stops it (audio focus taken by a call, player error).
class AudioAlertService {
  /// Relative to `assets/`; the same tone is the Android `new_orders` channel sound (res/raw/new_order_alarm).
  static const String alarmAsset = 'audio/new_order_alarm.ogg';

  static const Duration _watchdogEvery = Duration(seconds: 2);
  static const Duration _startTimeout = Duration(seconds: 5);

  /// Replaced in tests.
  @visibleForTesting
  static AlarmPlayer Function() playerFactory = AudioPlayersAlarmPlayer.new;

  static AlarmPlayer? _player;
  static Timer? _watchdog;
  static bool _isPlaying = false;

  /// Bumped by every start and stop, so a slow start that was stopped (or restarted) meanwhile cannot leave a player behind.
  static int _generation = 0;
  static bool _restarting = false;

  /// Starts the continuous loud alarm when a new incoming order arrives. Calling it while it already rings does nothing.
  static Future<void> startLoudAlarm() async {
    if (_isPlaying) return;
    _isPlaying = true;
    final gen = ++_generation;
    debugPrint('[Kraveo Audio Engine] new order alarm ringing');

    await _openPlayer(gen);
    if (gen != _generation) return; // stopped (or restarted) while loading

    _watchdog?.cancel();
    _watchdog = Timer.periodic(_watchdogEvery, (_) => _watch(gen));
  }

  /// Creates a fresh player and starts the bundled tone. Failure is not fatal: the watchdog retries and beeps meanwhile.
  static Future<void> _openPlayer(int gen) async {
    final old = _player;
    _player = null;
    await _release(old);
    if (gen != _generation) return;

    final player = playerFactory();
    _player = player;
    try {
      await player.playLooping(alarmAsset).timeout(_startTimeout);
    } catch (e) {
      debugPrint('[Kraveo Audio Engine] alarm sound failed to start ($e); system beep until it recovers');
      if (gen == _generation) _systemBeep();
    }
    if (gen != _generation) {
      // stopAlarm already took _player; this covers a stop that landed between creating and storing it.
      if (identical(_player, player)) _player = null;
      await _release(player);
    }
  }

  static void _watch(int gen) {
    if (gen != _generation || !_isPlaying || _restarting) return;
    final player = _player;
    if (player != null && player.isActive) return;
    _restarting = true;
    // Never silent: beep right away, then try to bring the real tone back.
    _systemBeep();
    _openPlayer(gen).whenComplete(() => _restarting = false);
  }

  static void _systemBeep() {
    try {
      SystemSound.play(SystemSoundType.alert).catchError((Object _) {});
    } catch (_) {}
  }

  static Future<void> _release(AlarmPlayer? player) async {
    if (player == null) return;
    try {
      await player.stop();
    } catch (_) {}
    try {
      await player.dispose();
    } catch (e) {
      debugPrint('[Kraveo Audio Engine] error releasing audio player: $e');
    }
  }

  /// Stops the alarm when the vendor responds (ACCEPT or DECLINE) or logs out.
  static Future<void> stopAlarm() async {
    _isPlaying = false;
    _generation++;
    _watchdog?.cancel();
    _watchdog = null;
    final player = _player;
    _player = null;
    await _release(player);
    debugPrint('[Kraveo Audio Engine] alarm stopped');
  }

  /// True from [startLoudAlarm] until [stopAlarm] (the alarm is meant to ring; the watchdog keeps it audible).
  static bool get isPlaying => _isPlaying;
}
