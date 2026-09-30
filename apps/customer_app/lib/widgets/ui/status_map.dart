import 'package:kraveo_ui/kraveo_ui.dart';
import '../../models/order.dart';

/// Maps the app's order lifecycle onto the shared Kraveo status language.
extension OrderStatusUi on OrderProgressStatus {
  KStatus get kStatus => switch (this) {
        OrderProgressStatus.placed => KStatus.placed,
        OrderProgressStatus.preparing => KStatus.preparing,
        OrderProgressStatus.pickedUp => KStatus.ready,
        OrderProgressStatus.onTheWay => KStatus.pickedUp,
        OrderProgressStatus.arrivedAtGate => KStatus.atGate,
        OrderProgressStatus.delivered => KStatus.delivered,
        OrderProgressStatus.cancelled => KStatus.cancelled,
      };

  /// Short label for pills.
  String get pillLabel => switch (this) {
        OrderProgressStatus.placed => 'Placed',
        OrderProgressStatus.preparing => 'Preparing',
        OrderProgressStatus.pickedUp => 'Picked up',
        OrderProgressStatus.onTheWay => 'On the way',
        OrderProgressStatus.arrivedAtGate => 'At gate',
        OrderProgressStatus.delivered => 'Delivered',
        OrderProgressStatus.cancelled => 'Cancelled',
      };

  /// Human headline for the tracking hero.
  String get headline => switch (this) {
        OrderProgressStatus.placed => 'Order placed',
        OrderProgressStatus.preparing => 'Cooking your food',
        OrderProgressStatus.pickedUp => 'Runner has your food',
        OrderProgressStatus.onTheWay => 'On the way to campus',
        OrderProgressStatus.arrivedAtGate => 'Your runner is at the gate',
        OrderProgressStatus.delivered => 'Delivered. Enjoy!',
        OrderProgressStatus.cancelled => 'Order cancelled',
      };

  /// Always tell the user what happens next.
  String get nextHint => switch (this) {
        OrderProgressStatus.placed => 'Next: the kitchen confirms and starts cooking.',
        OrderProgressStatus.preparing => 'Next: a runner picks it up once it is packed.',
        OrderProgressStatus.pickedUp => 'Next: your runner heads to your hostel gate.',
        OrderProgressStatus.onTheWay => 'Next: meet your runner at the gate with your OTP.',
        OrderProgressStatus.arrivedAtGate => 'Share the OTP below with your runner to get your food.',
        OrderProgressStatus.delivered => 'All done. Rate your meal to earn 10 Kraveo Coins.',
        OrderProgressStatus.cancelled => 'Nothing will be delivered for this order.',
      };

  bool get isLive => this != OrderProgressStatus.delivered && this != OrderProgressStatus.cancelled;
}
