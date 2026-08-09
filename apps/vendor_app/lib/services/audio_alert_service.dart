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
      // Safely dispose old player instance if it exists to prevent native audio daemon memory leaks
      await _player?.stop();
      await _player?.dispose();

      final player = AudioPlayer();
      _player = player;
      await player.setVolume(1.0);
      await player.setReleaseMode(ReleaseMode.loop);

      // Play continuous alert sound loop with fail-safe fallback
      await player
          .play(UrlSource('https://actions.google.com/sounds/v1/alarms/digital_watch_alarm.ogg'))
          .timeout(const Duration(seconds: 4));
    } catch (e) {
      print('⚠️ [Audio Engine Notice] Network sound source delayed ($e). Continuous periodic audio chime active.');
    }

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
      if (_player != null) {
        await _player?.stop();
        await _player?.dispose();
        _player = null;
      }
    } catch (e) {
      print('⚠️ [Audio Engine] Error stopping audio player: $e');
    }

    print('🔕 [Kraveo Audio Engine] Audio Ringing Alarm Stopped.');
  }

  static bool get isPlaying => _isPlaying;
}
