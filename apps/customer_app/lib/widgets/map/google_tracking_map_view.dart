import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../models/geo.dart';
import 'map_view.dart';

LatLng _ll(GeoPoint p) => LatLng(p.lat, p.lng);

/// The real Google map. This is the ONLY file that imports the maps plugin.
///
/// Draws the restaurant pin (if any), the delivery pin and the rider marker. The rider marker
/// is repainted from [MapViewSpec.rider] inside a [ValueListenableBuilder], so a GPS tick
/// rebuilds this map only.
class GoogleTrackingMapView extends StatefulWidget {
  const GoogleTrackingMapView({super.key, required this.spec});

  final MapViewSpec spec;

  @override
  State<GoogleTrackingMapView> createState() => _GoogleTrackingMapViewState();
}

class _GoogleTrackingMapViewState extends State<GoogleTrackingMapView> {
  GoogleMapController? _controller;
  bool _hadRider = false;

  @override
  void initState() {
    super.initState();
    widget.spec.rider.addListener(_onRider);
  }

  @override
  void didUpdateWidget(covariant GoogleTrackingMapView old) {
    super.didUpdateWidget(old);
    if (old.spec.rider != widget.spec.rider) {
      old.spec.rider.removeListener(_onRider);
      widget.spec.rider.addListener(_onRider);
    }
    if (old.spec.dropoff != widget.spec.dropoff || old.spec.restaurant != widget.spec.restaurant) _fit();
  }

  @override
  void dispose() {
    widget.spec.rider.removeListener(_onRider);
    _controller = null; // the plugin disposes its own controller with the view
    super.dispose();
  }

  void _onRider() {
    final has = widget.spec.rider.value != null;
    if (has != _hadRider) {
      _hadRider = has;
      _fit(); // the rider appeared (or vanished): show everyone
    }
  }

  Future<void> _fit({bool retry = true}) async {
    final c = _controller;
    if (c == null) return;
    final spec = widget.spec;
    final pts = spec.visiblePoints(riderPoint: spec.rider.value);
    try {
      var minLat = pts.first.lat, maxLat = pts.first.lat, minLng = pts.first.lng, maxLng = pts.first.lng;
      for (final p in pts) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
      }
      final tiny = distanceMeters(GeoPoint(minLat, minLng), GeoPoint(maxLat, maxLng)) < 40;
      final update = tiny
          ? CameraUpdate.newLatLngZoom(LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2), 17)
          : CameraUpdate.newLatLngBounds(LatLngBounds(southwest: LatLng(minLat, minLng), northeast: LatLng(maxLat, maxLng)), 56);
      await c.animateCamera(update);
    } catch (_) {
      // Bounds before the first layout can throw: try once more shortly, then give up quietly
      // (the map still shows the initial camera on the delivery point).
      if (retry) {
        await Future<void>.delayed(const Duration(milliseconds: 400));
        if (mounted && identical(_controller, c)) unawaited(_fit(retry: false));
      }
    }
  }

  Set<Marker> _markers(GeoPoint? rider, {bool stale = false}) {
    final spec = widget.spec;
    return {
      Marker(
        markerId: const MarkerId('dropoff'),
        position: _ll(spec.dropoff),
        icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
        infoWindow: InfoWindow(title: spec.dropoffName),
      ),
      if (spec.restaurant != null)
        Marker(
          markerId: const MarkerId('restaurant'),
          position: _ll(spec.restaurant!),
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
          infoWindow: InfoWindow(title: spec.restaurantName),
        ),
      if (rider != null)
        Marker(
          markerId: const MarkerId('rider'),
          position: _ll(rider),
          icon: BitmapDescriptor.defaultMarkerWithHue(stale ? BitmapDescriptor.hueAzure : BitmapDescriptor.hueOrange),
          infoWindow: InfoWindow(title: stale ? 'Your rider (location not updating)' : 'Your rider'),
          alpha: stale ? 0.6 : 1,
          zIndexInt: 2,
          anchor: const Offset(0.5, 1),
        ),
    };
  }

  @override
  Widget build(BuildContext context) {
    final spec = widget.spec;
    return ListenableBuilder(
      listenable: Listenable.merge([spec.rider, if (spec.riderStale != null) spec.riderStale!]),
      builder: (context, _) => _map(spec, spec.rider.value, stale: spec.riderStale?.value ?? false),
    );
  }

  Widget _map(MapViewSpec spec, GeoPoint? rider, {required bool stale}) {
    return GoogleMap(
      initialCameraPosition: CameraPosition(target: _ll(spec.dropoff), zoom: 16),
      markers: _markers(rider, stale: stale),
      onMapCreated: (c) {
        _controller = c;
        _hadRider = spec.rider.value != null;
        spec.onReady();
        _fit();
      },
      // Nothing here needs the phone's own location: no permission is requested.
      myLocationEnabled: false,
      myLocationButtonEnabled: false,
      zoomControlsEnabled: false,
      mapToolbarEnabled: false,
      compassEnabled: false,
      rotateGesturesEnabled: false,
      tiltGesturesEnabled: false,
      buildingsEnabled: false,
      indoorViewEnabled: false,
      trafficEnabled: false,
    );
  }
}
