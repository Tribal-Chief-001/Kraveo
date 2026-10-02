import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../config/api_config.dart';

/// Live order events for one restaurant. Only a speed-up: the order controller polls the REST list
/// every 15 s anyway, so a dropped or refused socket is invisible to the kitchen (contract section 3).
abstract class OrderSocket {
  /// Called with the raw payload of `new_order_alert` / `order_updated` (an `OrderView`).
  void Function(String event, Object? payload)? onOrderEvent;

  /// Called after every (re)connect, once the room join was sent, so the controller can catch up via REST.
  VoidCallback? onConnected;

  /// The server's answer to `join_room` (`ack({ok})`). `false` means the server refused the restaurant room:
  /// no live alerts, polling only.
  void Function(bool ok)? onRoomJoined;

  /// Connects with the JWT in the handshake (`auth: {token}`) and joins `vendor_<vendorId>`.
  void connect({required String token, required String vendorId});

  /// Called on every poll tick: reconnects if the socket gave up (e.g. the server refused the handshake,
  /// after which socket.io does not retry on its own), and asks again for a room the server refused.
  void ensureConnected();

  bool get isConnected;

  void dispose();
}

typedef OrderSocketFactory = OrderSocket Function();

/// Real Socket.io client against [ApiConfig.socketUrl].
class SocketIoOrderSocket extends OrderSocket {
  io.Socket? _socket;
  String? _vendorId;
  bool _disposed = false;

  /// When a connect attempt is in flight; a second attempt during it would send a duplicate handshake.
  DateTime? _attemptStartedAt;

  /// Last `join_room` answer (null = not answered yet).
  bool? _joined;

  void _join(io.Socket socket) {
    final id = _vendorId;
    if (id == null || _disposed) return;
    // The server checks that this login owns the restaurant and answers {ok}.
    socket.emitWithAck('join_room', 'vendor_$id', ack: (dynamic data) {
      if (_disposed) return;
      _joined = data is Map && data['ok'] == true;
      onRoomJoined?.call(_joined!);
    });
  }

  @override
  bool get isConnected => _socket?.connected ?? false;

  @override
  void connect({required String token, required String vendorId}) {
    if (_disposed) return;
    _vendorId = vendorId;
    _socket?.dispose();
    try {
      final socket = io.io(
        ApiConfig.socketUrl,
        io.OptionBuilder()
            .setTransports(['websocket'])
            .setAuth({'token': token})
            // Never reuse a cached manager: it would still carry a previous login's token.
            .enableForceNew()
            .enableReconnection()
            .disableAutoConnect()
            .build(),
      );
      _socket = socket;
      socket.onConnect((_) {
        _attemptStartedAt = null;
        if (_vendorId == null || _disposed) return;
        _join(socket);
        onConnected?.call();
      });
      for (final event in const ['new_order_alert', 'order_updated']) {
        socket.on(event, (data) {
          if (!_disposed) onOrderEvent?.call(event, data);
        });
      }
      socket.onConnectError((_) {
        _attemptStartedAt = null;
        debugPrint('[Vendor socket] connect error (polling keeps orders fresh)');
      });
      _attemptStartedAt = DateTime.now();
      socket.connect();
    } catch (e) {
      debugPrint('[Vendor socket] could not start (polling keeps orders fresh)');
    }
  }

  @override
  void ensureConnected() {
    final s = _socket;
    if (_disposed || s == null) return;
    if (s.connected) {
      if (_joined == false) _join(s);
      return;
    }
    final started = _attemptStartedAt;
    if (started != null && DateTime.now().difference(started) < const Duration(seconds: 20)) return;
    try {
      _attemptStartedAt = DateTime.now();
      s.connect();
    } catch (_) {}
  }

  @override
  void dispose() {
    _disposed = true;
    onOrderEvent = null;
    onConnected = null;
    onRoomJoined = null;
    try {
      _socket?.dispose();
    } catch (_) {}
    _socket = null;
  }
}
