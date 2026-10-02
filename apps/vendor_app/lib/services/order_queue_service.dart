import 'package:flutter/material.dart';
import '../widgets/incoming_order_dialog.dart';
import 'audio_alert_service.dart';
import 'order_queue_controller.dart';

/// Shows the full-screen "new order" takeover for each paid order waiting for an answer, one at a
/// time, in the order they arrived. The orders and the alarm belong to [OrderQueueController]; this only
/// sequences the dialogs (no duplicates, the next one opens when the current one closes).
class OrderQueueService {
  static final List<String> _queue = [];
  static String? _showingId;

  static bool get isShowingDialog => _showingId != null;
  static String? get showingOrderId => _showingId;

  /// Orders waiting behind the dialog that is open now.
  static int get pendingCount => _queue.length;

  /// Queues the takeover for [orderId]. Ignored when that order is already showing or queued.
  static void enqueueIncomingOrder(BuildContext context, String orderId, OrderQueueController controller) {
    if (_showingId == orderId || _queue.contains(orderId)) return;
    _queue.add(orderId);
    if (_showingId == null) _showNext(context, controller);
  }

  static void _showNext(BuildContext context, OrderQueueController controller) {
    while (_queue.isNotEmpty) {
      final id = _queue.removeAt(0);
      if (!context.mounted || controller.isDisposed) {
        _queue.clear();
        return;
      }
      // Answered on another phone, cancelled or expired before its turn came: nothing to ask.
      if (controller.byId(id)?.isIncoming != true) continue;
      if (!context.mounted) return;
      _showingId = id;
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => IncomingOrderDialog(orderId: id, controller: controller),
      ).whenComplete(() {
        if (_showingId == id) _showingId = null;
        // _showNext checks context.mounted before it uses the context.
        // ignore: use_build_context_synchronously
        _showNext(context, controller);
      });
      return;
    }
  }

  /// Forgets every queued pop-up and silences the alarm (logout / session expiry).
  static void clearQueue() {
    _queue.clear();
    _showingId = null;
    AudioAlertService.stopAlarm();
  }
}
