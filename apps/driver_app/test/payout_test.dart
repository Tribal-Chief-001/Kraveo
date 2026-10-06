import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:driver_app/main.dart';
import 'package:driver_app/models/partner_session.dart';
import 'package:driver_app/models/payout_account.dart';
import 'package:driver_app/screens/payout_details_screen.dart';
import 'package:driver_app/services/driver_api_service.dart';
import 'package:driver_app/services/partner_auth_service.dart';
import 'package:driver_app/services/payout/payout_api.dart';
import 'package:driver_app/services/payout/payout_controller.dart';
import 'package:driver_app/services/rider_orders_api.dart';
import 'support/fake_rider.dart';
import 'support/payout_fakes.dart';
import 'support/signed_in.dart';

/// Docs/21 section 5 and 7: the rider's "Payout details" (UPI id or bank account, masked after saving). Models are parsed
/// from the shapes the backend e2e tests assert (test/fixtures/payout_samples.json); the screen runs against a fake that
/// behaves like the server.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

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

  group('payout validation (the server rules, English only)', () {
    test('UPI id: trimmed and lower-cased, needs name@handle', () {
      expect(PayoutRules.upiId('  Ram@OkHDFCBank '), isNull);
      expect(PayoutRules.upiId('ram.singh-1@ybl'), isNull);
      for (final bad in ['', 'ram', 'ram@', '@upi', 'r@upi', 'ram singh@upi']) {
        expect(PayoutRules.upiId(bad), isNotNull, reason: bad);
      }
      expect(PayoutRules.normalizeUpi(' Ram@OkHDFCBank '), 'ram@okhdfcbank');
    });

    test('account holder: 2 to 80 letters, spaces and . \' -; required only for a bank account', () {
      expect(PayoutRules.holder('', required: false), isNull);
      expect(PayoutRules.holder('', required: true), isNotNull);
      expect(PayoutRules.holder('Ram Singh', required: true), isNull);
      expect(PayoutRules.holder("D'Souza-Rao Jr.", required: true), isNull);
      expect(PayoutRules.holder('R', required: true), isNotNull);
      expect(PayoutRules.holder('Ram 2', required: true), isNotNull);
      expect(PayoutRules.holder('A' * 81, required: true), isNotNull);
    });

    test('account number: digits only, 6 to 20; spaces and dashes pasted from a statement are dropped', () {
      expect(PayoutRules.accountNumber(fullNumber), isNull);
      expect(PayoutRules.accountNumber('5010 0234-5678'), isNull);
      for (final bad in ['12345', '1' * 21, '12345a', '']) {
        expect(PayoutRules.accountNumber(bad), isNotNull, reason: bad);
      }
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
      for (final bad in ['HDFC1001234', 'HDF00001234', 'HDFC000123', '']) {
        expect(PayoutRules.ifsc(bad), isNotNull, reason: bad);
      }
    });

    test('bank name is optional, 2 to 60 characters', () {
      expect(PayoutRules.bankName(''), isNull);
      expect(PayoutRules.bankName('HDFC Bank'), isNull);
      expect(PayoutRules.bankName('H'), isNotNull);
      expect(PayoutRules.bankName('B' * 61), isNotNull);
    });

    test('every message is plain English (no leftover Hindi in the rider app)', () {
      final all = <String?>[
        PayoutRules.upiId(''), PayoutRules.upiId('x'), PayoutRules.holder('', required: true), PayoutRules.holder('R', required: true), PayoutRules.holder('R2', required: true),
        PayoutRules.accountNumber(''), PayoutRules.accountNumber('1'), PayoutRules.accountConfirm('123456', ''), PayoutRules.accountConfirm('123456', '1'),
        PayoutRules.ifsc(''), PayoutRules.ifsc('x'), PayoutRules.bankName('x'),
      ];
      for (final m in all) {
        expect(m, isNotNull);
        expect(RegExp(r'[ऀ-ॿ]').hasMatch(m!), isFalse, reason: m);
        expect(m.contains('\n'), isFalse, reason: m);
      }
    });

    test('PayoutForm: UPI builds a clean request; blank holder is left out', () {
      const form = PayoutForm(method: PayoutMethod.upi, upiId: ' Ram@OkHDFCBank ');
      expect(form.errors, isEmpty);
      expect(form.build()!.toJson(), {'method': 'UPI', 'upiId': 'ram@okhdfcbank'});
      expect(const PayoutForm(method: PayoutMethod.upi, upiId: 'ram@upi', accountHolder: '  Ram   Singh ').build()!.toJson()['accountHolder'], 'Ram Singh');
    });

    test('PayoutForm: bank reports every wrong field, and a mismatch only once the number itself is valid', () {
      expect(const PayoutForm(method: PayoutMethod.bank).errors.keys.toSet(), {'accountHolder', 'accountNumber', 'ifsc'});
      expect(const PayoutForm(method: PayoutMethod.bank, accountHolder: 'Ram Singh', accountNumber: '123456', accountConfirm: '123450', ifsc: 'HDFC0001234').errors.keys, ['accountConfirm']);
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

  // ------------------------------------------------------------------------------------------------ http

  group('HTTP: payout API', () {
    late List<http.Request> sent;
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      await DriverApiService.saveToken('jwt-rider');
      sent = [];
    });
    tearDown(() => DriverApiService.clearToken());

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
      expect(sent.single.headers['Authorization'], 'Bearer jwt-rider');
      expect((res.ok, res.value), (true, null));
    });

    test('GET reads a bank account masked', () async {
      final res = await withServer(api.fetchAccount, (_) => json(payoutFixtures()['account_bank_verified']));
      expect(res.value!.accountLast4, '7890');
      expect(res.value!.verified, isTrue);
    });

    test('a 200 without `data` or with an unreadable one is an error, not "nothing saved"', () async {
      expect((await withServer(api.fetchAccount, (_) => json({'success': true}))).failure, ApiFailure.badResponse);
      expect((await withServer(api.fetchAccount, (_) => json({'data': {'method': 'CASH'}}))).failure, ApiFailure.badResponse);
    });

    test('PUT sends exactly the UPI fields and reads the answer (changed + masked account)', () async {
      final res = await withServer(() => api.saveAccount(const PayoutInput.upi(upiId: 'ram@okhdfcbank', accountHolder: 'Ram Singh')), (_) => json(payoutFixtures()['account_upi']));
      expect(sent.single.method, 'PUT');
      expect(sent.single.url.path, endsWith('/partner/payout-account'));
      expect(jsonDecode(sent.single.body), {'method': 'UPI', 'upiId': 'ram@okhdfcbank', 'accountHolder': 'Ram Singh'});
      expect((res.value!.changed, res.value!.account.upiId, res.value!.account.verified), (true, 'ram@okhdfcbank', false));
    });

    test('PUT bank sends the number once; the answer is masked', () async {
      final res = await withServer(
          () => api.saveAccount(const PayoutInput.bank(accountHolder: 'Ram Singh', accountNumber: fullNumber, ifsc: 'HDFC0001234', bankName: 'HDFC Bank')), (_) => json(payoutFixtures()['account_bank_verified']));
      expect(jsonDecode(sent.single.body)['accountNumber'], fullNumber);
      expect(res.value!.account.destinationText, 'Account ending 7890');
    });

    test('503 PAYOUT_ENCRYPTION_NOT_CONFIGURED becomes the plain "use UPI or try later" text', () async {
      final res = await withServer(() => api.saveAccount(const PayoutInput.bank(accountHolder: 'Ram', accountNumber: fullNumber, ifsc: 'HDFC0001234')), (_) => json(payoutFixtures()['encryption_missing'], 503));
      expect((res.ok, res.code, res.statusCode), (false, 'PAYOUT_ENCRYPTION_NOT_CONFIGURED', 503));
      expect(payoutFailureText(res), 'Bank details cannot be saved right now. Use UPI, or try again later.');
    });

    test('400 shows the server sentence; 404 (old server), 403, 429, 500, offline and timeout have their own words', () async {
      final bad = await withServer(() => api.saveAccount(const PayoutInput.upi(upiId: 'x@y')), (_) => json({'success': false, 'code': 'BAD_REQUEST', 'field': 'upiId', 'message': 'That does not look like a UPI id (for example name@okhdfcbank).'}, 400));
      expect(payoutFailureText(bad), 'That does not look like a UPI id (for example name@okhdfcbank).');
      expect(payoutFailureText(await withServer(api.fetchAccount, (_) => http.Response('<html>Cannot GET</html>', 404))), contains('not available'));
      expect(payoutFailureText(await withServer(api.fetchAccount, (_) => json({'code': 'FORBIDDEN'}, 403))), contains('cannot do this'));
      expect(payoutFailureText(await withServer(api.fetchAccount, (_) => json({}, 429))), contains('Too many'));
      expect(payoutFailureText(await withServer(api.fetchAccount, (_) => json({}, 500))), contains('had a problem'));
      final offline = await http.runWithClient(api.fetchAccount, () => MockClient((_) async => throw http.ClientException('no route')));
      expect(offline.failure, ApiFailure.offline);
      expect(payoutFailureText(offline), contains('No internet'));
      final slow = await http.runWithClient(HttpPayoutApi(timeout: const Duration(milliseconds: 20)).fetchAccount, () => MockClient((_) => Completer<http.Response>().future));
      expect(slow.failure, ApiFailure.timeout);
    });

    test('a 401 goes through the same session hook as every other call', () async {
      var expired = 0;
      DriverApiService.onUnauthorized = () => expired++;
      addTearDown(() => DriverApiService.onUnauthorized = null);
      final res = await withServer(api.fetchAccount, (_) => json({'message': 'Unauthorized'}, 401));
      expect((res.failure, expired), (ApiFailure.unauthorized, 1));
    });
  });

  // ------------------------------------------------------------------------------------------------ controller

  PayoutInput upiInput([String id = 'ram@okhdfcbank']) => PayoutInput.upi(upiId: id, accountHolder: 'Ram Singh');
  const bankInput = PayoutInput.bank(accountHolder: 'Ram Singh', accountNumber: fullNumber, ifsc: 'HDFC0001234', bankName: 'HDFC Bank');

  group('PayoutController', () {
    test('load: nothing saved -> loaded with no account; saved -> the account', () async {
      final api = FakePayoutApi();
      final c = PayoutController(api: api);
      expect((c.loaded, c.account), (false, null));
      await c.load();
      expect((c.loaded, c.account), (true, null));
      api.account = PayoutAccount.fromJson(payoutFixtures()['account_upi']['data']);
      await c.load();
      expect(c.account!.upiId, 'ram@okhdfcbank');
      c.dispose();
    });

    test('a failed first read is not "nothing saved": a message, and a retry works', () async {
      final api = FakePayoutApi()..accountAnswer = const ApiResult.fail(ApiFailure.offline);
      final c = PayoutController(api: api);
      await c.load();
      expect(c.loaded, isFalse);
      expect(c.loadProblem, contains('No internet'));
      api.accountAnswer = null;
      await c.load();
      expect((c.loaded, c.loadProblem), (true, null));
      c.dispose();
    });

    test('a failed re-read keeps the saved account', () async {
      final api = FakePayoutApi()..account = PayoutAccount.fromJson(payoutFixtures()['account_upi']['data']);
      final c = PayoutController(api: api);
      await c.load();
      api.accountAnswer = const ApiResult.fail(ApiFailure.server);
      await c.load();
      expect((c.account!.upiId, c.loaded), ('ram@okhdfcbank', true));
      expect(c.loadProblem, isNotNull);
      c.dispose();
    });

    test('two reads at once make one request', () async {
      final api = FakePayoutApi()..readGate = Completer<void>();
      final c = PayoutController(api: api);
      final a = c.load();
      final b = c.load();
      api.readGate!.complete();
      await Future.wait([a, b]);
      expect(api.calls, ['account:get']);
      c.dispose();
    });

    test('save: stores the masked account and remembers the answer', () async {
      final api = FakePayoutApi();
      final c = PayoutController(api: api);
      await c.load();
      expect(await c.save(upiInput()), isTrue);
      expect((c.account!.upiId, c.lastSaved!.changed, c.saving), ('ram@okhdfcbank', true, false));
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

    test('503 encryption missing: the save fails with the plain message and the old details stay; UPI still works', () async {
      final api = FakePayoutApi()..encryptionMissing = true;
      final c = PayoutController(api: api);
      await c.load();
      expect(await c.save(bankInput), isFalse);
      expect(c.saveProblem, contains('Use UPI'));
      expect((c.account, c.saving), (null, false));
      expect(await c.save(upiInput()), isTrue);
      expect(c.saveProblem, isNull);
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

  Widget host(Widget child) => MaterialApp(theme: KraveoTheme.driver(), home: child);

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

  group('PayoutDetailsScreen', () {
    late FakePayoutApi api;
    late PayoutController controller;

    setUp(() {
      api = FakePayoutApi();
      controller = PayoutController(api: api);
    });
    tearDown(() => controller.dispose());

    Future<void> open(WidgetTester tester, {String? suggestedUpi, double scale = 1.3}) async {
      phone(tester, scale: scale);
      await tester.pumpWidget(host(PayoutDetailsScreen(controller: controller, suggestedUpi: suggestedUpi)));
      await settle(tester);
    }

    testWidgets('loading: a spinner until the server answers', (tester) async {
      api.readGate = Completer<void>();
      phone(tester);
      await tester.pumpWidget(host(PayoutDetailsScreen(controller: controller)));
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.byKey(kPayoutSaveKey), findsNothing);
      api.readGate!.complete();
      await settle(tester);
      expect(find.byKey(kPayoutSaveKey), findsOneWidget);
    });

    testWidgets('error: plain message and a Retry that works', (tester) async {
      api.accountAnswer = const ApiResult.fail(ApiFailure.offline);
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
      expect(find.byKey(kPayoutRestartNoteKey), findsNothing);
      expect(tester.widget<TextField>(find.byKey(kPayoutUpiFieldKey)).controller!.text, isEmpty);
    });

    testWidgets('the UPI id given at sign-up only pre-fills the empty form; nothing is saved until Save', (tester) async {
      await open(tester, suggestedUpi: ' old@upi ');
      expect(tester.widget<TextField>(find.byKey(kPayoutUpiFieldKey)).controller!.text, 'old@upi');
      expect(api.calls, ['account:get']);
      expect(find.byKey(kPayoutSavedCardKey), findsNothing);
    });

    testWidgets('a saved account wins over the sign-up UPI id', (tester) async {
      api.account = PayoutAccount.fromJson(payoutFixtures()['account_upi']['data']);
      await open(tester, suggestedUpi: 'old@upi');
      expect(find.text('ram@okhdfcbank'), findsOneWidget);
      expect(find.textContaining('old@upi'), findsNothing);
      await tapKey(tester, kPayoutEditKey);
      expect(tester.widget<TextField>(find.byKey(kPayoutUpiFieldKey)).controller!.text, 'ram@okhdfcbank');
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
      expect(find.byKey(kPayoutRestartNoteKey), findsOneWidget);
      expect(find.textContaining('restarts verification'), findsOneWidget);
      expect(find.byKey(kPayoutSavedCardKey), findsNothing);
      await tapKey(tester, kPayoutCancelKey);
      expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
      expect(api.calls, ['account:get']);
    });

    testWidgets('saving the same UPI id says "already saved" and stays verified; another id makes it "Not verified yet"', (tester) async {
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
      api.saveAnswer = const ApiResult.fail(ApiFailure.badRequest, message: 'Account number must be 6 to 20 digits.');
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
      await tester.pump(const Duration(milliseconds: 400));
      await tester.ensureVisible(save);
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
      testWidgets('no overflow at 360x640, text x$scale, with the keyboard open (form, bank form, errors, saved card)', (tester) async {
        phone(tester, scale: scale);
        await tester.pumpWidget(host(PayoutDetailsScreen(controller: controller)));
        await settle(tester);
        tester.view.viewInsets = const FakeViewPadding(bottom: 280);
        await tester.pump();
        await tapKey(tester, kPayoutMethodBankKey);
        expect(find.byKey(kPayoutAccountFieldKey), findsOneWidget);
        await tapKey(tester, kPayoutSaveKey); // every field error at once
        expect(find.textContaining('Enter the IFSC code'), findsOneWidget);
        // a long server problem must not overflow either
        api.saveAnswer = ApiResult.fail(ApiFailure.badRequest, message: 'A very long refusal from the server that keeps going. ' * 3);
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
        expect(find.byKey(kPayoutRestartNoteKey), findsOneWidget);
        expect(tester.takeException(), isNull);
      });

      testWidgets('error and loading states do not overflow at 360x640, text x$scale', (tester) async {
        api.accountAnswer = const ApiResult.fail(ApiFailure.offline);
        await open(tester, scale: scale);
        expect(find.byKey(kPayoutRetryKey), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  });

  // ------------------------------------------------------------------------------------------------ in the app

  group('inside the delivery app', () {
    late FakePayoutApi api;

    setUp(() {
      mockSignedInPrefs();
      api = FakePayoutApi();
    });

    Future<void> frames(WidgetTester tester) async {
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 400)); // route animations need a few frames to start and finish
      }
    }

    Future<void> launch(WidgetTester tester, {PartnerAuthService? auth}) async {
      phone(tester);
      final rider = FakeRider();
      await tester.pumpWidget(KraveoDriverApp(auth: auth ?? SignedInAuth(), riderServices: () => rider.services, payoutApi: api));
      await frames(tester);
    }

    Future<void> openPayout(WidgetTester tester) async {
      await tester.tap(find.text('Hi, Test'));
      await frames(tester);
      final f = find.byKey(const ValueKey('account-payout-button'));
      await tester.ensureVisible(f);
      await tester.tap(f);
      await frames(tester);
    }

    Future<void> unmount(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    }

    testWidgets('the account sheet has "Payout details" between the runner pass and Log out, and it opens the screen', (tester) async {
      await launch(tester);
      expect(api.calls, isEmpty); // nothing is asked of Kraveo until the rider opens the screen
      await tester.tap(find.text('Hi, Test'));
      await frames(tester);
      expect(find.byKey(const ValueKey('account-payout-button')), findsOneWidget);
      expect(find.byKey(const ValueKey('account-logout-button')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('account-payout-button')));
      await frames(tester);
      expect(find.byKey(kPayoutSaveKey), findsOneWidget);
      expect(api.calls, ['account:get']);
      await unmount(tester);
    });

    testWidgets('save in the app, go back and reopen: the saved (masked) account is still there, read from the same controller', (tester) async {
      await launch(tester);
      await openPayout(tester);
      await type(tester, kPayoutUpiFieldKey, 'ram@upi');
      await tapKey(tester, kPayoutSaveKey);
      expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
      await tester.tap(find.byTooltip('Back'));
      await frames(tester);
      expect(find.byKey(kPayoutSavedCardKey), findsNothing);
      await openPayout(tester);
      expect(find.byKey(kPayoutSavedCardKey), findsOneWidget);
      expect(find.text('ram@upi'), findsOneWidget);
      expect(api.calls.where((c) => c == 'account:get'), hasLength(1));
      await unmount(tester);
    });

    testWidgets('the old sign-up UPI id (session.upiId) pre-fills the empty form but is not saved by itself', (tester) async {
      await launch(tester, auth: _AuthWithUpi());
      await openPayout(tester);
      expect(tester.widget<TextField>(find.byKey(kPayoutUpiFieldKey)).controller!.text, 'signup@upi');
      expect(api.calls, ['account:get']);
      await unmount(tester);
    });

    testWidgets('the Log out button is still in the sheet and still asks first', (tester) async {
      await launch(tester);
      await tester.tap(find.text('Hi, Test'));
      await frames(tester);
      await tester.tap(find.byKey(const ValueKey('account-logout-button')));
      await frames(tester);
      expect(find.text('Log out?'), findsOneWidget);
      await tester.tap(find.text('Stay logged in'));
      await frames(tester);
      await unmount(tester);
    });

    testWidgets('no overflow in the account sheet at 360x640, text x2', (tester) async {
      phone(tester, scale: 2.0);
      final rider = FakeRider();
      await tester.pumpWidget(KraveoDriverApp(auth: SignedInAuth(), riderServices: () => rider.services, payoutApi: api));
      await frames(tester);
      await tester.tap(find.text('Hi, Test'));
      await frames(tester);
      expect(tester.takeException(), isNull);
      await unmount(tester);
    });
  });
}

/// A signed-in rider whose profile still carries the UPI id given at sign-up.
class _AuthWithUpi extends SignedInAuth {
  @override
  Future<ProfileResult> fetchProfile(String token) async =>
      const ProfileResult(ProfileOutcome.valid, PartnerSession(userId: 'u1', name: 'Test Rider', runnerCode: 'RUN-1', upiId: 'signup@upi'));
}
