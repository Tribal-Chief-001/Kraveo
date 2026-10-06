import 'package:flutter/foundation.dart';
import '../../models/settlement.dart';
import '../failure_messages.dart';
import 'payout_api.dart';

/// "My settlements": the list (newest first, loaded page by page) with pull-to-refresh and retry.
class SettlementsController extends ChangeNotifier {
  SettlementsController({required this.api, this.pageSize = 25});

  final PayoutApi api;
  final int pageSize;

  final List<Settlement> _items = [];
  bool _loadedOnce = false;
  bool _loading = false;
  bool _loadingMore = false;
  FailureText? _failure;
  FailureText? _moreFailure;
  int _page = 0;
  bool _hasMore = false;
  int _skipped = 0;
  bool _disposed = false;

  List<Settlement> get items => List.unmodifiable(_items);

  /// The server answered at least once.
  bool get loadedOnce => _loadedOnce;

  /// The first page (or a refresh) is loading.
  bool get loading => _loading;
  bool get loadingMore => _loadingMore;

  /// Why the first page / refresh failed. When [loadedOnce], the old list stays on screen under it.
  FailureText? get failure => _failure;
  FailureText? get moreFailure => _moreFailure;
  bool get hasMore => _hasMore;

  /// Entries the server sent that this app could not read (never shown).
  int get skipped => _skipped;
  bool get isEmpty => _loadedOnce && _items.isEmpty;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Loads page 1 again (first open, retry, pull-to-refresh). A call while one is running does nothing.
  Future<void> load() async {
    if (_loading || _disposed) return;
    _loading = true;
    _failure = null;
    _notify();
    final res = await api.fetchSettlements(page: 1, pageSize: pageSize);
    if (_disposed) return;
    _loading = false;
    if (res.ok) {
      final page = res.data!;
      _items
        ..clear()
        ..addAll(page.items);
      _page = page.page;
      _hasMore = page.hasMore;
      _skipped = page.skipped;
      _moreFailure = null;
      _loadedOnce = true;
    } else {
      _failure = settlementFailureText(res);
    }
    _notify();
  }

  /// The next (older) page, appended; a settlement that moved between pages is never listed twice.
  Future<void> loadMore() async {
    if (!_loadedOnce || !_hasMore || _loading || _loadingMore || _disposed) return;
    _loadingMore = true;
    _moreFailure = null;
    _notify();
    final res = await api.fetchSettlements(page: _page + 1, pageSize: pageSize);
    if (_disposed) return;
    _loadingMore = false;
    if (res.ok) {
      final page = res.data!;
      final known = {for (final s in _items) s.id};
      _items.addAll(page.items.where((s) => !known.contains(s.id)));
      _page = page.page;
      _hasMore = page.hasMore;
      _skipped += page.skipped;
    } else {
      _moreFailure = settlementFailureText(res);
    }
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// One settlement with its dish lines, orders and adjustments.
class SettlementDetailController extends ChangeNotifier {
  SettlementDetailController({required this.api, required this.id});

  final PayoutApi api;
  final String id;

  SettlementDetail? _detail;
  bool _loading = false;
  FailureText? _failure;
  bool _disposed = false;

  SettlementDetail? get detail => _detail;
  bool get loading => _loading;
  FailureText? get failure => _failure;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    if (_loading || _disposed) return;
    _loading = true;
    _failure = null;
    _notify();
    final res = await api.fetchSettlement(id);
    if (_disposed) return;
    _loading = false;
    if (res.ok) {
      _detail = res.data;
    } else {
      _failure = settlementFailureText(res);
    }
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
