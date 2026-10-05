import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/geo.dart';

/// Google Maps navigation mode for the "Navigate" buttons: `d` = driving. The riders are on
/// bikes and scooters, and Maps' driving routes (roads, one-ways) are the closest to that.
/// Change it here only; every URL below uses it.
const String kNavigationMode = 'd';

const Map<String, String> _webTravelModes = {'d': 'driving', 'w': 'walking', 'b': 'bicycling', 'l': 'two-wheeler'};

/// The links that open turn-by-turn navigation to [point], most specific first:
///  1. `google.navigation:` - starts Google Maps navigation directly,
///  2. `geo:` - any installed maps app shows the pin,
///  3. an https Google Maps directions link - opens the Maps app or the browser.
/// Empty when [point] is not a valid coordinate (nothing is ever guessed).
///
/// Pure function: no plugin, no I/O.
List<Uri> navigationUris(GeoPoint point, {String? label}) {
  if (!point.isValid) return const [];
  final ll = '${point.lat.toStringAsFixed(6)},${point.lng.toStringAsFixed(6)}';
  // Brackets would end the label of a geo: link early.
  final name = (label ?? '').replaceAll(RegExp(r'[()]'), ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
  return [
    Uri.parse('google.navigation:q=$ll&mode=$kNavigationMode'),
    Uri.parse(name.isEmpty ? 'geo:$ll?q=$ll' : 'geo:$ll?q=$ll(${Uri.encodeComponent(name)})'),
    Uri.https('www.google.com', '/maps/dir/', {'api': '1', 'destination': ll, 'travelmode': _webTravelModes[kNavigationMode] ?? 'driving'}),
  ];
}

/// Opens one link outside the app. Returns false when nothing could handle it. Tests use a fake.
abstract class NavigationLauncher {
  const NavigationLauncher();
  Future<bool> open(Uri uri);
}

class UrlNavigationLauncher extends NavigationLauncher {
  const UrlNavigationLauncher();

  @override
  Future<bool> open(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (e) {
      debugPrint('Navigation link ${uri.scheme} could not be opened (${e.runtimeType}).');
      return false;
    }
  }
}

/// Tries each link of [navigationUris] in order and stops at the first one that opens.
/// Returns false when none did (no maps app and no browser) or the point is invalid.
Future<bool> openNavigation(GeoPoint point, {String? label, NavigationLauncher launcher = const UrlNavigationLauncher()}) async {
  for (final uri in navigationUris(point, label: label)) {
    if (await launcher.open(uri)) return true;
  }
  return false;
}
