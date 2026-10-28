import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/home_banner.dart';
import '../services/customer_api_service.dart';

/// The Home promo banners (Docs/25 section 4). Loaded in the background (like the categories):
/// never throws, never blocks Home, and a failed refresh keeps the last good list in memory. Until
/// the first success the list is empty and Home shows nothing in its place.
///
/// Also batches the view / click counters: a banner counts one view per app session (this
/// provider lives as long as the app does), every tap counts a click; they are sent together a
/// moment later, fire-and-forget.
class BannerProvider with ChangeNotifier {
  BannerProvider({this.eventDelay = const Duration(seconds: 2)});

  /// How long events wait for company before they are sent.
  final Duration eventDelay;

  List<HomeBanner> _banners = const [];
  Future<void>? _loading;
  bool _disposed = false;

  final Set<String> _viewed = {};
  final Set<String> _pendingViews = {};
  final List<String> _pendingClicks = [];
  Timer? _eventTimer;

  /// The banners to show, in the server's order (empty = show nothing).
  List<HomeBanner> get banners => _banners;

  /// Loads `GET /banners`. Concurrent calls share one request. Resolves to normally on every outcome.
  /// A server answer replaces the list (an empty answer clears it: the admin switched them all off);
  /// any failure keeps the last good list.
  Future<void> refresh() => _loading ??= _refresh().whenComplete(() => _loading = null);

  Future<void> _refresh() async {
    try {
      final fresh = await CustomerApiService.fetchBanners();
      if (_disposed || listEquals(fresh, _banners)) return;
      _banners = fresh;
      notifyListeners();
    } catch (error) {
      debugPrint('[Banners] unavailable, keeping the last list: ${error.runtimeType}');
    }
  }

  /// Test seam: show these banners as if the server had sent them.
  @visibleForTesting
  void showForTest(List<HomeBanner> list) {
    _banners = List.unmodifiable(list);
    notifyListeners();
  }

  /// A banner is on screen: counted once per app session.
  void recordView(String id) {
    if (_disposed || !_viewed.add(id)) return;
    _pendingViews.add(id);
    _eventTimer ??= Timer(eventDelay, flushEvents);
  }

  /// A banner was tapped: counted every time.
  void recordClick(String id) {
    if (_disposed) return;
    _pendingClicks.add(id);
    _eventTimer ??= Timer(eventDelay, flushEvents);
  }

  /// Sends what is pending (also when the app goes to the background). Failures are ignored.
  Future<void> flushEvents() async {
    _eventTimer?.cancel();
    _eventTimer = null;
    while (_pendingViews.isNotEmpty || _pendingClicks.isNotEmpty) {
      final views = _pendingViews.take(10).toList();
      _pendingViews.removeAll(views);
      // The server counts an id once per call, so one call carries each clicked banner once.
      final clicks = <String>[];
      for (final id in _pendingClicks) {
        if (clicks.length < 5 && !clicks.contains(id)) clicks.add(id);
      }
      for (final id in clicks) {
        _pendingClicks.remove(id); // one occurrence each
      }
      await CustomerApiService.sendBannerEvents(views: views, clicks: clicks);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _eventTimer?.cancel();
    super.dispose();
  }
}
