import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/main.dart';
import 'package:vendor_app/models/payout_account.dart';
import 'package:vendor_app/models/settlement.dart';
import 'package:vendor_app/screens/payout_details_screen.dart';
import 'package:vendor_app/screens/settlements_screen.dart';
import 'package:vendor_app/services/order_queue_service.dart';
import 'package:vendor_app/services/payout/payout_api.dart';
import 'package:vendor_app/services/payout/payout_controller.dart';
import 'package:vendor_app/services/payout/settlements_controller.dart';
import 'package:vendor_app/services/vendor_api_service.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'package:vendor_app/widgets/payout_banner.dart';
import 'support/fakes.dart';
import 'support/payout_fakes.dart';
import 'support/signed_in.dart';

/// Docs/21 section 5 and 7: the restaurant's "Payout details" and "My settlements". Models are parsed from the shapes the
/// backend e2e tests assert (test/fixtures/payout_samples.json); the screens run against a fake that behaves like the server.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    for (final ch in const ['xyz.luan/audioplayers.global', 'xyz.luan/audioplayers']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(ch), (call) async => null);
    }
  });

  const fullNumber = '50100234567890';

  // ------------------------------------------------------------------------------------------------ models

  group('PayoutAccount (real fixtures)', () {
    test('a UPI account: nothing masked, no last 4', () {
      final a = PayoutAccount.fromJson(payoutFixtures()['account_upi']['data'])!;
      expect((a.method, a.upiId, a.accountHolder, a.accountLast4, a.ifsc, a.verified), (PayoutMethod.upi, 'ram@okhdfcbank', 'Ram Singh', null, null, false));
      expect(a.destinationText, 'ram@okhdfcbank');
    });

    test('a verified bank account is only ever "Account ending 7890"', () {
      final a = PayoutAccount.fromJson(payoutFixtures()['account_bank_verified']['data'])!;
      expect((a.method, a.accountLast4, a.ifsc, a.bankName, a.verified), (PayoutMethod.bank, '7890', 'HDFC0001234', 'HDFC Bank', true));
      expect(a.destinationText, 'Account ending 7890');
    });

    test('even if a server sent a whole number, only the last 4 digits are kept', () {
      final a = PayoutAccount.fromJson({'method': 'BANK', 'accountLast4': fullNumber, 'accountNumber': fullNumber})!;
      expect(a.accountLast4, '7890');
      expect(a.destinationText, isNot(contains('5010')));
    });

    test('no method or not an object: not an account', () {
      expect(PayoutAccount.fromJson(null), isNull);
      expect(PayoutAccount.fromJson({'upiId': 'a@b'}), isNull);
      expect(PayoutAccount.fromJson({'method': 'CASH'}), isNull);
    });

    test('PayoutInput bodies carry only the fields of their method, and its text never has the number', () {
      expect(const PayoutInput.upi(upiId: 'ram@upi').toJson(), {'method': 'UPI', 'upiId': 'ram@upi'});
      expect(const PayoutInput.upi(upiId: 'ram@upi', accountHolder: 'Ram').toJson(), {'method': 'UPI', 'upiId': 'ram@upi', 'accountHolder': 'Ram'});
      const bank = PayoutInput.bank(accountHolder: 'Ram Singh', accountNumber: fullNumber, ifsc: 'HDFC0001234');
      expect(bank.toJson(), {'method': 'BANK', 'accountHolder': 'Ram Singh', 'accountNumber': fullNumber, 'ifsc': 'HDFC0001234'});
      expect(bank.toString(), isNot(contains(fullNumber)));
    });
  });

  group('payout validation (the server rules)', () {
    test('UPI id: trimmed and lower-cased, needs name@handle', () {
      expect(PayoutRules.upiId('  Ram@OkHDFCBank '), isNull);
      expect(PayoutRules.upiId('ram.singh-1@ybl'), isNull);
      expect(PayoutRules.upiId(''), isNotNull);
      expect(PayoutRules.upiId('ram'), isNotNull);
      expect(PayoutRules.upiId('ram@'), isNotNull);
      expect(PayoutRules.upiId('@upi'), isNotNull);
      expect(PayoutRules.upiId('r@upi'), isNotNull); // the name part is at least 2 characters
      expect(PayoutRules.upiId('ram singh@upi'), isNotNull);
      expect(PayoutRules.normalizeUpi(' Ram@OkHDFCBank '), 'ram@okhdfcbank');
    });

    test('account holder: 2 to 80 letters, spaces and . \' -; required only for a bank account', () {
      expect(PayoutRules.holder('', required: false), isNull);
      expect(PayoutRules.holder('', required: true), isNotNull);
      expect(PayoutRules.holder('Ram Singh', required: true), isNull);
      expect(PayoutRules.holder("D'Souza-Rao Jr.", required: true), isNull);
      expect(PayoutRules.holder('राम सिंह', required: true), isNull);
      expect(PayoutRules.holder('R', required: true), isNotNull);
      expect(PayoutRules.holder('Ram 2', required: true), isNotNull);
      expect(PayoutRules.holder('A' * 81, required: true), isNotNull);
    });

    test('account number: digits only, 6 to 20; spaces and dashes pasted from a statement are dropped', () {
      expect(PayoutRules.accountNumber(fullNumber), isNull);
      expect(PayoutRules.accountNumber('5010 0234-5678'), isNull);
      expect(PayoutRules.accountNumber('12345'), isNotNull);
      expect(PayoutRules.accountNumber('1' * 21), isNotNull);
      expect(PayoutRules.accountNumber('12345a'), isNotNull);
      expect(PayoutRules.accountNumber(''), isNotNull);
    });

    test('the number must be typed twice and match', () {
      expect(PayoutRules.accountConfirm('123456', '123456'), isNull);
      expect(PayoutRules.accountConfirm('123456', '123 456'), isNull);
      expect(PayoutRules.accountConfirm('123456', '123457'), contains('do not match'));
      expect(PayoutRules.accountConfirm('123456', ''), contains('again'));
    });

    test('IFSC: upper-cased, 4 letters + 0 + 6 letters or digits', () {
      expect(PayoutRules.ifsc('hdfc0001234'), isNull);
      expect(PayoutRules.normalizeIfsc(' hdfc0001234 '), 'HDFC0001234');
      expect(PayoutRules.ifsc('HDFC1001234'), isNotNull); // fifth character must be 0
      expect(PayoutRules.ifsc('HDF00001234'), isNotNull);
      expect(PayoutRules.ifsc('HDFC000123'), isNotNull);
      expect(PayoutRules.ifsc(''), isNotNull);
    });

    test('bank name is optional, 2 to 60 characters', () {
      expect(PayoutRules.bankName(''), isNull);
      expect(PayoutRules.bankName('HDFC Bank'), isNull);
      expect(PayoutRules.bankName('H'), isNotNull);
      expect(PayoutRules.bankName('B' * 61), isNotNull);
    });

    test('PayoutForm: UPI builds a clean request; blank holder is left out', () {
      const form = PayoutForm(method: PayoutMethod.upi, upiId: ' Ram@OkHDFCBank ');
      expect(form.errors, isEmpty);
      expect(form.build()!.toJson(), {'method': 'UPI', 'upiId': 'ram@okhdfcbank'});
      expect(const PayoutForm(method: PayoutMethod.upi, upiId: 'ram@upi', accountHolder: '  Ram   Singh ').build()!.toJson()['accountHolder'], 'Ram Singh');
    });

    test('PayoutForm: bank reports every wrong field, and mismatch only once the number itself is valid', () {
      final all = const PayoutForm(method: PayoutMethod.bank).errors;
      expect(all.keys.toSet(), {'accountHolder', 'accountNumber', 'ifsc'});
      final mismatch = const PayoutForm(method: PayoutMethod.bank, accountHolder: 'Ram Singh', accountNumber: '123456', accountConfirm: '123450', ifsc: 'HDFC0001234').errors;
      expect(mismatch.keys, ['accountConfirm']);
      expect(const PayoutForm(method: PayoutMethod.bank, accountHolder: 'Ram Singh', accountNumber: '12', ifsc: 'HDFC0001234').errors.keys, ['accountNumber']);
      const ok = PayoutForm(method: PayoutMethod.bank, accountHolder: ' Ram  Singh', accountNumber: '5010 0234 567890', accountConfirm: fullNumber, ifsc: 'hdfc0001234', bankName: ' HDFC Bank ');
      expect(ok.errors, isEmpty);
      expect(ok.build()!.toJson(), {'method': 'BANK', 'accountHolder': 'Ram Singh', 'accountNumber': fullNumber, 'ifsc': 'HDFC0001234', 'bankName': 'HDFC Bank'});
    });

    test('PayoutForm: UPI fields typed earlier do not block a bank form (and the other way round)', () {
      expect(const PayoutForm(method: PayoutMethod.upi, upiId: 'ram@upi', accountNumber: 'abc').errors, isEmpty);
      expect(const PayoutForm(method: PayoutMethod.bank, upiId: 'garbage', accountHolder: 'Ram', accountNumber: '123456', accountConfirm: '123456', ifsc: 'HDFC0001234').errors, isEmpty);
    });
  });

  group('Settlement models (real fixtures)', () {
    test('the list: statuses, amounts, UTR and paid date', () {
      final list = (payoutFixtures()['settlements_list']['data'] as List).map(Settlement.fromJson).toList();
      expect(list.map((s) => s!.status), [SettlementStatus.onHold, SettlementStatus.paid, SettlementStatus.pending]);
      final hold = list[0]!;
      expect((hold.orderCount, hold.vendorAmount, hold.adjustmentTotal, hold.netPayable, hold.paidAt, hold.paymentReference), (1, 198.22, -3.0, 195.22, null, null));
      final paid = list[1]!;
      expect((paid.isPaid, paid.paymentReference, paid.netPayable, paid.paidAt!.toUtc().hour), (true, 'UTR402611223344', 2450.5, 4));
    });

    test('the detail: dish lines, orders, adjustments', () {
      final d = SettlementDetail.fromJson(payoutFixtures()['settlement_detail']['data'])!;
      expect(d.dishes.single.name, 'Thali');
      expect((d.dishes.single.units, d.dishes.single.amount), (2, 198.22));
      expect((d.orders.single.amount, d.orders.single.shortId), (198.22, 'ABCDEF12'));
      expect((d.adjustments.single.amount, d.adjustments.single.reason), (-3.0, 'Missing item credit'));
      expect(d.ordersTruncated, isFalse);
    });

    test('a word we do not know counts as pending, never as paid; unreadable entries are dropped', () {
      expect(SettlementStatus.parse('SOMETHING_NEW'), SettlementStatus.pending);
      expect(SettlementStatus.parse(null), SettlementStatus.pending);
      expect(Settlement.fromJson({'id': 'a', 'status': 'PAID'}), isNull); // no amount, no period
      expect(Settlement.fromJson({'netPayable': 5, 'periodStart': '2026-10-06T00:00:00Z'}), isNull); // no id
      expect(Settlement.fromJson('x'), isNull);
    });

    test('the models have no place for customer prices, fees or commission, even when a server sent them', () {
      final json = Map<String, dynamic>.from((payoutFixtures()['settlements_list']['data'] as List).first as Map)
        ..['commissionAmount'] = 37.32
        ..['foodGross'] = 235.54
        ..['deliveryFee'] = 25;
      final s = Settlement.fromJson(json)!;
      expect(s.vendorAmount, 198.22);
      final texts = '${s.vendorAmount} ${s.adjustmentTotal} ${s.netPayable}';
      expect(texts, isNot(contains('37.32')));
      expect(texts, isNot(contains('235.54')));
    });
  });

  group('India dates', () {
    test('an instant is shown as its India (UTC+5:30) date', () {
      expect(formatIstDate(DateTime.utc(2026, 10, 6, 18, 29)), '6 Oct 2026');
      expect(formatIstDate(DateTime.utc(2026, 10, 6, 18, 30)), '7 Oct 2026'); // midnight in India
      expect(formatIstDateTime(DateTime.utc(2026, 10, 6, 4, 45)), '6 Oct 2026, 10:15 AM');
      expect(formatIstDateTime(DateTime.utc(2026, 10, 6, 16, 30)), '6 Oct 2026, 10:00 PM');
      expect(formatIstDateTime(DateTime.utc(2026, 10, 6, 18, 30)), '7 Oct 2026, 12:00 AM');
    });

    test('the period is one date when it is one India day, else a range', () {
      expect(settlementPeriodText(DateTime.utc(2026, 10, 6, 5), DateTime.utc(2026, 10, 6, 16, 30)), '6 Oct 2026');
      expect(settlementPeriodText(DateTime.utc(2026, 10, 5, 14), DateTime.utc(2026, 10, 6, 16, 30)), '5 Oct to 6 Oct 2026');
      expect(settlementPeriodText(DateTime.utc(2026, 12, 31, 5), DateTime.utc(2027, 1, 1, 16, 30)), '31 Dec 2026 to 1 Jan 2027');
    });
  });

  // ------------------------------------------------------------------------------------------------ http

  group('HTTP: payout API', () {
    late List<http.Request> sent;
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      await VendorApiService.saveToken('jwt-abc');
      sent = [];
    });
    tearDown(() => VendorApiService.clearToken());

    Future<T> withServer<T>(Future<T> Function() body, http.Response Function(http.Request) handler) => http.runWithClient(body, () => MockClient((r) async {
          sent.add(r);
          return handler(r);
        }));

    http.Response json(Object body, [int status = 200]) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

    final api = HttpPayoutApi();

    test('GET /partner/payout-account with the bearer token: {data: null} is a success with nothing saved', () async {
      final res = await withServer(api.fetchAccount, (_) => json(payoutFixtures()['account_none']));
      expect(sent.single.method, 'GET');
      expect(sent.single.url.path, endsWith('/partner/payout-account'));
      expect(sent.single.headers['Authorization'], 'Bearer jwt-abc');
      expect((res.ok, res.data), (true, null));
    });

    test('GET reads a bank account masked', () async {
      final res = await withServer(api.fetchAccount, (_) => json(payoutFixtures()['account_bank_verified']));
      expect(res.data!.accountLast4, '7890');
      expect(res.data!.verified, isTrue);
    });

    test('a 200 without `data` or with an unreadable one is an error, not "nothing saved"', () async {
      expect((await withServer(api.fetchAccount, (_) => json({'success': true}))).failure, ApiFailure.server);
      expect((await withServer(api.fetchAccount, (_) => json({'data': {'method': 'CASH'}}))).failure, ApiFailure.server);
    });

    test('PUT sends exactly the UPI fields and reads the answer (changed + masked account)', () async {
      final res = await withServer(() => api.saveAccount(const PayoutInput.upi(upiId: 'ram@okhdfcbank', accountHolder: 'Ram Singh')), (_) => json(payoutFixtures()['account_upi']));
      expect(sent.single.method, 'PUT');
      expect(sent.single.url.path, endsWith('/partner/payout-account'));
      expect(jsonDecode(sent.single.body), {'method': 'UPI', 'upiId': 'ram@okhdfcbank', 'accountHolder': 'Ram Singh'});
      expect((res.data!.changed, res.data!.account.upiId, res.data!.account.verified), (true, 'ram@okhdfcbank', false));
    });

    test('PUT bank sends the number once; the answer is masked', () async {
      final res = await withServer(
          () => api.saveAccount(const PayoutInput.bank(accountHolder: 'Ram Singh', accountNumber: fullNumber, ifsc: 'HDFC0001234', bankName: 'HDFC Bank')), (_) => json(payoutFixtures()['account_bank_verified']));
      expect(jsonDecode(sent.single.body)['accountNumber'], fullNumber);
      expect(res.data!.account.destinationText, 'Account ending 7890');
    });

    test('503 PAYOUT_ENCRYPTION_NOT_CONFIGURED becomes the plain "use UPI or try later" text', () async {
      final res = await withServer(() => api.saveAccount(const PayoutInput.bank(accountHolder: 'Ram', accountNumber: fullNumber, ifsc: 'HDFC0001234')), (_) => json(payoutFixtures()['encryption_missing'], 503));
      expect((res.ok, res.code, res.statusCode), (false, 'PAYOUT_ENCRYPTION_NOT_CONFIGURED', 503));
      final text = payoutFailureText(res);
      expect(text.english, 'Bank details cannot be saved right now. Use UPI, or try again later.');
    });

    test('400 shows the server sentence; 404 (old server), 403, 429, offline and timeout have their own words', () async {
      final bad = await withServer(() => api.saveAccount(const PayoutInput.upi(upiId: 'x@y')), (_) => json({'success': false, 'code': 'BAD_REQUEST', 'field': 'upiId', 'message': 'That does not look like a UPI id (for example name@okhdfcbank).'}, 400));
      expect(payoutFailureText(bad).english, 'That does not look like a UPI id (for example name@okhdfcbank).');
      expect(payoutFailureText(await withServer(api.fetchAccount, (_) => http.Response('<html>Cannot GET</html>', 404))).english, contains('not available'));
      expect(payoutFailureText(await withServer(api.fetchAccount, (_) => json({'code': 'FORBIDDEN'}, 403))).english, contains('cannot do this'));
      expect(payoutFailureText(await withServer(api.fetchAccount, (_) => json({}, 429))).english, contains('Too many'));
      final offline = await http.runWithClient(api.fetchAccount, () => MockClient((_) async => throw http.ClientException('no route')));
      expect(offline.failure, ApiFailure.offline);
      expect(payoutFailureText(offline).english, contains('No internet'));
      final slow = await http.runWithClient(HttpPayoutApi(timeout: const Duration(milliseconds: 20)).fetchAccount, () => MockClient((_) => Completer<http.Response>().future));
      expect(slow.failure, ApiFailure.timeout);
    });

    test('GET /partner/settlements?page&pageSize reads the page; an unreadable entry is counted, not shown', () async {
      final body = Map<String, dynamic>.from(payoutFixtures()['settlements_list'])..['data'] = [...(payoutFixtures()['settlements_list']['data'] as List), {'id': 'broken'}];
      final res = await withServer(() => api.fetchSettlements(page: 2, pageSize: 10), (_) => json(body));
      expect(sent.single.url.path, endsWith('/partner/settlements'));
      expect(sent.single.url.queryParameters, {'page': '2', 'pageSize': '10'});
      expect((res.data!.items.length, res.data!.skipped, res.data!.total, res.data!.pages), (3, 1, 3, 1));
    });

    test('GET /partner/settlements/:id reads the detail; ids are encoded', () async {
      final res = await withServer(() => api.fetchSettlement('a/b c'), (_) => json(payoutFixtures()['settlement_detail']));
      expect(sent.single.url.path, endsWith('/partner/settlements/a%2Fb%20c'));
      expect(res.data!.dishes.single.name, 'Thali');
      expect((await withServer(() => api.fetchSettlement('x'), (_) => json({'success': false, 'code': 'NOT_FOUND', 'message': 'Settlement not found.'}, 404))).failure, ApiFailure.notFound);
    });

    test('a 401 goes through the same session hook as every other call', () async {
      var expired = 0;
      VendorApiService.onUnauthorized = () => expired++;
      addTearDown(() => VendorApiService.onUnauthorized = null);
      final res = await withServer(api.fetchAccount, (_) => json({'message': 'Unauthorized'}, 401));
      expect((res.failure, expired), (ApiFailure.unauthorized, 1));
    });
  });

  // ------------------------------------------------------------------------------------------------ controllers

  PayoutInput upiInput([String id = 'ram@okhdfcbank']) => PayoutInput.upi(upiId: id, accountHolder: 'Ram Singh');
  const bankInput = PayoutInput.bank(accountHolder: 'Ram Singh', accountNumber: fullNumber, ifsc: 'HDFC0001234', bankName: 'HDFC Bank');

  group('PayoutController', () {
    test('load: nothing saved -> missing + banner; saved -> no banner', () async {
      final api = FakePayoutApi();
      final c = PayoutController(api: api);
      expect((c.loaded, c.missing, c.showBanner), (false, false, false));
      await c.load();
      expect((c.loaded, c.account, c.missing, c.showBanner), (true, null, true, true));
      api.account = PayoutAccount.fromJson(payoutFixtures()['account_upi']['data']);
      await c.load();
      expect((c.missing, c.showBanner, c.account!.upiId), (false, false, 'ram@okhdfcbank'));
      c.dispose();
    });

    test('a failed first read is not "missing": no banner, a message, and a retry works', () async {
      final api = FakePayoutApi()..accountAnswer = const ApiResult.failure(ApiFailure.offline);
      final c = PayoutController(api: api);
      await c.load();
      expect((c.loaded, c.missing, c.showBanner), (false, false, false));
      expect(c.loadFailure!.english, contains('No internet'));
      api.accountAnswer = null;
      await c.load();
      expect((c.loaded, c.loadFailure, c.missing), (true, null, true));
      c.dispose();
    });

    test('a failed re-read keeps the saved account', () async {
      final api = FakePayoutApi()..account = PayoutAccount.fromJson(payoutFixtures()['account_upi']['data']);
      final c = PayoutController(api: api);
      await c.load();
      api.accountAnswer = const ApiResult.failure(ApiFailure.server);
      await c.load();
      expect((c.account!.upiId, c.loaded), ('ram@okhdfcbank', true));
      expect(c.loadFailure, isNotNull);
      c.dispose();
    });

    test('the banner can be closed for this login and does not come back on its own', () async {
      final c = PayoutController(api: FakePayoutApi());
      await c.load();
      expect(c.showBanner, isTrue);
      c.dismissBanner();
      expect(c.showBanner, isFalse);
      await c.load();
      expect(c.showBanner, isFalse);
      c.dispose();
    });

    test('save: stores the masked account, remembers the answer, and the banner goes', () async {
      final api = FakePayoutApi();
      final c = PayoutController(api: api);
      await c.load();
      expect(await c.save(upiInput()), isTrue);
      expect((c.account!.upiId, c.lastSaved!.changed, c.missing, c.showBanner, c.saving), ('ram@okhdfcbank', true, false, false, false));
      c.dispose();
    });

    test('a bank save keeps only the last 4 digits anywhere in the controller', () async {
      final api = FakePayoutApi();
      final c = PayoutController(api: api);
      await c.load();
      expect(await c.save(bankInput), isTrue);
      expect((c.account!.accountLast4, c.account!.destinationText), ('7890', 'Account ending 7890'));
      expect(c.account.toString().contains(fullNumber), isFalse);
      expect(api.serverSideNumber, fullNumber); // the server got it, once
      c.dispose();
    });

    test('a double tap sends ONE request (the second returns false at once)', () async {
      final api = FakePayoutApi()..saveGate = Completer<void>();
      final c = PayoutController(api: api);
      final first = c.save(upiInput());
      expect(c.saving, isTrue);
      expect(await c.save(upiInput()), isFalse);
      api.saveGate!.complete();
      expect(await first, isTrue);
      expect(api.calls.where((x) => x.startsWith('account:put')), hasLength(1));
      c.dispose();
    });

    test('saving the same details again says "not changed" and keeps a verified account verified', () async {
      final api = FakePayoutApi();
      final c = PayoutController(api: api);
      await c.save(upiInput());
      api.account = PayoutAccount(method: PayoutMethod.upi, upiId: 'ram@okhdfcbank', accountHolder: 'Ram Singh', verifiedAt: DateTime.utc(2026, 10, 6));
      await c.save(upiInput());
      expect((c.lastSaved!.changed, c.account!.verified), (false, true));
      c.dispose();
    });

    test('saving DIFFERENT details gives an unverified account (verification restarts)', () async {
      final api = FakePayoutApi()..account = PayoutAccount(method: PayoutMethod.upi, upiId: 'ram@okhdfcbank', accountHolder: 'Ram Singh', verifiedAt: DateTime.utc(2026, 10, 6));
      final c = PayoutController(api: api);
      await c.load();
      expect(c.account!.verified, isTrue);
      await c.save(upiInput('ram@ybl'));
      expect((c.lastSaved!.changed, c.account!.verified, c.account!.upiId), (true, false, 'ram@ybl'));
      c.dispose();
    });

    test('503 encryption missing: the save fails with the plain message and the old details stay', () async {
      final api = FakePayoutApi()..encryptionMissing = true;
      final c = PayoutController(api: api);
      await c.load();
      expect(await c.save(bankInput), isFalse);
      expect(c.saveProblem!.english, contains('Use UPI'));
      expect((c.account, c.saving), (null, false));
      expect(await c.save(upiInput()), isTrue); // UPI still works
      expect(c.saveProblem, isNull);
      c.dispose();
    });
  });

  group('SettlementsController', () {
    List<Settlement> three() => (payoutFixtures()['settlements_list']['data'] as List).map((e) => Settlement.fromJson(e)!).toList();

    test('load: first page, then older pages appended without duplicates', () async {
      final api = FakePayoutApi()..settlements = three();
      final c = SettlementsController(api: api);
      expect((c.loadedOnce, c.isEmpty), (false, false));
      await c.load();
      expect((c.items.length, c.hasMore, c.loadedOnce), (2, true, true));
      await c.loadMore();
      expect((c.items.length, c.hasMore), (3, false));
      await c.loadMore(); // nothing more: no request
      expect(api.calls, ['settlements:1', 'settlements:2']);
      c.dispose();
    });

    test('empty list is an empty state, not an error', () async {
      final c = SettlementsController(api: FakePayoutApi());
      await c.load();
      expect((c.isEmpty, c.failure), (true, null));
      c.dispose();
    });

    test('a failed first load keeps loadedOnce false; retry loads; a failed refresh keeps the old list', () async {
      final api = FakePayoutApi()
        ..settlements = three()
        ..listAnswers.add(const ApiResult.failure(ApiFailure.offline));
      final c = SettlementsController(api: api);
      await c.load();
      expect(c.loadedOnce, false);
      expect(c.items, isEmpty);
      expect(c.failure!.english, contains('No internet'));
      await c.load();
      expect((c.loadedOnce, c.failure, c.items.length), (true, null, 2));
      api.listAnswers.add(const ApiResult.failure(ApiFailure.server));
      await c.load();
      expect((c.items.length, c.loadedOnce), (2, true));
      expect(c.failure, isNotNull);
      c.dispose();
    });

    test('a failed "older" page leaves the list and can be tried again', () async {
      final api = FakePayoutApi()..settlements = three();
      final c = SettlementsController(api: api);
      await c.load();
      api.listAnswers.add(const ApiResult.failure(ApiFailure.timeout));
      await c.loadMore();
      expect((c.items.length, c.hasMore), (2, true));
      expect(c.moreFailure, isNotNull);
      await c.loadMore();
      expect((c.items.length, c.moreFailure), (3, null));
      c.dispose();
    });

    test('two loads at once make one request', () async {
      final api = FakePayoutApi()
        ..settlements = three()
        ..listGate = Completer<void>();
      final c = SettlementsController(api: api);
      final a = c.load();
      final b = c.load();
      api.listGate!.complete();
      await Future.wait([a, b]);
      expect(api.calls, ['settlements:1']);
      c.dispose();
    });

    test('detail controller: loads, and reports a failure with a retry', () async {
      final api = FakePayoutApi()..detailAnswer = const ApiResult.failure(ApiFailure.notFound);
      final c = SettlementDetailController(api: api, id: 'x');
      await c.load();
      expect((c.detail, c.failure!.english), (null, 'This payout is not available.'));
      api.detailAnswer = null;
      await c.load();
      expect((c.detail!.dishes.single.name, c.failure), ('Thali', null));
      c.dispose();
    });
  });

  // ------------------------------------------------------------------------------------------------ widgets

  void phone(WidgetTester tester, {Size size = const Size(360, 640), double scale = 1.3}) {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = scale;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      tester.view.resetViewInsets();
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });
  }

  /// The app's own wrapper: the system text scale is capped at 1.3 (see KraveoVendorApp).
  Widget host(Widget child, {bool clamp = true}) => MaterialApp(
        theme: KraveoTheme.vendor(),
        builder: (context, c) => clamp ? MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: c!) : c!,
        home: child,
      );

  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
  }

  Future<void> tapKey(WidgetTester tester, Key key) async {
    final f = find.byKey(key);
    await tester.pump(const Duration(milliseconds: 400)); // let a collapsing error row finish first
    await tester.ensureVisible(f);
    await tester.tap(f);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  Future<void> type(WidgetTester tester, Key key, String text) async {
    final f = find.byKey(key);
    await tester.pump(const Duration(milliseconds: 400));
    await tester.ensureVisible(f);
    await tester.enterText(f, text);
    await tester.pump();
  }

  /// Scrolls the (lazy) list until [finder] is built and on screen.
  Future<void> scrollTo(WidgetTester tester, Finder finder) async {
    await tester.dragUntilVisible(finder, find.byType(ListView).first, const Offset(0, -150));
    await tester.pump(const Duration(milliseconds: 300));
  }

  group('PayoutDetailsScreen', () {
    late FakePayoutApi api;
    late PayoutController controller;

    setUp(() {
      api = FakePayoutApi();
      controller = PayoutController(api: api);
    });
    tearDown(() => controller.dispose());

    Future<void> open(WidgetTester tester) async {
      phone(tester);
      await tester.pumpWidget(host(PayoutDetailsScreen(controller: controller)));
      await settle(tester);
    }

    testWidgets('loading: a spinner until the server answers', (tester) async {
      phone(tester);
      api.accountAnswer = null;
      final gate = Completer<void>();
      final slow = _SlowAccountApi(gate);
      controller = PayoutController(api: slow);
      await tester.pumpWidget(host(PayoutDetailsScreen(controller: controller)));
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.byKey(kPayoutSaveKey), findsNothing);
      gate.complete();
      await settle(tester);
      expect(find.byKey(kPayoutSaveKey), findsOneWidget);
    });

    testWidgets('error: plain message and a Retry that works', (tester) async {
      api.accountAnswer = const ApiResult.failure(ApiFailure.offline);
      await open(tester);
      expect(find.text("Can't load payout details"), findsOneWidget);
      expect(find.textContaining('No internet'), findsOneWidget);
      api.accountAnswer = null;
      await tapKey(tester, kPayoutRetryKey);
      expect(find.byKey(kPayoutSaveKey), findsOneWidget);
      expect(api.calls, ['account:get', 'account:get']);
    });

    testWidgets('nothing saved: the form with the UPI / Bank choice and no saved card', (tester) async {
      await open(tester);
      expect(find.byKey(kPayoutSavedCardKey), findsNothing);
      expect(find.byKey(kPayoutMethodUpiKey), findsOneWidget);
      expect(find.byKey(kPayoutMethodBankKey), findsOneWidget);
      expect(find.byKey(kPayoutUpiFieldKey), findsOneWidget);
      expect(find.byKey(kPayoutAccountFieldKey), findsNothing);
      expect(find.byKey(const ValueKey('payout-restart-note')), findsNothing);
    });

    testWidgets('UPI: a wrong id is refused before sending; a right one saves and shows the saved card, not verified', (tester) async {
      await open(tester);
      await type(tester, kPayoutUpiFieldKey, 'ram');
      await tapKey(tester, kPayoutSaveKey);
      expect(find.textContaining('does not look like a UPI id'), findsOneWidget);
      expect(api.calls, ['account:get']);
      await type(tester, kPayoutUpiFieldKey, 'Ram@OkHDFCBank');
      expect(find.textContaining('does not look like a UPI id'), findsNothing); // typing clears the error
      await tapKey(tester, kPayoutSaveKey);
      expect(api.calls, ['account:get', 'account:put:UPI']);
      expect(api.sentBodies.single, {'method': 'UPI', 'upiId': 'ram@okhdfcbank'});
      expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
      expect(find.text('ram@okhdfcbank'), findsOneWidget);
      expect(find.textContaining('Not verified yet'), findsOneWidget);
      expect(find.byKey(kPayoutSaveKey), findsNothing);
      expect(find.textContaining('Payout details saved'), findsOneWidget); // snackbar
    });

    testWidgets('Bank: IFSC is upper-cased as typed, the number must be typed twice, every wrong field is shown', (tester) async {
      await open(tester);
      await tapKey(tester, kPayoutMethodBankKey);
      expect(find.byKey(kPayoutAccountFieldKey), findsOneWidget);
      expect(find.byKey(kPayoutUpiFieldKey), findsNothing);
      await tapKey(tester, kPayoutSaveKey);
      expect(find.textContaining('Enter the account holder name'), findsOneWidget);
      expect(find.textContaining('Enter the account number'), findsOneWidget);
      expect(find.textContaining('Enter the IFSC code'), findsOneWidget);
      await type(tester, kPayoutHolderFieldKey, 'Ram Singh');
      await type(tester, kPayoutAccountFieldKey, '5010-0234 567890abc'); // digits only: the rest never gets in
      expect(tester.widget<TextField>(find.byKey(kPayoutAccountFieldKey)).controller!.text, fullNumber);
      await type(tester, kPayoutConfirmFieldKey, '50100234567891');
      await type(tester, kPayoutIfscFieldKey, 'hdfc0001234');
      expect(tester.widget<TextField>(find.byKey(kPayoutIfscFieldKey)).controller!.text, 'HDFC0001234');
      await tapKey(tester, kPayoutSaveKey);
      expect(find.textContaining('do not match'), findsOneWidget);
      expect(api.calls, ['account:get']);
    });

    testWidgets('Bank save: only the masked view is shown after, the full number is nowhere on screen and the fields are wiped', (tester) async {
      await open(tester);
      await tapKey(tester, kPayoutMethodBankKey);
      await type(tester, kPayoutHolderFieldKey, 'Ram Singh');
      await type(tester, kPayoutAccountFieldKey, fullNumber);
      await type(tester, kPayoutConfirmFieldKey, fullNumber);
      await type(tester, kPayoutIfscFieldKey, 'HDFC0001234');
      await type(tester, kPayoutBankFieldKey, 'HDFC Bank');
      await tapKey(tester, kPayoutSaveKey);
      expect(api.sentBodies.single, {'method': 'BANK', 'accountHolder': 'Ram Singh', 'accountNumber': fullNumber, 'ifsc': 'HDFC0001234', 'bankName': 'HDFC Bank'});
      expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
      expect(find.text('Account ending 7890'), findsOneWidget);
      expect(find.text('IFSC HDFC0001234'), findsOneWidget);
      expect(find.text('HDFC Bank'), findsOneWidget);
      expect(find.textContaining(fullNumber, findRichText: true), findsNothing);
      expect(find.textContaining('50100234', findRichText: true), findsNothing);
      // nothing that still holds the number is on screen or in the controller
      expect(controller.account.toString().contains(fullNumber), isFalse);
      // reopen the form: the number fields are empty (it can never be read back)
      await tapKey(tester, kPayoutEditKey);
      await tester.pump(const Duration(milliseconds: 500));
      expect(tester.widget<TextField>(find.byKey(kPayoutAccountFieldKey)).controller!.text, isEmpty);
      expect(tester.widget<TextField>(find.byKey(kPayoutConfirmFieldKey)).controller!.text, isEmpty);
      expect(tester.widget<TextField>(find.byKey(kPayoutIfscFieldKey)).controller!.text, 'HDFC0001234'); // non-secret fields are prefilled
    });

    testWidgets('saved + verified: "Verified by Kraveo"; Change details warns that verification restarts; Cancel returns without saving', (tester) async {
      api.account = PayoutAccount.fromJson(payoutFixtures()['account_bank_verified']['data']);
      await open(tester);
      expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
      expect(find.textContaining('Verified by Kraveo'), findsOneWidget);
      expect(find.textContaining('Not verified yet'), findsNothing);
      expect(find.text('Account ending 7890'), findsOneWidget);
      await tapKey(tester, kPayoutEditKey);
      expect(find.byKey(const ValueKey('payout-restart-note')), findsOneWidget);
      expect(find.textContaining('restarts verification'), findsOneWidget);
      expect(find.byKey(kPayoutSavedCardKey), findsNothing);
      await tapKey(tester, kPayoutCancelKey);
      expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
      expect(api.calls, ['account:get']);
    });

    testWidgets('changing a verified UPI id to another one shows "Not verified yet" afterwards; the same id says already saved', (tester) async {
      api.account = PayoutAccount(method: PayoutMethod.upi, upiId: 'ram@okhdfcbank', accountHolder: 'Ram Singh', verifiedAt: DateTime.utc(2026, 10, 6));
      await open(tester);
      await tapKey(tester, kPayoutEditKey);
      await tapKey(tester, kPayoutSaveKey); // identical details
      expect(find.textContaining('already saved'), findsOneWidget);
      expect(find.textContaining('Verified by Kraveo'), findsOneWidget);
      await tapKey(tester, kPayoutEditKey);
      await type(tester, kPayoutUpiFieldKey, 'ram@ybl');
      await tapKey(tester, kPayoutSaveKey);
      expect(find.text('ram@ybl'), findsOneWidget);
      expect(find.textContaining('Not verified yet'), findsOneWidget);
    });

    testWidgets('503 encryption missing: the plain message is shown, the form stays filled, switching to UPI then works', (tester) async {
      api.encryptionMissing = true;
      await open(tester);
      await tapKey(tester, kPayoutMethodBankKey);
      await type(tester, kPayoutHolderFieldKey, 'Ram Singh');
      await type(tester, kPayoutAccountFieldKey, fullNumber);
      await type(tester, kPayoutConfirmFieldKey, fullNumber);
      await type(tester, kPayoutIfscFieldKey, 'HDFC0001234');
      await tapKey(tester, kPayoutSaveKey);
      expect(find.byKey(kPayoutProblemKey), findsOneWidget);
      expect(find.textContaining('Bank details cannot be saved right now. Use UPI, or try again later.'), findsOneWidget);
      expect(find.byKey(kPayoutSavedCardKey), findsNothing);
      await tapKey(tester, kPayoutMethodUpiKey);
      expect(find.byKey(kPayoutProblemKey), findsNothing);
      await type(tester, kPayoutUpiFieldKey, 'ram@upi');
      await tapKey(tester, kPayoutSaveKey);
      expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
    });

    testWidgets('a server sentence for a refused field is shown plainly', (tester) async {
      api.saveAnswer = const ApiResult.failure(ApiFailure.invalid, message: 'Account number must be 6 to 20 digits.');
      await open(tester);
      await type(tester, kPayoutUpiFieldKey, 'ram@upi');
      await tapKey(tester, kPayoutSaveKey);
      expect(find.textContaining('Account number must be 6 to 20 digits.'), findsOneWidget);
    });

    testWidgets('double tap on Save sends one request; the button shows progress meanwhile', (tester) async {
      api.saveGate = Completer<void>();
      await open(tester);
      await type(tester, kPayoutUpiFieldKey, 'ram@upi');
      final save = find.byKey(kPayoutSaveKey);
      await tester.ensureVisible(save);
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(save);
      await tester.pump();
      await tester.tap(save, warnIfMissed: false);
      await tester.pump();
      expect(controller.saving, isTrue);
      expect(find.descendant(of: save, matching: find.byType(CircularProgressIndicator)), findsOneWidget);
      api.saveGate!.complete();
      await settle(tester);
      expect(api.calls.where((c) => c.startsWith('account:put')), hasLength(1));
      expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
    });

    for (final scale in [1.3, 2.0]) {
      testWidgets('no overflow at 360x640, text x$scale, with the keyboard open (form, bank form, saved card)', (tester) async {
        phone(tester, scale: scale);
        await tester.pumpWidget(host(PayoutDetailsScreen(controller: controller)));
        await settle(tester);
        tester.view.viewInsets = const FakeViewPadding(bottom: 280);
        await tester.pump();
        await tapKey(tester, kPayoutMethodBankKey);
        expect(find.byKey(kPayoutAccountFieldKey), findsOneWidget);
        // a long server problem and long field errors must not overflow either
        api.saveAnswer = ApiResult.failure(ApiFailure.invalid, message: 'A very long refusal from the server that keeps going. ' * 3);
        await tapKey(tester, kPayoutSaveKey);
        await type(tester, kPayoutHolderFieldKey, 'Ram Singh');
        await type(tester, kPayoutAccountFieldKey, fullNumber);
        await type(tester, kPayoutConfirmFieldKey, fullNumber);
        await type(tester, kPayoutIfscFieldKey, 'HDFC0001234');
        await tapKey(tester, kPayoutSaveKey);
        expect(find.byKey(kPayoutProblemKey), findsOneWidget);
        tester.view.resetViewInsets();
        api.saveAnswer = null;
        await tapKey(tester, kPayoutSaveKey);
        expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
        await tapKey(tester, kPayoutEditKey);
        expect(find.byKey(const ValueKey('payout-restart-note')), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  });

  group('SettlementsScreen', () {
    late FakePayoutApi api;
    late SettlementsController controller;

    setUp(() {
      api = FakePayoutApi();
      controller = SettlementsController(api: api);
    });
    tearDown(() => controller.dispose());

    List<Settlement> three() => (payoutFixtures()['settlements_list']['data'] as List).map((e) => Settlement.fromJson(e)!).toList();

    Future<void> open(WidgetTester tester, {double scale = 1.3, bool clamp = true}) async {
      phone(tester, scale: scale);
      await tester.pumpWidget(host(SettlementsScreen(controller: controller, api: api), clamp: clamp));
      await settle(tester);
    }

    testWidgets('loading: a spinner', (tester) async {
      api.listGate = Completer<void>();
      phone(tester);
      await tester.pumpWidget(host(SettlementsScreen(controller: controller, api: api)));
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      api.listGate!.complete();
      await settle(tester);
    });

    testWidgets('empty: "Payouts are made every evening for delivered orders"', (tester) async {
      await open(tester);
      expect(find.byKey(kSettlementsEmptyKey), findsOneWidget);
      expect(find.textContaining('Payouts are made every evening for delivered orders'), findsOneWidget);
    });

    testWidgets('error: message + Retry, then the list', (tester) async {
      api
        ..settlements = three()
        ..listAnswers.add(const ApiResult.failure(ApiFailure.server));
      await open(tester);
      expect(find.text("Can't load your settlements"), findsOneWidget);
      expect(find.textContaining('Kraveo had a problem'), findsOneWidget);
      await tapKey(tester, kSettlementsRetryKey);
      expect(find.byKey(settlementCardKey('11111111-1111-4111-8111-111111111111')), findsOneWidget);
      expect(find.text("Can't load your settlements"), findsNothing);
    });

    testWidgets('success: period in India dates, status chips, orders, amount to receive, UTR and paid date', (tester) async {
      api.settlements = three();
      api.pageSize = 3;
      await open(tester);
      expect(find.text('5 Oct to 6 Oct 2026'), findsOneWidget);
      expect(find.byKey(const ValueKey('settlement-status-onHold')), findsOneWidget);
      expect(find.text('On hold'), findsOneWidget);
      expect(find.text('1 order'), findsOneWidget);
      // the amount the restaurant RECEIVES (netPayable), not the earned amount
      expect(find.text('₹195.22'), findsOneWidget);
      expect(find.text('Includes -₹3 adjustment'), findsOneWidget);
      await scrollTo(tester, find.text('UTR: UTR402611223344'));
      expect(find.byKey(const ValueKey('settlement-status-paid')), findsOneWidget);
      expect(find.text('Paid'), findsOneWidget);
      expect(find.text('12 orders'), findsOneWidget);
      expect(find.text('₹2,450.50'), findsOneWidget);
      expect(find.text('Paid on 6 Oct 2026'), findsOneWidget);
      expect(find.text('UTR: UTR402611223344'), findsOneWidget);
      await scrollTo(tester, find.byKey(const ValueKey('settlement-status-pending')));
      expect(find.text('Pending'), findsOneWidget);
      expect(find.text('₹1,240'), findsOneWidget);
    });

    testWidgets('only restaurant-side wording: nothing about customer prices, fees, tax or commission anywhere', (tester) async {
      api.settlements = three();
      api.pageSize = 3;
      await open(tester);
      await tester.tap(find.byKey(settlementCardKey('11111111-1111-4111-8111-111111111111')));
      await settle(tester);
      for (final word in ['commission', 'Commission', 'customer', 'Customer', 'fee', 'Fee', 'GST', 'tax', 'Tax', 'discount', 'Discount', 'total', 'Total']) {
        expect(find.textContaining(word, findRichText: true), findsNothing, reason: word);
      }
    });

    testWidgets('pull to refresh reloads the first page', (tester) async {
      api.settlements = three();
      await open(tester);
      expect(api.calls, ['settlements:1']);
      api.settlements = three().take(1).toList();
      await tester.fling(find.byType(ListView), const Offset(0, 400), 1000);
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(api.calls, ['settlements:1', 'settlements:1']);
      expect(find.byKey(settlementCardKey('22222222-2222-4222-8222-222222222222')), findsNothing);
    });

    testWidgets('a failed refresh keeps the list and says so', (tester) async {
      api.settlements = three();
      await open(tester);
      api.listAnswers.add(const ApiResult.failure(ApiFailure.offline));
      await controller.load();
      await tester.pump();
      expect(find.byKey(kSettlementsStaleKey), findsOneWidget);
      expect(find.byKey(settlementCardKey('11111111-1111-4111-8111-111111111111')), findsOneWidget);
    });

    testWidgets('"Show older payouts" loads the next page', (tester) async {
      api.settlements = three();
      await open(tester);
      expect(find.byKey(settlementCardKey('33333333-3333-4333-8333-333333333333')), findsNothing);
      await scrollTo(tester, find.byKey(kSettlementsMoreKey));
      await tapKey(tester, kSettlementsMoreKey);
      expect(find.byKey(settlementCardKey('33333333-3333-4333-8333-333333333333')), findsOneWidget);
      expect(find.byKey(kSettlementsMoreKey), findsNothing);
    });

    testWidgets('tapping a row opens the detail: summary, dish lines, orders, adjustments (restaurant amounts only)', (tester) async {
      api.settlements = three();
      await open(tester);
      await tester.tap(find.byKey(settlementCardKey('11111111-1111-4111-8111-111111111111')));
      await settle(tester);
      expect(api.calls.last, 'settlement:11111111-1111-4111-8111-111111111111');
      expect(find.text('5 Oct to 6 Oct 2026'), findsOneWidget);
      expect(find.text('You earned for 1 order'), findsOneWidget);
      expect(find.text('₹198.22'), findsWidgets); // earned + dish line + order line
      expect(find.text('-₹3'), findsWidgets);
      expect(find.text('₹195.22'), findsOneWidget);
      await scrollTo(tester, find.byKey(const ValueKey('dish-line-0')));
      expect(find.text('Thali'), findsOneWidget);
      expect(find.text('2 portions'), findsOneWidget);
      await scrollTo(tester, find.text('Order ABCDEF12'));
      await scrollTo(tester, find.byKey(const ValueKey('adjustment-line-0')));
      expect(find.text('Missing item credit'), findsOneWidget);
    });

    testWidgets('detail of a PAID settlement shows the UTR and the paid time in India time', (tester) async {
      api.settlements = three();
      api.detailAnswer = ApiResult.success(SettlementDetail(settlement: three()[1], orders: const [], ordersTruncated: false, adjustments: const [], dishes: const []));
      await open(tester);
      await scrollTo(tester, find.byKey(settlementCardKey('22222222-2222-4222-8222-222222222222')));
      await tester.tap(find.byKey(settlementCardKey('22222222-2222-4222-8222-222222222222')));
      await settle(tester);
      expect(find.text('UTR: UTR402611223344'), findsOneWidget);
      expect(find.text('Paid on 6 Oct 2026, 10:15 AM'), findsOneWidget);
      await scrollTo(tester, find.text('No dish lines.  ·  कोई व्यंजन नहीं'));
      expect(find.text('No dish lines.  ·  कोई व्यंजन नहीं'), findsOneWidget);
    });

    testWidgets('detail error: message + Retry (nothing known yet)', (tester) async {
      final detail = SettlementDetailController(api: api, id: 'zz');
      api.detailAnswer = const ApiResult.failure(ApiFailure.offline);
      phone(tester);
      await tester.pumpWidget(host(SettlementDetailScreen(controller: detail)));
      await settle(tester);
      expect(find.text("Can't load this payout"), findsOneWidget);
      api.detailAnswer = null;
      await tapKey(tester, kSettlementsRetryKey);
      await scrollTo(tester, find.text('Thali'));
      expect(find.text('Thali'), findsOneWidget);
    });

    testWidgets('a truncated order list says so', (tester) async {
      final base = SettlementDetail.fromJson(payoutFixtures()['settlement_detail']['data'])!;
      api.detailAnswer = ApiResult.success(SettlementDetail(settlement: base.settlement, orders: base.orders, ordersTruncated: true, adjustments: const [], dishes: base.dishes));
      final detail = SettlementDetailController(api: api, id: base.settlement.id);
      phone(tester);
      await tester.pumpWidget(host(SettlementDetailScreen(controller: detail)));
      await settle(tester);
      await tester.dragUntilVisible(find.byKey(const ValueKey('orders-truncated')), find.byType(ListView), const Offset(0, -200));
      expect(find.byKey(const ValueKey('orders-truncated')), findsOneWidget);
    });

    for (final scale in [1.3, 2.0]) {
      testWidgets('no overflow at 360x640, text x$scale (list, detail, empty, error)', (tester) async {
        api.settlements = [
          ...three(),
          Settlement(
              id: 'long-1',
              status: SettlementStatus.paid,
              orderCount: 128,
              vendorAmount: 12345678.5,
              adjustmentTotal: -1234.25,
              netPayable: 12344444.25,
              periodStart: DateTime.utc(2026, 12, 31, 5),
              periodEnd: DateTime.utc(2027, 1, 1, 16, 30),
              createdAt: DateTime.utc(2027, 1, 1, 16, 31),
              paidAt: DateTime.utc(2027, 1, 2, 5),
              paymentReference: 'UTR-WITH-A-VERY-LONG-REFERENCE-0123456789'),
        ];
        api.pageSize = 10;
        await open(tester, scale: scale);
        await scrollTo(tester, find.byKey(settlementCardKey('long-1')));
        expect(find.byKey(settlementCardKey('long-1')), findsOneWidget);
        await tester.fling(find.byType(ListView).first, const Offset(0, 2000), 3000);
        await tester.pump(const Duration(seconds: 2));
        await tester.tap(find.byKey(settlementCardKey('11111111-1111-4111-8111-111111111111')));
        await settle(tester);
        await scrollTo(tester, find.byKey(const ValueKey('adjustment-line-0')));
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('empty state does not overflow at 360x640, text x2', (tester) async {
      await open(tester, scale: 2.0);
      expect(find.byKey(kSettlementsEmptyKey), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('error state does not overflow at 360x640, text x2', (tester) async {
      api.listAnswers.add(const ApiResult.failure(ApiFailure.offline));
      await open(tester, scale: 2.0);
      expect(find.byKey(kSettlementsRetryKey), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('no overflow at 360x640 with the system text at x2 and NO app cap (stress)', (tester) async {
      api.settlements = three();
      await open(tester, scale: 2.0, clamp: false);
      expect(tester.takeException(), isNull);
    });
  });

  group('PayoutBanner', () {
    testWidgets('shown while details are missing; closing hides it; "Add payout details" opens the screen', (tester) async {
      phone(tester);
      final api = FakePayoutApi();
      final c = PayoutController(api: api);
      addTearDown(c.dispose);
      await c.load();
      await tester.pumpWidget(host(Scaffold(body: Builder(builder: (context) => PayoutBanner(controller: c, onAdd: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PayoutDetailsScreen(controller: c))))))));
      await settle(tester);
      expect(find.text('Add payout details to get paid'), findsOneWidget);
      await tester.tap(find.byKey(kPayoutBannerActionKey));
      await settle(tester);
      expect(find.byKey(kPayoutSaveKey), findsOneWidget);
      await type(tester, kPayoutUpiFieldKey, 'ram@upi');
      await tapKey(tester, kPayoutSaveKey);
      await tester.tap(find.byTooltip('Back'));
      await settle(tester);
      expect(find.byKey(kPayoutBannerKey), findsNothing); // saved: no more reminder
    });

    testWidgets('closing the banner removes it for this session', (tester) async {
      phone(tester);
      final c = PayoutController(api: FakePayoutApi());
      addTearDown(c.dispose);
      await c.load();
      await tester.pumpWidget(host(Scaffold(body: PayoutBanner(controller: c, onAdd: () {}))));
      await settle(tester);
      expect(find.byKey(kPayoutBannerKey), findsOneWidget);
      await tester.tap(find.byKey(kPayoutBannerDismissKey));
      await settle(tester);
      expect(find.byKey(kPayoutBannerKey), findsNothing);
    });

    testWidgets('not shown when the read failed (unknown is not "missing") or details exist', (tester) async {
      phone(tester);
      final api = FakePayoutApi()..accountAnswer = const ApiResult.failure(ApiFailure.offline);
      final c = PayoutController(api: api);
      addTearDown(c.dispose);
      await c.load();
      await tester.pumpWidget(host(Scaffold(body: PayoutBanner(controller: c, onAdd: () {}))));
      expect(find.byKey(kPayoutBannerKey), findsNothing);
    });

    for (final scale in [1.3, 2.0]) {
      testWidgets('no overflow at 360x640, text x$scale', (tester) async {
        phone(tester, scale: scale);
        final c = PayoutController(api: FakePayoutApi());
        addTearDown(c.dispose);
        await c.load();
        await tester.pumpWidget(host(Scaffold(body: PayoutBanner(controller: c, onAdd: () {}))));
        await settle(tester);
        expect(find.byKey(kPayoutBannerKey), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  });

  // ------------------------------------------------------------------------------------------------ in the app

  group('inside the restaurant app', () {
    late FakePayoutApi api;
    late FakeBackend backend;

    setUp(() {
      mockSignedInPrefs();
      OrderQueueService.clearQueue();
      api = FakePayoutApi();
      backend = FakeBackend();
    });

    Future<void> launch(WidgetTester tester) async {
      phone(tester);
      await tester.pumpWidget(KraveoVendorApp(auth: SignedInAuth(), backend: backend, payoutApi: api, socketFactory: FakeSocket.new, alarm: FakeAlarm()));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
    }

    Future<void> unmount(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    }

    testWidgets('Earnings tab: reminder banner while nothing is saved; no payout call before that tab is opened', (tester) async {
      await launch(tester);
      expect(api.calls, isEmpty);
      expect(find.byKey(kPayoutBannerKey), findsNothing);
      await tester.tap(find.text('Earnings'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(api.calls, ['account:get']);
      expect(find.byKey(kPayoutBannerKey), findsOneWidget);
      expect(find.text('Add payout details to get paid'), findsOneWidget);
      await tester.tap(find.byKey(kPayoutBannerDismissKey));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byKey(kPayoutBannerKey), findsNothing);
      await tester.tap(find.text('Menu'));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.text('Earnings'));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byKey(kPayoutBannerKey), findsNothing); // stays closed for this login
      await unmount(tester);
    });

    testWidgets('no banner when details are already saved', (tester) async {
      api.account = PayoutAccount.fromJson(payoutFixtures()['account_upi']['data']);
      await launch(tester);
      await tester.tap(find.text('Earnings'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.byKey(kPayoutBannerKey), findsNothing);
      await unmount(tester);
    });

    testWidgets('the help sheet has "Payout details" and "My settlements", and both open', (tester) async {
      api.settlements = [settlementOf('x')];
      await launch(tester);
      Future<void> frames() async {
        for (var i = 0; i < 4; i++) {
          await tester.pump(const Duration(milliseconds: 400)); // route animations need a few frames to start and finish
        }
      }

      Future<void> openRow(String key) async {
        await tester.tap(find.byIcon(LucideIcons.headset).first);
        await frames();
        await tester.ensureVisible(find.byKey(ValueKey(key)));
        await tester.pump(const Duration(milliseconds: 300));
        await tester.tap(find.byKey(ValueKey(key)));
        await frames();
      }

      await openRow('payout-details-row');
      expect(find.byKey(kPayoutSaveKey), findsOneWidget);
      await tester.tap(find.byTooltip('Back'));
      await frames();
      expect(find.byKey(kPayoutSaveKey), findsNothing);

      await openRow('settlements-row');
      expect(find.text('My settlements'), findsOneWidget);
      expect(find.byKey(settlementCardKey('11111111-1111-4111-8111-111111111111')), findsOneWidget);
      await tester.tap(find.byTooltip('Back'));
      await frames();
      expect(find.byKey(settlementCardKey('11111111-1111-4111-8111-111111111111')), findsNothing);
      await unmount(tester);
    });
  });
}

/// A payout API whose first account read waits for [gate].
class _SlowAccountApi extends FakePayoutApi {
  _SlowAccountApi(this.gate);
  final Completer<void> gate;

  @override
  Future<ApiResult<PayoutAccount?>> fetchAccount() async {
    await gate.future;
    return super.fetchAccount();
  }
}
