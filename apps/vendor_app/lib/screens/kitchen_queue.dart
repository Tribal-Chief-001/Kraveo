import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import '../models/order_model.dart';
import '../widgets/order_card.dart';
import '../widgets/ui/ui.dart';

class KitchenQueueScreen extends StatefulWidget {
  final List<OrderModel> orders;
  final VoidCallback onOrderUpdate;

  const KitchenQueueScreen({
    super.key,
    required this.orders,
    required this.onOrderUpdate,
  });

  @override
  State<KitchenQueueScreen> createState() => _KitchenQueueScreenState();
}

class _KitchenQueueScreenState extends State<KitchenQueueScreen> {
  int _selectedTab = 0; // 0 = Active Queue (Preparing & Ready), 1 = History/Completed
  String _searchQuery = '';
  bool _searchOpen = false;
  final TextEditingController _searchController = TextEditingController();

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;

    // Filter orders
    final activeOrders = widget.orders.where((o) => o.status == OrderStatus.preparing || o.status == OrderStatus.readyForPickup).toList();
    final completedOrders = widget.orders.where((o) => o.status == OrderStatus.pickedUp || o.status == OrderStatus.delivered || o.status == OrderStatus.cancelled).toList();

    final currentList = _selectedTab == 0 ? activeOrders : completedOrders;

    final filteredList = currentList.where((o) {
      if (_searchQuery.isEmpty) return true;
      final q = _searchQuery.toLowerCase();
      return o.id.toLowerCase().contains(q) ||
          o.studentName.toLowerCase().contains(q) ||
          o.studentLocation.toLowerCase().contains(q);
    }).toList();

    // Most urgent first: the promised-by time never changes, so this order stays put
    // under the cook's thumb while the countdowns tick.
    final cooking = filteredList.where((o) => o.status == OrderStatus.preparing).toList()
      ..sort((a, b) => a.targetCompletionTime.compareTo(b.targetCompletionTime));
    final ready = filteredList.where((o) => o.status == OrderStatus.readyForPickup).toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    final history = filteredList.where((o) => o.status != OrderStatus.preparing && o.status != OrderStatus.readyForPickup).toList()
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));

    final children = <Widget>[];
    var revealIndex = 0;
    Widget card(OrderModel o) => KReveal(
          key: ValueKey('reveal-${o.id}'),
          index: revealIndex++,
          child: OrderCard(
            key: ValueKey(o.id),
            order: o,
            onStatusChanged: () {
              setState(() {});
              widget.onOrderUpdate();
            },
            onItemToggle: () {
              setState(() {});
            },
          ),
        );

    if (_selectedTab == 0) {
      if (cooking.isNotEmpty) {
        children.add(VSectionLabel(english: 'Cooking', hindi: 'बन रहे हैं', count: cooking.length));
        children.addAll(cooking.map(card));
      }
      if (ready.isNotEmpty) {
        children.add(VSectionLabel(english: 'Ready for pickup', hindi: 'तैयार', count: ready.length));
        children.addAll(ready.map(card));
      }
    } else {
      children.addAll(history.map(card));
    }

    return VMaxWidth(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 8),
            child: Row(children: [
              Expanded(
                child: VChoiceChip(
                  label: 'Active',
                  sublabel: 'चालू · ${activeOrders.length}',
                  selected: _selectedTab == 0,
                  onTap: () => setState(() => _selectedTab = 0),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: VChoiceChip(
                  label: 'History',
                  sublabel: 'पुराने · ${completedOrders.length}',
                  selected: _selectedTab == 1,
                  onTap: () => setState(() => _selectedTab = 1),
                ),
              ),
              const SizedBox(width: 8),
              Semantics(
                button: true,
                label: _searchOpen ? 'Close search' : 'Search orders',
                excludeSemantics: true,
                child: KPressable(
                  onTap: () => setState(() {
                    _searchOpen = !_searchOpen;
                    if (!_searchOpen) {
                      _searchQuery = '';
                      _searchController.clear();
                    }
                  }),
                  child: Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(
                      color: _searchOpen ? k.brandSoft : k.surface,
                      borderRadius: BorderRadius.circular(KRadius.lg),
                      border: Border.all(color: _searchOpen ? k.brand : k.line, width: 1.5),
                    ),
                    child: Icon(_searchOpen ? LucideIcons.x : LucideIcons.search, size: 26, color: k.brand),
                  ),
                ),
              ),
            ]),
          ),
          AnimatedSize(
            duration: KMotion.base,
            curve: KMotion.emphasized,
            alignment: Alignment.topCenter,
            child: _searchOpen
                ? Padding(
                    padding: const EdgeInsets.fromLTRB(KSpace.gutter, 0, KSpace.gutter, 8),
                    child: TextField(
                      controller: _searchController,
                      autofocus: true,
                      onChanged: (val) => setState(() => _searchQuery = val),
                      style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 18),
                      decoration: InputDecoration(
                        hintText: 'Search order or student  ·  खोजें',
                        prefixIcon: Icon(LucideIcons.search, size: 22, color: k.inkFaint),
                      ),
                    ),
                  )
                : const SizedBox(width: double.infinity),
          ),
          Expanded(
            child: children.isEmpty
                ? KEmptyState(
                    icon: _selectedTab == 0 ? LucideIcons.chefHat : LucideIcons.history,
                    title: _searchQuery.isNotEmpty
                        ? 'No matching orders'
                        : _selectedTab == 0
                            ? 'No orders right now'
                            : 'No history yet',
                    message: _searchQuery.isNotEmpty
                        ? 'Try a different name or order number.\nदूसरा नाम या नंबर आज़माएं।'
                        : _selectedTab == 0
                            ? 'New orders will ring loudly and show here.\nनया ऑर्डर आते ही अलार्म बजेगा।'
                            : 'Finished orders will be listed here.\nपूरे हुए ऑर्डर यहाँ दिखेंगे।',
                  )
                : ListView(
                    padding: const EdgeInsets.fromLTRB(KSpace.gutter, 4, KSpace.gutter, 24),
                    children: children,
                  ),
          ),
        ],
      ),
    );
  }
}
