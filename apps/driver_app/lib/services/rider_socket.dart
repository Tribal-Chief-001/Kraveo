import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../config/api_config.dart';
import '../models/order_view.dart';
import 'driver_api_service.dart';

/// Something the server pushed. The socket is only a speed-up: the app polls the REST API every
/// 15 s anyway (contract section 3), so a dropped socket never leaves the rider with a wrong screen.
sealed class RiderSocketEvent {
  const RiderSocketEvent();
}

/// `order_available` in the `drivers` room (the server joins approved riders automatically): a pool
/// order appeared or changed (e.g. PREPARING -> READY_FOR_PICKUP). Add-or-update, pool view.
class OfferAvailable extends RiderSocketEvent {
  const OfferAvailable(this.order);
  final OrderView order;
}

/// `order_unavailable` `{id}`: claimed or cancelled. Remove it at once.
class OfferUnavailable extends RiderSocketEvent {
  const OfferUnavailable(this.id);
  final String id;
}

/// `order_updated` in `order_<id>`: the rider's own order changed (per-viewer OrderView).
class OrderUpdated extends RiderSocketEvent {
  const OrderUpdated(this.order);
  final OrderView order;
}

class SocketConnectionChanged extends RiderSocketEvent {
  const SocketConnectionChanged(this.connected);
  final bool connected;
}

/// Turns a raw Socket.io event into a typed one (null = ignore). Shared by the client and tests.
RiderSocketEvent? parseRiderSocketEvent(String event, Object? data) {
  switch (event) {
    case 'order_available':
      final o = OrderView.tryParse(data);
      return o == null ? null : OfferAvailable(o);
    case 'order_unavailable':
      final id = data is Map ? data['id']?.toString() : data?.toString();
      return (id == null || id.isEmpty) ? null : OfferUnavailable(id);
    case 'order_updated':
      final o = OrderView.tryParse(data);
      return o == null ? null : OrderUpdated(o);
  }
  return null;
}

abstract class RiderSocket {
  Stream<RiderSocketEvent> get events;
  bool get isConnected;

  /// Opens the connection with the saved JWT (handshake `auth: {token}`); the server puts an
  /// approved rider in the `drivers` room by itself. Safe to call repeatedly.
  Future<void> connect();
  void disconnect();

  /// Joins `order_<id>` now and after every reconnect, to hear `order_updated` for that order.
  void watchOrder(String id);
  void unwatchOrder(String id);
  void dispose();
}

/// Real Socket.io client.
class IoRiderSocket implements RiderSocket {
  IoRiderSocket({String? url}) : _url = url ?? ApiConfig.socketUrl;

  final String _url;
  final _events = StreamController<RiderSocketEvent>.broadcast();
  final _watched = <String>{};
  io.Socket? _socket;
  bool _connected = false;
  bool _connecting = false;
  bool _wanted = false;
  bool _disposed = false;

  @override
  Stream<RiderSocketEvent> get events => _events.stream;

  @override
  bool get isConnected => _connected;

  void _add(RiderSocketEvent e) {
    if (!_disposed && !_events.isClosed) _events.add(e);
  }

  @override
  Future<void> connect() async {
    _wanted = true;
    if (_disposed || _socket != null || _connecting) return;
    _connecting = true;
    try {
      final token = await DriverApiService.getSavedToken();
      // disconnect() may have been called while the token was being read.
      if (_disposed || !_wanted || token == null || token.isEmpty) return;
      final s = io.io(
        _url,
        io.OptionBuilder()
            .setTransports(['websocket'])
            .setAuth({'token': token.replaceFirst(RegExp(r'^Bearer\s+'), '')})
            .disableAutoConnect()
            .enableForceNew()
            .enableReconnection()
            .setReconnectionDelay(2000)
            .setReconnectionDelayMax(15000)
            .build(),
      );
      _socket = s;
      s.onConnect((_) {
        _connected = true;
        for (final id in _watched) {
          _join(s, id);
        }
        _add(const SocketConnectionChanged(true));
      });
      s.onDisconnect((_) {
        _connected = false;
        _add(const SocketConnectionChanged(false));
      });
      s.onConnectError((e) {
        _connected = false;
        debugPrint('[Rider socket] connect error');
      });
      for (final name in const ['order_available', 'order_unavailable', 'order_updated']) {
        s.on(name, (data) {
          final e = parseRiderSocketEvent(name, data);
          if (e != null) _add(e);
        });
      }
      s.connect();
    } catch (e) {
      debugPrint('[Rider socket] could not start');
    } finally {
      _connecting = false;
    }
  }

  @override
  void disconnect() {
    _wanted = false;
    final s = _socket;
    _socket = null;
    _connected = false;
    if (s != null) {
      try {
        s.dispose();
      } catch (_) {}
    }
  }

  @override
  void watchOrder(String id) {
    final s = _socket;
    if (_watched.add(id) && _connected && s != null) _join(s, id);
  }

  /// `join_room` answers `{ok}` through the ack. A refusal is not fatal: the 15 s REST poll still
  /// keeps the order up to date, and the next reconnect tries again.
  void _join(io.Socket s, String id) {
    s.emitWithAck('join_room', 'order_$id', ack: (dynamic res) {
      final ok = res is Map && res['ok'] == true;
      if (!ok) debugPrint('[Rider socket] order room not joined; relying on polling');
    });
  }

  @override
  void unwatchOrder(String id) => _watched.remove(id);

  @override
  void dispose() {
    _disposed = true;
    disconnect();
    _events.close();
  }
}
