import 'package:vendor_app/models/order_model.dart';
import 'fakes.dart';

/// A vendor `OrderView` of a part of a combined (multi-restaurant) order, in the exact shape of the real backend
/// (Docs/22 section 10.4, `backend/test/e2e/order_groups_lifecycle.test.ts`): the restaurant gets
/// `group: { size, allAccepted }` and NOTHING else about the group (no other restaurant, no id, no money).
Map<String, dynamic> groupedOrderJson({
  String id = 'ord-g1',
  String status = 'ACCEPTED',
  bool allAccepted = false,
  int size = 2,
  DateTime? updatedAt,
  DateTime? createdAt,
  String? cancelledBy,
  String? cancelReason,
  String paymentStatus = 'PAID',
}) =>
    orderJson(id: id, status: status, updatedAt: updatedAt, createdAt: createdAt, cancelledBy: cancelledBy, cancelReason: cancelReason, paymentStatus: paymentStatus)
      ..['group'] = {'size': size, 'allAccepted': allAccepted};

OrderModel groupedOrder({
  String id = 'ord-g1',
  String status = 'ACCEPTED',
  bool allAccepted = false,
  int size = 2,
  DateTime? updatedAt,
  DateTime? createdAt,
  String? cancelledBy,
  String? cancelReason,
  String paymentStatus = 'PAID',
}) =>
    OrderModel.fromJson(groupedOrderJson(
      id: id,
      status: status,
      allAccepted: allAccepted,
      size: size,
      updatedAt: updatedAt,
      createdAt: createdAt,
      cancelledBy: cancelledBy,
      cancelReason: cancelReason,
      paymentStatus: paymentStatus,
    ))!;
