import 'package:flutter/widgets.dart';
import 'package:url_launcher/url_launcher.dart';
import 'location_capture.dart';

/// Opens a link outside the app (Google Maps or the browser). True when something opened.
typedef MapOpener = Future<bool> Function(Uri uri);

Future<bool> _launchExternal(Uri uri) async {
  try {
    return await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    return false;
  }
}

/// "Open in Google Maps to check": a plain https search link, so it needs no Maps key in this app.
Uri googleMapsLink(double lat, double lng) =>
    Uri.parse('https://www.google.com/maps/search/?api=1&query=${lat.toStringAsFixed(6)},${lng.toStringAsFixed(6)}');

/// The outside world of the location screens: the phone's GPS and the link opener. Tests pass fakes.
class LocationServices {
  LocationServices({LocationCapture? capture, MapOpener? openUrl})
      : capture = capture ?? BestFixCapture(sensor: const GeolocatorSensor()),
        openUrl = openUrl ?? _launchExternal;

  final LocationCapture capture;
  final MapOpener openUrl;
}

/// Makes [LocationServices] reachable from any screen. Without a scope (screens pumped alone) the real ones are used.
class LocationScope extends InheritedWidget {
  const LocationScope({super.key, required this.services, required super.child});

  final LocationServices services;

  static LocationServices of(BuildContext context) => context.getInheritedWidgetOfExactType<LocationScope>()?.services ?? LocationServices();

  @override
  bool updateShouldNotify(LocationScope oldWidget) => services != oldWidget.services;
}

/// "about 12 m" (never "about 0 m").
String formatAccuracy(double metres) {
  if (!metres.isFinite) return 'unknown';
  if (metres >= 1000) return 'over 1 km';
  final m = metres.round();
  return 'about ${m < 1 ? 1 : m} m';
}
