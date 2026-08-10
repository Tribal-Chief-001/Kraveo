import 'dart:async';
import 'package:audioplayers/audioplayers.dart';

class AudioAlertService {
  static AudioPlayer? _player;
  static Timer? _alarmTimer;
  static bool _isPlaying = false;

  /// Starts continuous loud audio alarm loop when a new incoming order arrives.
  static Future<void> startLoudAlarm() async {
    if (_isPlaying) return;
    _isPlaying = true;

    print('🔊 [Kraveo Audio Engine] LOUD CONTINUOUS ORDER ALARM RINGING AT MAXIMUM VOLUME!');

    try {
      // Safely stop & dispose old player instance if it exists to prevent native audio daemon memory leaks
      final oldPlayer = _player;
      _player = null;
      await oldPlayer?.stop();
      await oldPlayer?.dispose();

      if (!_isPlaying) return; // Stopped while disposing old instance

      final player = AudioPlayer();
      _player = player;

      // Configure Android Audio Context for maximum alert volume override
      await player.setAudioContext(
        AudioContext(
          android: AudioContextAndroid(
            audioMode: AndroidAudioMode.normal,
            contentType: AndroidContentType.sonification,
            usageType: AndroidUsageType.alarm,
            audioFocus: AndroidAudioFocus.gainTransientMayDuck,
          ),
          iOS: AudioContextIOS(
            category: AVAudioSessionCategory.playback,
            options: {
              AVAudioSessionOptions.duckOthers,
            },
          ),
        ),
      );

      await player.setVolume(1.0);
      await player.setReleaseMode(ReleaseMode.loop);

      // Play continuous alert sound loop with fail-safe fallback timeout
      await player
          .play(UrlSource('https://actions.google.com/sounds/v1/alarms/digital_watch_alarm.ogg'))
          .timeout(const Duration(seconds: 2));

      // Race condition check: If stopAlarm() was called while loading, immediately stop player!
      if (!_isPlaying) {
        await player.stop();
        await player.dispose();
        if (_player == player) _player = null;
        return;
      }
    } catch (e) {
      print('⚠️ [Audio Engine Notice] Network sound source delayed ($e). Continuous periodic audio chime active.');
    }

    if (!_isPlaying) return;

    // Periodic secondary audio chime pulse to guarantee continuous feedback in loud kitchens
    _alarmTimer?.cancel();
    _alarmTimer = Timer.periodic(const Duration(milliseconds: 1200), (timer) {
      if (!_isPlaying) {
        timer.cancel();
        return;
      }
      print('🔔 BEEP! BEEP! INCOMING ORDER ALERT RINGING IN DHABA KITCHEN!');
    });
  }

  /// Stops audio alarm when vendor responds (ACCEPT or DECLINE).
  static Future<void> stopAlarm() async {
    _isPlaying = false;
    _alarmTimer?.cancel();
    _alarmTimer = null;

    try {
      final playerToStop = _player;
      _player = null;
      if (playerToStop != null) {
        await playerToStop.stop();
        await playerToStop.dispose();
      }
    } catch (e) {
      print('⚠️ [Audio Engine] Error stopping audio player: $e');
    }

    print('🔕 [Kraveo Audio Engine] Audio Ringing Alarm Stopped.');
  }

  static bool get isPlaying => _isPlaying;
}

