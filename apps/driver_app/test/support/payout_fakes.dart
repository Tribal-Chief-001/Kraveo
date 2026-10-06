import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:driver_app/models/payout_account.dart';
import 'package:driver_app/services/payout/payout_api.dart';
import 'package:driver_app/services/rider_orders_api.dart';

/// The real-shape fixtures (test/fixtures/payout_samples.json, copied from the backend e2e tests).
Map<String, dynamic> payoutFixtures() => (jsonDecode(File('test/fixtures/payout_samples.json').readAsStringSync()) as Map).cast<String, dynamic>();

/// A scriptable Kraveo for payout details. It behaves like the server: a save masks the account number (keeps the last 4
/// only), changed details clear `verifiedAt`, identical details answer `changed: false`.
class FakePayoutApi implements PayoutApi {
  PayoutAccount? account;
  final List<String> calls = [];

  /// Every body the app sent (to check that the right fields, and only they, travel).
  final List<Map<String, dynamic>> sentBodies = [];

  ApiResult<PayoutAccount?>? accountAnswer;
  ApiResult<SavedPayout>? saveAnswer;
  bool encryptionMissing = false;

  /// Holds [saveAccount] open until completed (in-flight and double-tap tests).
  Completer<void>? saveGate;

  /// Holds [fetchAccount] open until completed.
  Completer<void>? readGate;

  /// The full account number the last save carried (the SERVER side knows it; the app must not).
  String? serverSideNumber;

  @override
  Future<ApiResult<PayoutAccount?>> fetchAccount() async {
    calls.add('account:get');
    if (readGate != null) await readGate!.future;
    return accountAnswer ?? ApiResult.ok(account);
  }

  @override
  Future<ApiResult<SavedPayout>> saveAccount(PayoutInput input) async {
    calls.add('account:put:${input.method.wire}');
    sentBodies.add(input.toJson());
    if (saveGate != null) await saveGate!.future;
    if (saveAnswer != null) return saveAnswer!;
    if (input.method == PayoutMethod.bank && encryptionMissing) {
      return const ApiResult.fail(ApiFailure.server, code: kPayoutEncryptionCode, statusCode: 503, message: 'Payout encryption is not configured on the server, so bank accounts cannot be saved yet. UPI ids still work.');
    }
    final next = PayoutAccount(
      method: input.method,
      upiId: input.upiId,
      accountHolder: input.accountHolder,
      accountLast4: input.accountNumber?.substring(input.accountNumber!.length - 4),
      ifsc: input.ifsc,
      bankName: input.bankName,
      verifiedAt: null,
    );
    final old = account;
    final same = old != null &&
        old.method == next.method &&
        old.upiId == next.upiId &&
        old.accountHolder == next.accountHolder &&
        old.accountLast4 == next.accountLast4 &&
        old.ifsc == next.ifsc &&
        old.bankName == next.bankName;
    serverSideNumber = input.accountNumber;
    if (same) return ApiResult.ok(SavedPayout(account: old, changed: false));
    account = next;
    return ApiResult.ok(SavedPayout(account: next, changed: true));
  }
}
