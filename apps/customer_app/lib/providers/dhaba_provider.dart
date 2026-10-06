import 'package:flutter/material.dart';
import '../models/dhaba.dart';
import '../models/menu_item.dart';
import '../services/customer_api_service.dart';

/// Where the live kitchen catalog (`GET /vendors`) stands. The app has no built-in kitchens: what
/// the student sees is always what the server returned.
enum CatalogStatus {
  /// Nothing requested yet.
  idle,

  /// First load in progress (nothing to show yet).
  loading,

  /// The server answered; the list may be empty (no kitchen is open).
  ready,

  /// The first load failed and there is nothing to show; the screen offers "Try again".
  failed,
}

class DhabaProvider with ChangeNotifier {
  /// Starts with no kitchens. Tests may pass a catalog (treated as freshly loaded from the server).
  DhabaProvider({List<Dhaba>? dhabas, Map<String, List<MenuItemModel>>? menus}) {
    if (dhabas != null) {
      _dhabas.addAll(dhabas);
      _menuItems.addAll(menus ?? const {});
      _liveVendorIds.addAll(dhabas.map((d) => d.id));
      _status = CatalogStatus.ready;
    }
  }

  String _searchQuery = '';
  String _selectedCategory = _all;
  bool _showFavoritesOnly = false;
  static const Set<String> _defaultFavoriteIds = {'ven-1', 'ven-3'};
  final Set<String> _favoriteDhabaIds = {..._defaultFavoriteIds};

  static const String _all = 'All';

  CatalogStatus _status = CatalogStatus.idle;
  Future<bool>? _loading;

  final List<Dhaba> _dhabas = [];
  final Map<String, List<MenuItemModel>> _menuItems = {};

  /// Kitchens that came from the live server catalog (checkout refuses anything else).
  final Set<String> _liveVendorIds = {};

  bool isLiveVendor(String? id) => id != null && _liveVendorIds.contains(id);

  /// Test seam: treat these kitchens as coming from the live catalog.
  @visibleForTesting
  void markLiveForTest(Iterable<String> ids) => _liveVendorIds.addAll(ids);

  // Getters
  String get searchQuery => _searchQuery;
  bool get showFavoritesOnly => _showFavoritesOnly;

  CatalogStatus get catalogStatus => _status;

  /// The very first catalog request is still running (show skeletons).
  bool get isCatalogLoading => _status == CatalogStatus.idle || _status == CatalogStatus.loading;

  /// The first request failed and nothing is on screen (show "Can't load kitchens" + Try again).
  bool get hasCatalogFailed => _status == CatalogStatus.failed;

  /// Every kitchen the server returned, ignoring Home's search / category / favourites filters.
  List<Dhaba> get allDhabas => [for (final d in _dhabas) d.copyWith(isFavorite: _favoriteDhabaIds.contains(d.id))];

  /// One kitchen from the unfiltered list, or null when the server no longer lists it.
  Dhaba? byId(String? id) {
    if (id == null) return null;
    for (final d in _dhabas) {
      if (d.id == id) return d.copyWith(isFavorite: _favoriteDhabaIds.contains(d.id));
    }
    return null;
  }

  /// Home's category chips: "All" plus the dish categories that really exist on the live menus
  /// (most common first), so a chip can never lead to "No kitchens match".
  List<String> get categories {
    final counts = <String, int>{};
    final spelling = <String, String>{};
    for (final d in _dhabas) {
      final seen = <String>{};
      for (final item in _menuItems[d.id] ?? const <MenuItemModel>[]) {
        final label = item.category.trim();
        if (label.isEmpty) continue;
        final key = label.toLowerCase();
        spelling.putIfAbsent(key, () => label);
        if (seen.add(key)) counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    final keys = counts.keys.toList()..sort((a, b) => counts[b] != counts[a] ? counts[b]!.compareTo(counts[a]!) : a.compareTo(b));
    return [_all, for (final key in keys.take(8)) spelling[key]!];
  }

  /// Index of the selected chip in [categories] (0 = All; also 0 when that category disappeared).
  int get selectedCategoryIndex {
    final i = categories.indexWhere((c) => c.toLowerCase() == _selectedCategory.toLowerCase());
    return i < 0 ? 0 : i;
  }

  bool _matchesCategory(Dhaba d, String category) {
    final wanted = category.toLowerCase();
    if ((_menuItems[d.id] ?? const <MenuItemModel>[]).any((i) => i.category.trim().toLowerCase() == wanted)) return true;
    return d.category.toLowerCase().contains(wanted) || d.tags.any((t) => t.toLowerCase() == wanted);
  }

  /// The kitchens Home shows: [allDhabas] narrowed by favourites, the selected chip and the search text.
  List<Dhaba> get dhabas {
    final selected = categories[selectedCategoryIndex];
    return allDhabas.where((d) {
      if (_showFavoritesOnly && !_favoriteDhabaIds.contains(d.id)) {
        return false;
      }
      if (selected != _all && !_matchesCategory(d, selected)) return false;
      if (_searchQuery.trim().isNotEmpty) {
        final query = _searchQuery.trim().toLowerCase();
        final nameMatch = d.name.toLowerCase().contains(query);
        final catMatch = d.category.toLowerCase().contains(query);
        final tagMatch = d.tags.any((t) => t.toLowerCase().contains(query));

        // Also search in dhaba menu items!
        final items = _menuItems[d.id] ?? [];
        final itemMatch = items.any((item) =>
            item.name.toLowerCase().contains(query) || item.description.toLowerCase().contains(query));

        if (!nameMatch && !catMatch && !tagMatch && !itemMatch) {
          return false;
        }
      }
      return true;
    }).toList();
  }

  List<MenuItemModel> getMenuItemsForDhaba(String dhabaId) {
    return _menuItems[dhabaId] ?? [];
  }

  /// Loads the authoritative catalog (`GET /vendors`): real database menu ids, open/closed state
  /// and sold-out dishes. Concurrent calls share one request. Returns true when the server
  /// answered. A failed refresh keeps what is already on screen; only a failed first load
  /// switches to [CatalogStatus.failed].
  Future<bool> loadCatalog() => _loading ??= _loadCatalog().whenComplete(() => _loading = null);

  Future<bool> _loadCatalog() async {
    if (_status != CatalogStatus.ready) {
      _status = CatalogStatus.loading;
      notifyListeners();
    }
    try {
      final vendors = await CustomerApiService.fetchVendors();

      final loadedDhabas = <Dhaba>[];
      final loadedMenus = <String, List<MenuItemModel>>{};
      for (final vendor in vendors) {
        final dhaba = Dhaba.fromJson(vendor);
        final rawMenu = (vendor['menuItems'] ?? vendor['menu'] ?? []) as List<dynamic>;
        loadedDhabas.add(dhaba);
        loadedMenus[dhaba.id] = rawMenu
            .whereType<Map>()
            .map((item) => MenuItemModel.fromJson(Map<String, dynamic>.from(item)))
            .toList();
      }

      _dhabas
        ..clear()
        ..addAll(loadedDhabas);
      _menuItems
        ..clear()
        ..addAll(loadedMenus);
      _liveVendorIds
        ..clear()
        ..addAll(loadedDhabas.map((d) => d.id));
      _status = CatalogStatus.ready;
      notifyListeners();
      return true;
    } catch (error) {
      debugPrint('[Catalog] Live catalog unavailable: ${error.runtimeType}');
      if (_status != CatalogStatus.ready) _status = CatalogStatus.failed;
      notifyListeners();
      return false;
    }
  }

  /// Clears per-student browsing state (search, filters, favourites) on logout.
  void resetForLogout() {
    _searchQuery = '';
    _selectedCategory = _all;
    _showFavoritesOnly = false;
    _favoriteDhabaIds
      ..clear()
      ..addAll(_defaultFavoriteIds);
    notifyListeners();
  }

  void setSearchQuery(String query) {
    _searchQuery = query;
    notifyListeners();
  }

  void setSelectedCategoryIndex(int index) {
    final list = categories;
    _selectedCategory = index >= 0 && index < list.length ? list[index] : _all;
    notifyListeners();
  }

  void toggleFavoritesOnly() {
    _showFavoritesOnly = !_showFavoritesOnly;
    notifyListeners();
  }

  void toggleFavorite(String dhabaId) {
    if (_favoriteDhabaIds.contains(dhabaId)) {
      _favoriteDhabaIds.remove(dhabaId);
    } else {
      _favoriteDhabaIds.add(dhabaId);
    }
    notifyListeners();
  }
}
