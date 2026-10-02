import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';

import 'order_api.dart';

enum GatewayResultKind { success, cancelled, failed, externalWallet }

/// What the payment sheet reported. Only [proof] (on success) is trusted, and only after the
/// server has verified its signature.
class GatewayResult {
  const GatewayResult.success(PaymentProof this.proof)
      : kind = GatewayResultKind.success,
        networkProblem = false;
  const GatewayResult.cancelled()
      : kind = GatewayResultKind.cancelled,
        proof = null,
        networkProblem = false;
  const GatewayResult.failed({this.networkProblem = false})
      : kind = GatewayResultKind.failed,
        proof = null;
  const GatewayResult.externalWallet()
      : kind = GatewayResultKind.externalWallet,
        proof = null,
        networkProblem = false;

  final GatewayResultKind kind;
  final PaymentProof? proof;
  final bool networkProblem;
}

/// Opens the payment sheet for one [PaymentSession] and completes with what happened.
abstract class PaymentGateway {
  Future<GatewayResult> pay(PaymentSession session, {String? contact});
}

/// Razorpay Standard Checkout. A fresh plugin instance per attempt, cleared afterwards, so a
/// late callback from an old attempt can never complete a newer one.
class RazorpayPaymentGateway implements PaymentGateway {
  @override
  Future<GatewayResult> pay(PaymentSession session, {String? contact}) {
    final completer = Completer<GatewayResult>();
    final razorpay = Razorpay();

    void finish(GatewayResult result) {
      if (completer.isCompleted) return;
      completer.complete(result);
      razorpay.clear();
    }

    razorpay.on(Razorpay.EVENT_PAYMENT_SUCCESS, (PaymentSuccessResponse r) {
      final paymentId = r.paymentId, orderId = r.orderId, signature = r.signature;
      if (paymentId == null || orderId == null || signature == null) {
        finish(const GatewayResult.failed());
        return;
      }
      finish(GatewayResult.success(PaymentProof(razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: signature)));
    });
    razorpay.on(Razorpay.EVENT_PAYMENT_ERROR, (PaymentFailureResponse r) {
      // Never surface Razorpay's raw message (it can be a JSON blob); classify instead.
      if (r.code == Razorpay.PAYMENT_CANCELLED) {
        finish(const GatewayResult.cancelled());
      } else {
        finish(GatewayResult.failed(networkProblem: r.code == Razorpay.NETWORK_ERROR));
      }
    });
    razorpay.on(Razorpay.EVENT_EXTERNAL_WALLET, (ExternalWalletResponse r) => finish(const GatewayResult.externalWallet()));

    // `Razorpay.open` is `async void`: errors from the native side (e.g. plugin missing) escape
    // a plain try/catch, so catch them in a guarded zone and fail the attempt instead of hanging.
    runZonedGuarded(() {
      razorpay.open({
        'key': session.keyId,
        'amount': session.amountPaise,
        'currency': session.currency,
        'order_id': session.razorpayOrderId,
        'name': 'Kraveo',
        'description': 'Campus food order',
        'theme': {'color': '#006B3C'},
        if (contact != null && contact.isNotEmpty) 'prefill': {'contact': contact},
      });
    }, (error, _) {
      debugPrint('[Payment] Razorpay could not open: ${error.runtimeType}');
      finish(const GatewayResult.failed());
    });
    return completer.future;
  }
}
