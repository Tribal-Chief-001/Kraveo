import 'dart:async';
import 'package:flutter/material.dart';
import '../models/order_model.dart';
import '../widgets/incoming_order_dialog.dart';
import 'audio_alert_service.dart';

class OrderQueueService {
  static final List<OrderModel> _incomingQueue = [];
  static bool _isShowingDialog = false;

  /// Enqueues a new incoming order alert and presents modal dialogs sequentially.
  static void enqueueIncomingOrder(BuildContext context, OrderModel newOrder, Function(OrderModel acceptedOrder) onOrderAccepted) {
    _incomingQueue.add(newOrder);
    print('📥 [Order Queue Engine] Enqueued incoming order ${newOrder.id}. Queue length: ${_incomingQueue.length}');

    if (!_isShowingDialog) {
      _processNextOrderInQueue(context, onOrderAccepted);
    }
  }

  static void _processNextOrderInQueue(BuildContext context, Function(OrderModel acceptedOrder) onOrderAccepted) {
    if (_incomingQueue.isEmpty) {
      _isShowingDialog = false;
      AudioAlertService.stopAlarm();
      print('🔕 [Order Queue Engine] All pending incoming order alerts resolved.');
      return;
    }

    _isShowingDialog = true;
    final currentOrder = _incomingQueue.removeAt(0);

    // Start loud continuous alarm for current order
    AudioAlertService.startLoudAlarm();

    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => IncomingOrderDialog(
        order: currentOrder,
        onAccept: (acceptedOrder) {
          AudioAlertService.stopAlarm();
          onOrderAccepted(acceptedOrder);

          // Process next order in queue after short delay
          Future.delayed(const Duration(milliseconds: 300), () {
            if (context.mounted) {
              _processNextOrderInQueue(context, onOrderAccepted);
            }
          });
        },
        onDecline: () {
          AudioAlertService.stopAlarm();
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Order ${currentOrder.id} Declined / अस्वीकार किया'),
              backgroundColor: const Color(0xFFBA1A1A),
            ),
          );

          // Process next order in queue after short delay
          Future.delayed(const Duration(milliseconds: 300), () {
            if (context.mounted) {
              _processNextOrderInQueue(context, onOrderAccepted);
            }
          });
        },
      ),
    );
  }

  static int get pendingCount => _incomingQueue.length;
}
