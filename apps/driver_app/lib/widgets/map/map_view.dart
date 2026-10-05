import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import '../../models/geo.dart';

/// Everything a real map view needs to draw the delivery picture. The delivery screen owns the
/// state; the view only paints it, so it can be replaced by a fake in tests.
class MapViewSpec {
  const MapViewSpec({
    required this.rider,
    required this.onReady,
    required this.onError,
    this.pickup,
    this.pickupName = '',
    this.drop,
    this.dropName = '',
  });

  /// The restaurant pin, only when the server says it is a real location.
  final GeoPoint? pickup;
  final String pickupName;

  /// The drop point pin.
  final GeoPoint? drop;
  final String dropName;

  /// The rider's own position (null = no marker). Changes about every 10 s and repaints only
  /// the map, never the screen.
  final ValueListenable<GeoPoint?> rider;

  /// The map is created and drawing. Until this is called the plain card stays visible.
  final VoidCallback onReady;

  /// The map hit an error after being built. The plain card takes over.
  final void Function(Object error) onError;

  /// The points the camera should fit.
  List<GeoPoint> visiblePoints({GeoPoint? riderPoint}) => [if (pickup != null) pickup!, if (drop != null) drop!, if (riderPoint != null) riderPoint];
}

/// Creates the real map. Injectable so tests (and builds without a Maps key) never touch a
/// platform view: any failure here is turned into the plain card by the map card.
abstract class MapViewFactory {
  const MapViewFactory();

  /// Whether a real map can even be attempted on this device/build (a Maps key was compiled
  /// in, Google Play services exist, a platform view is available). Must not throw.
  Future<bool> isAvailable();

  /// Builds the map widget. May throw: the caller falls back to the plain card.
  Widget build(BuildContext context, MapViewSpec spec);
}
