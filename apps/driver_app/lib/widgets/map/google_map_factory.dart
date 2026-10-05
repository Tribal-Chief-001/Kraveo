import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'google_delivery_map_view.dart';
import 'map_view.dart';

/// The production [MapViewFactory]: the real Google map, but only when MainActivity reports
/// that a Maps key was built into this APK and Google Play services are installed.
///
/// Anything else (no key, no Play services, a test, desktop, iOS) answers "not available" and
/// the delivery screen shows the plain card without ever creating a platform view.
class GoogleMapViewFactory extends MapViewFactory {
  const GoogleMapViewFactory();

  static const MethodChannel _channel = MethodChannel('site.kraveo.driver/system');
  static Future<bool>? _cached;

  @override
  Future<bool> isAvailable() {
    if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return Future.value(false);
    return _cached ??= _ask();
  }

  static Future<bool> _ask() async {
    try {
      return (await _channel.invokeMethod<bool>('mapsAvailable')) == true;
    } catch (_) {
      return false; // MissingPluginException in tests, or any platform error
    }
  }

  @override
  Widget build(BuildContext context, MapViewSpec spec) => GoogleDeliveryMapView(spec: spec);

  /// Test helper: forget the cached answer.
  @visibleForTesting
  static void resetCache() => _cached = null;
}
