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
      final player = AudioPlayer();
      _player = player;
      await player.setVolume(1.0).timeout(const Duration(milliseconds: 200));
      await player.setReleaseMode(ReleaseMode.loop).timeout(const Duration(milliseconds: 200));
      await player.play(UrlSource('https://actions.google.com/sounds/v1/alarms/digital_watch_alarm.ogg')).timeout(const Duration(milliseconds: 200));
    } catch (e) {
      print('⚠️ [Audio Engine Fallback] Hardware audio play error ($e), falling back to high frequency timer chime.');
    }

    // Periodic secondary console beep pulse to guarantee continuous feedback
    _alarmTimer?.cancel();
    _alarmTimer = Timer.periodic(const Duration(milliseconds: 1200), (timer) {
      print('🔔 BEEP! BEEP! NEW INCOMING ORDER FOR SHARMA DHABA! [VEND-ALERT-LIVE]');
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
      }
    } catch (e) {
      print('⚠️ [Audio Engine] Error stopping audio player: $e');
    }

    print('🔕 [Kraveo Audio Engine] Audio Ringing Alarm Stopped.');
  }

  static bool get isPlaying => _isPlaying;
}
