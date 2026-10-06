/// Where a dish is in Kraveo's approval flow (Docs/21 section 4). A restaurant only ever sees its OWN price.
enum DishStatus {
  /// New dish, waiting for Kraveo to approve it. Customers cannot see it yet.
  pending,

  /// Approved and visible to customers.
  live,

  /// Live at the old price; a new price was asked for and is waiting for Kraveo.
  changePending,

  /// Kraveo did not approve it (the reason is in [DishModel.rejectionReason]). It can be sent again.
  rejected;

  /// `PENDING|LIVE|REJECTED|CHANGE_PENDING` (also the database word `APPROVED`). A server that sends no status
  /// (the old one) means every dish is live. A word this version does not know is treated as pending: the cautious
  /// claim, because it never tells the owner a dish is live when we cannot tell.
  static DishStatus parse(Object? raw) {
    if (raw == null) return DishStatus.live;
    switch (raw.toString().trim().toUpperCase()) {
      case '':
      case 'LIVE':
      case 'APPROVED':
        return DishStatus.live;
      case 'CHANGE_PENDING':
        return DishStatus.changePending;
      case 'REJECTED':
        return DishStatus.rejected;
      default:
        return DishStatus.pending;
    }
  }
}

class DishModel {
  final String id;
  String name;
  String category;

  /// The restaurant's OWN price (what it earns per portion). For a live dish with a price change waiting,
  /// this stays the live price and [pendingPrice] is the requested one.
  double price;
  bool inStock;
  String? imageUrl;

  DishStatus status;

  /// A requested new price waiting for approval (only while [status] is `changePending`).
  double? pendingPrice;

  /// Why Kraveo did not approve the dish (only while [status] is `rejected`).
  String? rejectionReason;

  /// True when the server told us this dish's approval status. An OLD server never does, so for those dishes a price
  /// change is applied at once (that server has no approval step) and every dish counts as live.
  final bool statusKnown;

  DishModel({
    required this.id,
    required this.name,
    required this.category,
    required this.price,
    this.inStock = true,
    this.imageUrl,
    this.status = DishStatus.live,
    this.pendingPrice,
    this.rejectionReason,
    bool? statusKnown,
  }) : statusKnown = statusKnown ?? (status != DishStatus.live || pendingPrice != null);

  /// Customers can see this dish (live, with or without a price change waiting). Only such dishes have a
  /// sold-out switch.
  bool get isLive => status == DishStatus.live || status == DishStatus.changePending;

  /// The price shown as "your price" being edited: the requested one while a change is waiting.
  double get editPrice => pendingPrice ?? price;

  /// Parses a menu item from `GET /vendors/:id/menu-manage`, `GET /menus/:vendorId` or `POST /vendors/:id/items`.
  static DishModel? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id']?.toString() ?? '';
    final name = raw['name']?.toString().trim() ?? '';
    if (id.isEmpty || name.isEmpty) return null;
    final price = raw['price'];
    final category = raw['category']?.toString().trim() ?? '';
    final image = raw['imageUrl']?.toString().trim() ?? '';
    final known = raw['status'] != null;
    var status = DishStatus.parse(raw['status']);
    final pendingRaw = raw['pendingPrice'] ?? raw['pendingVendorPrice'];
    final pending = pendingRaw is num ? pendingRaw.toDouble() : double.tryParse(pendingRaw?.toString() ?? '');
    // A price waiting on a live dish means "price change pending", even if a server forgot to say so.
    if (status == DishStatus.live && pending != null) status = DishStatus.changePending;
    final reason = raw['rejectionReason']?.toString().trim() ?? '';
    return DishModel(
      id: id,
      name: name,
      category: category.isEmpty ? 'Other' : category,
      price: price is num ? price.toDouble() : (double.tryParse(price?.toString() ?? '') ?? 0),
      inStock: raw['isAvailable'] is bool ? raw['isAvailable'] as bool : true,
      imageUrl: image.isEmpty ? null : image,
      status: status,
      pendingPrice: status == DishStatus.changePending ? pending : null,
      rejectionReason: (status == DishStatus.rejected && reason.isNotEmpty) ? reason : null,
      statusKnown: known || pending != null,
    );
  }
}
