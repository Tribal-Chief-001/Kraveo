import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../config/api_config.dart';

/// Live order events (contract 3). Only a speed-up: the app polls REST regardless, so a dropped
/// or refused socket must never change what the student sees.
abstract class OrderRealtime {
  /// Opens the connection with the student's JWT in the handshake (`auth: {token}`).
  /// [onConnected] fires on every (re)connect so the caller can re-join rooms and refresh.
  void connect({
    required String token,
    required void Function(Object? payload) onOrderUpdated,
    required void Function(Object? payload) onRiderLocation,
    required VoidCallback onConnected,
  });

  /// Asks the server to put this socket in `order_<orderId>` (server checks ownership). The
  /// server acknowledges with `{ok}`; [onResult] gets that answer.
  void join(String orderId, [void Function(bool ok)? onResult]);

  bool get isConnected;

  /// Closes the connection for good.
  void dispose();
}

/// Socket.IO implementation against [ApiConfig.socketUrl].
class SocketOrderRealtime implements OrderRealtime {
  io.Socket? _socket;

  @override
  bool get isConnected => _socket?.connected ?? false;

  @override
  void connect({
    required String token,
    required void Function(Object? payload) onOrderUpdated,
    required void Function(Object? payload) onRiderLocation,
    required VoidCallback onConnected,
  }) {
    dispose();
    final raw = token.startsWith('Bearer ') ? token.substring(7) : token;
    final socket = io.io(
      ApiConfig.socketUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': raw})
          .disableAutoConnect()
          .enableForceNew()
          .enableReconnection()
          .setReconnectionDelay(2000)
          .setReconnectionDelayMax(15000)
          .build(),
    );
    socket.onConnect((_) => onConnected());
    socket.onConnectError((e) => debugPrint('[Order socket] connect error (REST polling continues)'));
    socket.on('order_updated', onOrderUpdated);
    socket.on('rider_location', onRiderLocation);
    _socket = socket;
    socket.connect();
  }

  @override
  void join(String orderId, [void Function(bool ok)? onResult]) {
    final socket = _socket;
    if (socket == null || !socket.connected) return; // re-joined from onConnected
    socket.emitWithAck('join_room', 'order_$orderId', ack: ([Object? data]) {
      onResult?.call(data is Map && data['ok'] == true);
    });
  }

  @override
  void dispose() {
    final socket = _socket;
    _socket = null;
    if (socket == null) return;
    socket.clearListeners();
    socket.dispose();
  }
}
