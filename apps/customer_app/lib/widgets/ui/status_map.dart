import 'package:kraveo_ui/kraveo_ui.dart';
import '../../models/order.dart';

/// Maps the server's order statuses onto the shared Kraveo status language.
extension OrderStatusUi on OrderProgressStatus {
  KStatus get kStatus => switch (this) {
        OrderProgressStatus.placed => KStatus.placed,
        OrderProgressStatus.accepted => KStatus.accepted,
        OrderProgressStatus.preparing => KStatus.preparing,
        OrderProgressStatus.readyForPickup => KStatus.ready,
        OrderProgressStatus.pickedUp => KStatus.pickedUp,
        OrderProgressStatus.arrivedAtGate => KStatus.atGate,
        OrderProgressStatus.delivered => KStatus.delivered,
        OrderProgressStatus.cancelled => KStatus.cancelled,
      };

  /// Short label for pills.
  String get pillLabel => switch (this) {
        OrderProgressStatus.placed => 'Placed',
        OrderProgressStatus.accepted => 'Accepted',
        OrderProgressStatus.preparing => 'Preparing',
        OrderProgressStatus.readyForPickup => 'Ready',
        OrderProgressStatus.pickedUp => 'On the way',
        OrderProgressStatus.arrivedAtGate => 'At gate',
        OrderProgressStatus.delivered => 'Delivered',
        OrderProgressStatus.cancelled => 'Cancelled',
      };

  /// Human headline for the tracking hero.
  String get headline => switch (this) {
        OrderProgressStatus.placed => 'Waiting for the restaurant',
        OrderProgressStatus.accepted => 'Restaurant accepted',
        OrderProgressStatus.preparing => 'Cooking your food',
        OrderProgressStatus.readyForPickup => 'Packed and ready',
        OrderProgressStatus.pickedUp => 'On the way to campus',
        OrderProgressStatus.arrivedAtGate => 'Your rider is at the gate',
        OrderProgressStatus.delivered => 'Delivered. Enjoy!',
        OrderProgressStatus.cancelled => 'Order cancelled',
      };

  /// Always tell the user what happens next.
  String get nextHint => switch (this) {
        OrderProgressStatus.placed => 'Next: the restaurant confirms your order.',
        OrderProgressStatus.accepted => 'Next: the kitchen starts cooking.',
        OrderProgressStatus.preparing => 'Next: a rider picks it up once it is packed.',
        OrderProgressStatus.readyForPickup => 'Next: your rider collects it from the kitchen.',
        OrderProgressStatus.pickedUp => 'Next: meet your rider at the gate. Your OTP appears when they arrive.',
        OrderProgressStatus.arrivedAtGate => 'Tell your rider the OTP below to get your food.',
        OrderProgressStatus.delivered => 'All done. Rate your meal to earn Kraveo Coins.',
        OrderProgressStatus.cancelled => 'Nothing will be delivered for this order.',
      };

  /// Status-based progress for bars and the route strip (no invented distances or timings).
  double get progressValue => switch (this) {
        OrderProgressStatus.placed => 0.08,
        OrderProgressStatus.accepted => 0.22,
        OrderProgressStatus.preparing => 0.38,
        OrderProgressStatus.readyForPickup => 0.52,
        OrderProgressStatus.pickedUp => 0.72,
        OrderProgressStatus.arrivedAtGate => 0.95,
        OrderProgressStatus.delivered => 1.0,
        OrderProgressStatus.cancelled => 0.0,
      };

  bool get isLive => !isTerminal;
}

/// Headline that also accounts for payment (an unpaid order is not "waiting for the restaurant").
String orderHeadline(OrderModel o, {bool confirmingPayment = false}) {
  if (o.awaitsPayment) return confirmingPayment ? 'Confirming your payment' : 'Payment not completed';
  return o.status.headline;
}
