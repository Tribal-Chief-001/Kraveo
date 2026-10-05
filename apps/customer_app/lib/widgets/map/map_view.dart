import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import '../../models/geo.dart';

/// Everything a real map view needs to draw the tracking picture. The tracking screen owns the
/// state; the view only paints it, so it can be replaced by a fake in tests.
class MapViewSpec {
  const MapViewSpec({
    required this.dropoff,
    required this.dropoffName,
    required this.rider,
    required this.onReady,
    required this.onError,
    this.restaurant,
    this.restaurantName = '',
  });

  /// The delivery point pin (always present).
  final GeoPoint dropoff;
  final String dropoffName;

  /// The restaurant pin, only when the server says it is a real location.
  final GeoPoint? restaurant;
  final String restaurantName;

  /// The rider marker position, already interpolated between GPS fixes (null = no marker).
  /// Changes at most ~12 times a second and rebuilds only the map, never the screen.
  final ValueListenable<GeoPoint?> rider;

  /// The map is created and drawing. Until this is called the stylised map stays visible.
  final VoidCallback onReady;

  /// The map hit an error after being built. The stylised map takes over.
  final void Function(Object error) onError;

  /// The points the camera should fit.
  List<GeoPoint> visiblePoints({GeoPoint? riderPoint}) => [dropoff, if (restaurant != null) restaurant!, if (riderPoint != null) riderPoint];
}

/// Creates the real map. Injectable so tests (and builds without a Maps key) never touch a
/// platform view: any failure here is turned into the stylised map by the tracking screen.
abstract class MapViewFactory {
  const MapViewFactory();

  /// Whether a real map can even be attempted on this device/build (a Maps key was compiled
  /// in, Google Play services exist, a platform view is available). Must not throw.
  Future<bool> isAvailable();

  /// Builds the map widget. May throw: the caller falls back to the stylised map.
  Widget build(BuildContext context, MapViewSpec spec);
}
