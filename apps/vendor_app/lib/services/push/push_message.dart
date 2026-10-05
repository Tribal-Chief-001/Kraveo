import 'dart:convert';

/// Push events the vendor app understands (Docs/18 section 4). Everything else is [unknown] and ignored.
enum PushEvent {
  newOrder('NEW_ORDER'),
  orderCancelledVendor('ORDER_CANCELLED_VENDOR'),
  unknown('');

  const PushEvent(this.wire);
  final String wire;

  static PushEvent parse(Object? raw) {
    final text = raw is String ? raw.trim() : '';
    for (final e in PushEvent.values) {
      if (e != PushEvent.unknown && e.wire == text) return e;
    }
    return PushEvent.unknown;
  }
}

/// The part of an FCM message the app cares about. Built from the `data` map (`{event, orderId, v}`) and never
/// throws: a missing, wrongly typed or oversized field just makes the message [isActionable] false.
class PushMessage {
  const PushMessage({required this.event, this.orderId, this.hasNotificationBlock = false, this.title, this.body});

  /// Safe for any input: null, a non-map, odd types.
  factory PushMessage.fromData(Object? data, {bool hasNotificationBlock = false, String? title, String? body}) {
    if (data is! Map) return PushMessage(event: PushEvent.unknown, hasNotificationBlock: hasNotificationBlock, title: title, body: body);
    final id = data['orderId'];
    return PushMessage(
      event: PushEvent.parse(data['event']),
      orderId: _cleanId(id),
      hasNotificationBlock: hasNotificationBlock,
      title: title,
      body: body,
    );
  }

  /// Parses the JSON payload string a local notification carries. Anything unreadable becomes an unknown message.
  factory PushMessage.fromPayload(String? payload) {
    if (payload == null || payload.isEmpty || payload.length > 2000) return const PushMessage(event: PushEvent.unknown);
    try {
      return PushMessage.fromData(jsonDecode(payload));
    } catch (_) {
      return const PushMessage(event: PushEvent.unknown);
    }
  }

  static String? _cleanId(Object? id) {
    if (id is! String) return null;
    final v = id.trim();
    if (v.isEmpty || v.length > 100) return null;
    return v;
  }

  final PushEvent event;
  final String? orderId;

  /// True when FCM carried a `notification` block, i.e. Android already shows it by itself when the app is not in the foreground.
  final bool hasNotificationBlock;

  /// Only used when the app has to build the notification itself (data-only message).
  final String? title;
  final String? body;

  /// A known event with an order to act on.
  bool get isActionable => event != PushEvent.unknown && orderId != null;

  /// What a local notification carries so a tap can be routed. Contains no personal data.
  String toPayload() => jsonEncode({'event': event.wire, 'orderId': orderId, 'v': '1'});

  @override
  String toString() => 'PushMessage(${event.wire}, order: ${orderId ?? '-'})';
}
