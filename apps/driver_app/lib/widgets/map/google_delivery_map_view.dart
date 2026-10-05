import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../models/geo.dart';
import 'map_view.dart';

LatLng _ll(GeoPoint p) => LatLng(p.lat, p.lng);

/// The real Google map. This is the ONLY file that imports the maps plugin.
///
/// Draws the restaurant pin (if any), the drop point pin and the rider's own marker. The rider
/// marker is repainted from [MapViewSpec.rider] inside a [ValueListenableBuilder], so a GPS tick
/// rebuilds this map only. It is a preview inside a scrolling list, so pan/zoom gestures are
/// off (they would fight the list's scrolling); the Navigate buttons open Google Maps proper.
class GoogleDeliveryMapView extends StatefulWidget {
  const GoogleDeliveryMapView({super.key, required this.spec});

  final MapViewSpec spec;

  @override
  State<GoogleDeliveryMapView> createState() => _GoogleDeliveryMapViewState();
}

class _GoogleDeliveryMapViewState extends State<GoogleDeliveryMapView> {
  GoogleMapController? _controller;
  bool _hadRider = false;

  @override
  void initState() {
    super.initState();
    widget.spec.rider.addListener(_onRider);
  }

  @override
  void didUpdateWidget(covariant GoogleDeliveryMapView old) {
    super.didUpdateWidget(old);
    if (old.spec.rider != widget.spec.rider) {
      old.spec.rider.removeListener(_onRider);
      widget.spec.rider.addListener(_onRider);
    }
    if (old.spec.pickup != widget.spec.pickup || old.spec.drop != widget.spec.drop) _fit();
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
    if (pts.isEmpty) return;
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
          : CameraUpdate.newLatLngBounds(LatLngBounds(southwest: LatLng(minLat, minLng), northeast: LatLng(maxLat, maxLng)), 48);
      await c.animateCamera(update);
    } catch (_) {
      // Bounds before the first layout can throw: try once more shortly, then give up quietly
      // (the map still shows the initial camera).
      if (retry) {
        await Future<void>.delayed(const Duration(milliseconds: 400));
        if (mounted && identical(_controller, c)) unawaited(_fit(retry: false));
      }
    }
  }

  Set<Marker> _markers(GeoPoint? rider) {
    final spec = widget.spec;
    return {
      if (spec.drop != null)
        Marker(
          markerId: const MarkerId('drop'),
          position: _ll(spec.drop!),
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueGreen),
          infoWindow: InfoWindow(title: spec.dropName),
        ),
      if (spec.pickup != null)
        Marker(
          markerId: const MarkerId('pickup'),
          position: _ll(spec.pickup!),
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
          infoWindow: InfoWindow(title: spec.pickupName),
        ),
      if (rider != null)
        Marker(
          markerId: const MarkerId('rider'),
          position: _ll(rider),
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
          infoWindow: const InfoWindow(title: 'You'),
          zIndexInt: 2,
        ),
    };
  }

  @override
  Widget build(BuildContext context) {
    final spec = widget.spec;
    final first = spec.visiblePoints(riderPoint: spec.rider.value);
    return ValueListenableBuilder<GeoPoint?>(
      valueListenable: spec.rider,
      builder: (context, rider, _) => GoogleMap(
        initialCameraPosition: CameraPosition(target: _ll(first.isEmpty ? const GeoPoint(23.0735, 76.8590) : first.first), zoom: 16),
        markers: _markers(rider),
        onMapCreated: (c) {
          _controller = c;
          _hadRider = spec.rider.value != null;
          spec.onReady();
          _fit();
        },
        // The rider's own marker is drawn from the app's own fixes (see MapViewSpec.rider), so
        // the map never asks for the location permission itself.
        myLocationEnabled: false,
        myLocationButtonEnabled: false,
        scrollGesturesEnabled: false,
        zoomGesturesEnabled: false,
        zoomControlsEnabled: false,
        mapToolbarEnabled: false,
        compassEnabled: false,
        rotateGesturesEnabled: false,
        tiltGesturesEnabled: false,
        buildingsEnabled: false,
        indoorViewEnabled: false,
        trafficEnabled: false,
      ),
    );
  }
}
