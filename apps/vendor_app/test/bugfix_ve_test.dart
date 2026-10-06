import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vendor_app/main.dart';
import 'package:vendor_app/models/dish_model.dart';
import 'package:vendor_app/models/order_model.dart';
import 'package:vendor_app/models/partner_session.dart';
import 'package:vendor_app/screens/application_status_screen.dart';
import 'package:vendor_app/screens/login_screen.dart';
import 'package:vendor_app/screens/sales_analytics.dart';
import 'package:vendor_app/screens/signup_screen.dart';
import 'package:vendor_app/services/failure_messages.dart';
import 'package:vendor_app/services/order_queue_controller.dart';
import 'package:vendor_app/services/order_queue_service.dart';
import 'package:vendor_app/services/partner_auth_service.dart';
import 'package:vendor_app/services/push/push_controller.dart';
import 'package:vendor_app/services/support_contact.dart';
import 'package:vendor_app/services/vendor_backend.dart';
import 'package:vendor_app/session/session_controller.dart';
import 'package:vendor_app/widgets/add_dish_modal.dart';
import 'package:vendor_app/widgets/incoming_order_dialog.dart';
import 'package:vendor_app/widgets/stock_card.dart';
import 'package:vendor_app/widgets/ui/ui.dart';
import 'support/fakes.dart';
import 'support/push_fakes.dart';

/// Pre-demo bug-hunt fixes for the restaurant app (VE-01 ... VE-20). Each group names the finding it guards.

PartnerSession _profile({PartnerApproval approval = PartnerApproval.pending, String? address, String? category, String? fssai, String name = 'Ramesh Kumar', String? reason}) => PartnerSession(
      userId: 'u9',
      name: name,
      phone: '+91 9811100001',
      vendorId: 'v9',
      vendorName: 'Shiv Shakti Dhaba',
      isAcceptingOrders: false,
      approval: approval,
      rejectionReason: reason,
      category: category,
      address: address,
      fssaiNumber: fssai,
    );

/// A scriptable auth server for app-level tests.
class _Auth implements PartnerAuthService {
  _Auth(this.profile);

  ProfileResult profile;
  SignupResult Function(PartnerSignupForm f) onResubmit = (_) => const SignupResult.success();
  final resubmits = <PartnerSignupForm>[];
  int profileCalls = 0;

  @override
  Future<LoginResult> login({required String phone, required String password}) async => const LoginResult.failure(LoginFailure.server);

  @override
  Future<ProfileResult> fetchProfile(String token) async {
    profileCalls++;
    return profile;
  }

  @override
  Future<SignupResult> signUp(PartnerSignupForm form) async => const SignupResult.failure(SignupFailure.server);

  @override
  Future<SignupResult> resubmit(String token, PartnerSignupForm form) async {
    resubmits.add(form);
    return onResubmit(form);
  }

  @override
  Future<void> logout(String token) async {}
}

/// A tall phone so a whole form is on screen (no scrolling in the way of a tap).
void _tallPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(412, 1800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pump(const Duration(seconds: 1));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    for (final ch in const ['xyz.luan/audioplayers.global', 'xyz.luan/audioplayers']) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(MethodChannel(ch), (call) async => null);
    }
  });

  // ------------------------------------------------------------------------------------------------ VE-01 / VE-02

  group('VE-01 re-sent application (HTTP shape)', () {
    const form = PartnerSignupForm(
      ownerName: 'Ramesh Kumar',
      phone: '9811100001',
      password: '',
      restaurantName: 'Shiv Shakti Dhaba',
      address: 'Gate 2 food court',
      edited: {'address'},
    );

    Future<(SignupResult, http.Request)> put(http.Response Function() answer) async {
      late http.Request seen;
      final r = await http.runWithClient(
        () => ApiPartnerAuthService().resubmit('tok', form),
        () => MockClient((req) async {
          seen = req;
          return answer();
        }),
      );
      return (r, seen);
    }

    test('a 200 WITHOUT a user in the body is a success (the old server shape)', () async {
      final (r, req) = await put(() => http.Response(jsonEncode({'success': true, 'approvalStatus': 'PENDING', 'rejectionReason': null, 'vendor': {'id': 'v9', 'name': 'Shiv Shakti Dhaba'}}), 200));
      expect(r.ok, isTrue);
      expect(r.failure, isNull);
      expect(r.session, isNull, reason: 'nothing readable: the caller re-reads /partner/me');
      expect(req.method, 'PUT');
      expect(req.url.path, endsWith('/partner/application'));
    });

    test('a 200 WITH a user (the new server shape) is a success and carries the session', () async {
      final (r, _) = await put(() => http.Response(
            jsonEncode({
              'success': true,
              'user': {'id': 'u9', 'name': 'Ramesh Kumar', 'phone': '+91 9811100001', 'role': 'VENDOR', 'avatarId': null},
              'approvalStatus': 'PENDING',
              'rejectionReason': null,
              'vendor': {'id': 'v9', 'name': 'Shiv Shakti Dhaba', 'address': 'Gate 2 food court', 'category': 'North Indian', 'fssaiNumber': '12345678901234', 'isAcceptingOrders': false},
            }),
            200,
          ));
      expect(r.ok, isTrue);
      expect(r.session!.approval, PartnerApproval.pending);
      expect(r.session!.address, 'Gate 2 food court');
    });

    test('real failures are still failures (401, 400, 5xx, even an empty 200 body counts as accepted)', () async {
      expect((await put(() => http.Response('{}', 401))).$1.failure, SignupFailure.unauthorized);
      expect((await put(() => http.Response(jsonEncode({'field': 'address', 'message': 'Too short'}), 400))).$1.failure, SignupFailure.invalid);
      expect((await put(() => http.Response('oops', 502))).$1.failure, SignupFailure.server);
      expect((await put(() => http.Response('', 200))).$1.ok, isTrue);
    });

    test('sign-up (new account) still needs a token and a user', () async {
      final r = await http.runWithClient(
        () => ApiPartnerAuthService().signUp(const PartnerSignupForm(ownerName: 'R', phone: '9811100001', password: 'Passw0rd!x', restaurantName: 'Shiv', address: 'Gate 2')),
        () => MockClient((_) async => http.Response(jsonEncode({'success': true, 'approvalStatus': 'PENDING'}), 201)),
      );
      expect(r.failure, SignupFailure.server);
    });
  });

  group('VE-01 session after a re-send', () {
    setUp(() => SharedPreferences.setMockInitialValues({'kraveo_vendor_jwt_token': 'stored-jwt'}));

    test('a 200 without a user keeps the owner signed in, marks the application pending and re-reads the profile', () async {
      final auth = _Auth(ProfileResult(ProfileOutcome.valid, _profile(approval: PartnerApproval.rejected, reason: 'FSSAI does not match')));
      final controller = SessionController(auth: auth);
      await controller.restore();
      expect(controller.session!.approval, PartnerApproval.rejected);

      // The server accepted it; the fresh profile now says PENDING with the new address.
      auth.profile = ProfileResult(ProfileOutcome.valid, _profile(address: 'Gate 2 food court', category: 'North Indian'));
      final before = auth.profileCalls;
      final result = await controller.resubmit(const PartnerSignupForm(ownerName: 'Ramesh Kumar', phone: '', password: '', restaurantName: 'Shiv Shakti Dhaba', address: 'Gate 2 food court'));
      expect(result.ok, isTrue);
      expect(controller.status, SessionStatus.signedIn);
      expect(controller.session!.approval, PartnerApproval.pending);
      expect(controller.session!.rejectionReason, isNull);
      expect(controller.session!.address, 'Gate 2 food court');
      expect(auth.profileCalls, before + 1, reason: 'the real profile is loaded after the re-send');
      controller.dispose();
    });

    test('even when the profile re-read fails (offline), the owner is shown as pending, not as an error', () async {
      final auth = _Auth(ProfileResult(ProfileOutcome.valid, _profile(approval: PartnerApproval.rejected, reason: 'x')));
      final controller = SessionController(auth: auth);
      await controller.restore();
      auth.profile = const ProfileResult(ProfileOutcome.unreachable);
      final result = await controller.resubmit(const PartnerSignupForm(ownerName: 'R', phone: '', password: '', restaurantName: 'S', address: 'A'));
      expect(result.ok, isTrue);
      expect(controller.session!.approval, PartnerApproval.pending);
      controller.dispose();
    });

    testWidgets('the form closes with no "Kraveo is having trouble" box when the answer has no user', (tester) async {
      _tallPhone(tester);
      var submitted = 0;
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        home: SignupScreen(
          existing: _profile(approval: PartnerApproval.rejected, address: 'Old', category: 'North Indian', fssai: '12345678901234'),
          onSubmit: (form) async {
            submitted++;
            return const SignupResult.success();
          },
        ),
      ));
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      await tester.enterText(find.byKey(const ValueKey('address-field')), 'Gate 2 food court');
      await tester.ensureVisible(find.byKey(const ValueKey('signup-button')));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.byKey(const ValueKey('signup-button')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(submitted, 1);
      expect(find.byKey(const ValueKey('signup-problem')), findsNothing);
      expect(find.textContaining('having trouble'), findsNothing);
    });
  });

  group('VE-02 only edited fields are sent; the profile is loaded after login', () {
    test('toUpdateJson sends only the edited fields and never an empty category / FSSAI number', () {
      const onlyAddress = PartnerSignupForm(ownerName: 'R', phone: '', password: '', restaurantName: 'S', address: 'New address', category: '', fssaiNumber: '', edited: {'address'});
      expect(onlyAddress.toUpdateJson(), {'address': 'New address'});

      const fssaiFixed = PartnerSignupForm(ownerName: 'R', phone: '', password: '', restaurantName: 'S', address: 'A', fssaiNumber: '12345678901234', edited: {'fssaiNumber'});
      expect(fssaiFixed.toUpdateJson(), {'fssaiNumber': '12345678901234'});

      // Edited but emptied: still never sent (it would wipe what Kraveo has on file).
      const cleared = PartnerSignupForm(ownerName: 'R', phone: '', password: '', restaurantName: 'S', address: 'A', category: '', fssaiNumber: '', edited: {'category', 'fssaiNumber', 'name'});
      expect(cleared.toUpdateJson(), {'name': 'R'});

      // Unknown edits (older callers): everything that has a value.
      const unknown = PartnerSignupForm(ownerName: 'R', phone: '', password: '', restaurantName: 'S', address: 'A', category: '', fssaiNumber: '');
      expect(unknown.toUpdateJson(), {'name': 'R', 'restaurantName': 'S', 'address': 'A'});
    });

    testWidgets('the edit form posts only what the owner changed (the PUT body)', (tester) async {
      _tallPhone(tester);
      PartnerSignupForm? sent;
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        home: SignupScreen(
          existing: _profile(approval: PartnerApproval.rejected, address: 'Ashta road', category: 'North Indian', fssai: '12345678901234'),
          onSubmit: (form) async {
            sent = form;
            return const SignupResult.success();
          },
        ),
      ));
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      await tester.enterText(find.byKey(const ValueKey('address-field')), 'Gate 2 food court');
      await tester.ensureVisible(find.byKey(const ValueKey('signup-button')));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.byKey(const ValueKey('signup-button')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(sent!.edited, {'address'});
      expect(sent!.toUpdateJson(), {'address': 'Gate 2 food court'});
    });

    testWidgets('the edit form with unknown stored details (a login answer without them) sends no empty category / FSSAI', (tester) async {
      _tallPhone(tester);
      PartnerSignupForm? sent;
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        home: SignupScreen(
          existing: _profile(approval: PartnerApproval.rejected),
          onSubmit: (form) async {
            sent = form;
            return const SignupResult.success();
          },
        ),
      ));
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      await tester.enterText(find.byKey(const ValueKey('address-field')), 'Gate 2 food court');
      await tester.ensureVisible(find.byKey(const ValueKey('signup-button')));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.byKey(const ValueKey('signup-button')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      final body = sent!.toUpdateJson();
      expect(body.containsKey('category'), isFalse);
      expect(body.containsKey('fssaiNumber'), isFalse);
      expect(body['address'], 'Gate 2 food court');
    });

    test('refreshApproval notifies when only the address / category / FSSAI / name changed', () async {
      SharedPreferences.setMockInitialValues({'kraveo_vendor_jwt_token': 'stored-jwt'});
      final auth = _Auth(ProfileResult(ProfileOutcome.valid, _profile())); // a login-shaped session: no details
      final controller = SessionController(auth: auth);
      await controller.restore();
      expect(controller.session!.address, isNull);
      var notified = 0;
      controller.addListener(() => notified++);

      auth.profile = ProfileResult(ProfileOutcome.valid, _profile(address: 'Ashta road', category: 'North Indian', fssai: '12345678901234'));
      expect(await controller.refreshApproval(), isTrue);
      expect(notified, 1);
      expect(controller.session!.address, 'Ashta road');
      expect(controller.session!.category, 'North Indian');
      expect(controller.session!.fssaiNumber, '12345678901234');

      expect(await controller.refreshApproval(), isFalse, reason: 'nothing changed');
      auth.profile = ProfileResult(ProfileOutcome.valid, _profile(address: 'Ashta road', category: 'North Indian', fssai: '12345678901234', name: 'Ramesh K'));
      expect(await controller.refreshApproval(), isTrue);
      expect(notified, 2);
      controller.dispose();
    });

    testWidgets('the status screen loads the full profile once when the login answer had no address', (tester) async {
      var refreshes = 0;
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        home: ApplicationStatusScreen(session: _profile(approval: PartnerApproval.rejected), onRefresh: () async => ++refreshes > 0, onEdit: () {}, onLogout: () async {}),
      ));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(refreshes, 1);
      await tester.pumpWidget(const SizedBox());
    });
  });

  // ------------------------------------------------------------------------------------------------ app-level helpers

  group('app level', () {
    late FakeBackend backend;
    late FakeAlarm alarm;
    late List<FakeSocket> sockets;
    late _Auth auth;

    PartnerSession approved() => const PartnerSession(userId: 'u1', name: 'Test Owner', vendorId: 'v1', vendorName: 'Test Dhaba', approval: PartnerApproval.approved, isAcceptingOrders: true);

    setUp(() {
      SharedPreferences.setMockInitialValues({'kraveo_vendor_jwt_token': 'test-jwt'});
      OrderQueueService.clearQueue();
      backend = FakeBackend();
      alarm = FakeAlarm();
      sockets = [];
      auth = _Auth(ProfileResult(ProfileOutcome.valid, approved()));
    });

    Future<void> launch(WidgetTester tester, {PushController? push, Size size = const Size(412, 915)}) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(KraveoVendorApp(
        auth: auth,
        backend: backend,
        push: push,
        socketFactory: () {
          final s = FakeSocket();
          sockets.add(s);
          return s;
        },
        alarm: alarm,
      ));
      await _settle(tester);
    }

    Future<void> unmount(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    }

    Future<void> tapButton(WidgetTester tester, String label) async {
      final f = find.widgetWithText(KButton, label);
      await tester.ensureVisible(f);
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(f);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
    }

    // -------------------------------------------------------------------------------------------- VE-03

    testWidgets('VE-03 the session ending while the takeover is open closes it and shows the login screen', (tester) async {
      backend.put(order(id: 'ord-1'));
      await launch(tester);
      expect(find.byType(IncomingOrderDialog), findsOneWidget);

      // The admin suspended / reset the account: the next profile check answers 401.
      auth.profile = const ProfileResult(ProfileOutcome.unauthorized);
      for (final s in const [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused, AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
        tester.binding.handleAppLifecycleStateChanged(s);
      }
      // Well under the dialog's own 1-second tick: it is the session change that closes the pop-up.
      await tester.pump();
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 80));
      }

      expect(find.byType(IncomingOrderDialog), findsNothing, reason: 'no dead full-screen over the login');
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.textContaining('Session expired'), findsOneWidget, reason: 'the existing message is kept');
      expect(OrderQueueService.isShowingDialog, isFalse);
      await unmount(tester);
    });

    testWidgets('VE-03 a takeover whose controller was disposed closes itself (no dead screen)', (tester) async {
      backend.put(order(id: 'ord-1'));
      final c = await startController(backend, alarm: alarm);
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(onPressed: () => showDialog<void>(context: context, builder: (_) => IncomingOrderDialog(orderId: 'ord-1', controller: c)), child: const Text('open')),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(IncomingOrderDialog), findsOneWidget);
      c.dispose();
      await tester.pump(const Duration(seconds: 2));
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(IncomingOrderDialog), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    // -------------------------------------------------------------------------------------------- VE-04

    testWidgets('VE-04 Kraveo cancels an order in the kitchen: a notice tells the cook to stop, and the tray notification is removed', (tester) async {
      final log = PushLog();
      final notifications = FakeNotifications();
      final push = PushController(
        messaging: FakePushMessaging(log: log),
        notifications: notifications,
        permissions: FakePermissions()..battery = true,
        registry: FakeRegistry(log: log),
        appVersion: () async => '1.0.0+1',
        retryDelays: const [],
      );
      backend.put(order(id: 'ord-abc123', status: 'ACCEPTED'));
      await launch(tester, push: push);
      expect(find.byType(IncomingOrderDialog), findsNothing);

      sockets.single.emit(
        'order_updated',
        orderJson(id: 'ord-abc123', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'ADMIN', cancelReason: 'Kitchen fire', updatedAt: DateTime.now().add(const Duration(minutes: 1))),
      );
      await _settle(tester);

      expect(find.textContaining('was cancelled by Kraveo. Stop cooking.'), findsOneWidget);
      expect(find.textContaining('#ABC123'), findsWidgets);
      expect(notifications.shown, contains('cancel:ord-abc123'));
      expect(alarm.starts, 1, reason: 'one short sound');

      await tester.tap(find.byKey(const ValueKey('cancelled-notice-ok')));
      await _settle(tester);
      expect(find.textContaining('Stop cooking'), findsNothing);
      await unmount(tester);
      push.dispose();
    });

    testWidgets('VE-04 no alert when the restaurant itself declined, or for an order that was never in the kitchen', (tester) async {
      backend.put(order(id: 'ord-new'));
      await launch(tester);
      expect(find.byType(IncomingOrderDialog), findsOneWidget);
      sockets.single.emit('order_updated', orderJson(id: 'ord-new', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'VENDOR', updatedAt: DateTime.now().add(const Duration(minutes: 1))));
      await _settle(tester);
      expect(find.textContaining('Stop cooking'), findsNothing);
      await unmount(tester);
    });

    // -------------------------------------------------------------------------------------------- VE-06

    testWidgets('VE-06 a new restaurant (closed, empty menu) sees "1. Add a dish  2. Tap OPEN" on the Orders tab', (tester) async {
      backend
        ..storeOpen = false
        ..menu = [];
      auth.profile = const ProfileResult(ProfileOutcome.valid, PartnerSession(userId: 'u1', name: 'O', vendorId: 'v1', vendorName: 'Test Dhaba', isAcceptingOrders: false));
      await launch(tester);
      expect(find.byKey(const ValueKey('first-run-card')), findsOneWidget);
      expect(find.textContaining('Add a dish'), findsWidgets);
      expect(find.textContaining('Tap OPEN'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('VE-06 opening a store with zero dishes asks first; "Open anyway" opens it', (tester) async {
      backend
        ..storeOpen = false
        ..menu = [];
      await launch(tester);
      await tester.tap(find.text('CLOSED'));
      await _settle(tester);
      expect(find.textContaining('You have no dishes yet - customers will see an empty menu. Open anyway?'), findsOneWidget);
      expect(backend.calls.where((c) => c.startsWith('store:set')), isEmpty);

      await tapButton(tester, 'Open anyway');
      await _settle(tester);
      expect(backend.calls.where((c) => c.startsWith('store:set')), isNotEmpty);
      await unmount(tester);
    });

    testWidgets('VE-06 "Add a dish first" does not open the store and goes to the Menu tab', (tester) async {
      backend
        ..storeOpen = false
        ..menu = [];
      await launch(tester);
      await tester.tap(find.text('CLOSED'));
      await _settle(tester);
      await tapButton(tester, 'Add a dish first');
      await _settle(tester);
      expect(backend.calls.where((c) => c.startsWith('store:set')), isEmpty);
      expect(find.text('Your menu is empty'), findsOneWidget);
      await unmount(tester);
    });

    testWidgets('VE-06 with at least one dish, opening needs no extra question and the card is gone once open', (tester) async {
      backend
        ..storeOpen = false
        ..menu = [DishModel(id: 'm1', name: 'Dal', category: 'Main Course', price: 90)];
      await launch(tester);
      await tester.tap(find.text('CLOSED'));
      await _settle(tester);
      expect(find.textContaining('You have no dishes yet'), findsNothing);
      expect(backend.calls.where((c) => c.startsWith('store:set')), isNotEmpty);
      expect(find.byKey(const ValueKey('first-run-card')), findsNothing);
      await unmount(tester);
    });

    testWidgets('VE-04/06/08/09 small phone (360x640, text x1.3): first-run card, cancel notice, takeover money lines and help sheet do not overflow', (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = 1.3;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      backend
        ..storeOpen = false
        ..menu = [];
      backend.put(order(id: 'ord-abc123', status: 'ACCEPTED'));
      await launch(tester, size: const Size(360, 640));
      expect(tester.takeException(), isNull);

      sockets.single.emit('order_updated', orderJson(id: 'ord-abc123', status: 'CANCELLED', paymentStatus: 'REFUNDED', cancelledBy: 'ADMIN', cancelReason: 'Kitchen closed for the day because of a long reason', updatedAt: DateTime.now().add(const Duration(minutes: 1))));
      await _settle(tester);
      expect(find.textContaining('Stop cooking'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(find.byKey(const ValueKey('cancelled-notice-ok')));
      await _settle(tester);

      // Empty queue now: the first-run card is on screen.
      expect(find.byKey(const ValueKey('first-run-card')), findsOneWidget);
      expect(tester.takeException(), isNull);

      backend.put(OrderModel.fromJson(orderJson(id: 'ord-new1', total: 1234.5))!);
      sockets.single.emit('new_order_alert', orderJson(id: 'ord-new1', total: 1234.5));
      await _settle(tester);
      expect(find.byType(IncomingOrderDialog), findsOneWidget);
      expect(tester.takeException(), isNull);
      await unmount(tester);
    });

    // -------------------------------------------------------------------------------------------- VE-08

    testWidgets('VE-08 the help sheet offers "Email Kraveo support", never the placeholder helpline', (tester) async {
      final opened = <Uri>[];
      SupportContact.opener = (uri) async {
        opened.add(uri);
        return true;
      };
      addTearDown(() => SupportContact.opener = (uri) async => false);
      await launch(tester);
      await tester.tap(find.bySemanticsLabel('Help and support'));
      await _settle(tester);
      expect(find.text('Call helpline'), findsNothing);
      expect(find.textContaining('98765 43214'), findsNothing);
      expect(find.byKey(const ValueKey('support-email')), findsOneWidget);
      expect(find.text(kSupportEmail), findsOneWidget);

      await tapButton(tester, 'Email Kraveo support');
      await _settle(tester);
      expect(opened.single.scheme, 'mailto');
      expect(opened.single.path, kSupportEmail);
      await unmount(tester);
    });

    testWidgets('VE-08 with no mail app the address is copied and the owner is told', (tester) async {
      String? copied;
      SupportContact.opener = (uri) async => false;
      addTearDown(() => SupportContact.opener = (uri) async => false);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      await launch(tester);
      await tester.tap(find.bySemanticsLabel('Help and support'));
      await _settle(tester);
      await tapButton(tester, 'Email Kraveo support');
      await _settle(tester);
      expect(copied, kSupportEmail);
      expect(find.textContaining('Address copied'), findsOneWidget);
      await unmount(tester);
    });

    // -------------------------------------------------------------------------------------------- VE-09

    testWidgets('VE-09 the takeover and the Orders card show only "You earn" (no customer total, fees or food split)', (tester) async {
      backend.put(order(id: 'ord-1234'));
      await launch(tester);
      expect(find.byType(IncomingOrderDialog), findsOneWidget);
      expect(find.byKey(const ValueKey('earn-help')), findsOneWidget);
      expect(find.byKey(const ValueKey('you-earn')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const ValueKey('you-earn'))).data, '₹205');
      expect(find.textContaining('You earn'), findsWidgets);
      expect(find.textContaining('Customer pays'), findsNothing);
      expect(find.textContaining('delivery'), findsNothing);
      expect(find.text('₹245'), findsNothing, reason: 'the customer total must not be shown');
      await unmount(tester);
    });

    testWidgets('VE-09 the order card says "You earn" with paise when present', (tester) async {
      backend.put(OrderModel.fromJson({...orderJson(id: 'ord-1', status: 'ACCEPTED', total: 245.5), 'subtotal': 205.5})!);
      await launch(tester);
      expect(find.textContaining('You earn ₹205.50'), findsOneWidget);
      expect(find.textContaining('Customer pays'), findsNothing);
      expect(find.textContaining('Food ₹'), findsNothing);
      await unmount(tester);
    });

    // -------------------------------------------------------------------------------------------- VE-10

    testWidgets('VE-10 Back on the home screen asks to press again; a second press within 2 seconds exits', (tester) async {
      var exited = 0;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'SystemNavigator.pop') exited++;
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      await launch(tester);

      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(exited, 0, reason: 'not silently closed');
      expect(find.textContaining('Press back again to exit'), findsOneWidget);

      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(exited, 1);
      await unmount(tester);
    });

    testWidgets('VE-10 after the 2-second window a single Back only shows the hint again', (tester) async {
      var exited = 0;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'SystemNavigator.pop') exited++;
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      await launch(tester);
      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 2100)));
      await tester.binding.handlePopRoute();
      await tester.pump();
      expect(exited, 0);
      await unmount(tester);
    });

    // -------------------------------------------------------------------------------------------- VE-11

    testWidgets('VE-11 an order arriving while the app is "inactive" (shade down, permission dialog) still rings; paused does not', (tester) async {
      await launch(tester);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      backend.put(order(id: 'ord-1'));
      sockets.single.emit('new_order_alert', orderJson(id: 'ord-1'));
      await _settle(tester);
      expect(alarm.ringing, isTrue);
      await unmount(tester);
    });

    testWidgets('VE-11 hidden / paused is background: the in-app alarm stays silent (the system notification rings)', (tester) async {
      await launch(tester);
      for (final s in const [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
        tester.binding.handleAppLifecycleStateChanged(s);
      }
      backend.put(order(id: 'ord-1'));
      sockets.single.emit('new_order_alert', orderJson(id: 'ord-1'));
      await _settle(tester);
      expect(alarm.ringing, isFalse);
      for (final s in const [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
        tester.binding.handleAppLifecycleStateChanged(s);
      }
      await _settle(tester);
      expect(alarm.ringing, isTrue);
      await unmount(tester);
    });

    // -------------------------------------------------------------------------------------------- VE-15

    testWidgets('VE-15 the wake lock is released when the home screen goes away', (tester) async {
      final messages = <String>[];
      const channel = BasicMessageChannel<Object?>('dev.flutter.pigeon.wakelock_plus_platform_interface.WakelockPlusApi.toggle', StandardMessageCodec());
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMessageHandler(channel.name, (ByteData? message) async {
        messages.add('call');
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMessageHandler(channel.name, null));
      await launch(tester);
      final afterStart = messages.length;
      expect(afterStart, greaterThanOrEqualTo(1), reason: 'enabled on start');
      await unmount(tester);
      expect(messages.length, greaterThan(afterStart), reason: 'a second (disable) call was made on dispose');
    });
  });

  // ------------------------------------------------------------------------------------------------ VE-04 controller

  group('VE-04 controller', () {
    Future<(OrderQueueController, FakeBackend, FakeAlarm)> started({Duration chime = const Duration(milliseconds: 40)}) async {
      final backend = FakeBackend()..put(order(id: 'ord-k1', status: 'PREPARING'));
      final alarm = FakeAlarm();
      final c = OrderQueueController(
        backend: backend,
        vendorId: 'ven-42',
        socket: FakeSocket(),
        alarm: alarm,
        pollInterval: const Duration(hours: 1),
        tokenProvider: () async => 'jwt',
        chimeDuration: chime,
      );
      await c.start();
      return (c, backend, alarm);
    }

    test('an order in the kitchen cancelled by Kraveo is reported once, with one short sound that then stops', () async {
      SharedPreferences.setMockInitialValues({});
      final (c, backend, alarm) = await started();
      expect(c.takeKitchenCancellations(), isEmpty);

      backend.serverChange('ord-k1', OrderStatus.cancelled, by: CancelledBy.admin, reason: 'Support cancel');
      await c.refresh();
      final got = c.takeKitchenCancellations();
      expect(got.map((o) => o.id), ['ord-k1']);
      expect(got.single.cancelledBy, CancelledBy.admin);
      expect(c.takeKitchenCancellations(), isEmpty, reason: 'read once');
      expect(alarm.starts, 1);
      expect(alarm.ringing, isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(alarm.ringing, isFalse, reason: 'a short sound, not a loop');
      expect(c.ringing, isFalse);

      await c.refresh(); // the same cancelled copy again: no second alert
      expect(c.takeKitchenCancellations(), isEmpty);
      c.dispose();
    });

    test('cancelled by the restaurant itself is not an alert', () async {
      SharedPreferences.setMockInitialValues({});
      final (c, backend, alarm) = await started();
      backend.serverChange('ord-k1', OrderStatus.cancelled, by: CancelledBy.vendor, reason: 'x');
      await c.refresh();
      expect(c.takeKitchenCancellations(), isEmpty);
      expect(alarm.starts, 0);
      c.dispose();
    });

    test('the sound is skipped while the loud new-order alarm already rings, and in the background', () async {
      SharedPreferences.setMockInitialValues({});
      final (c, backend, alarm) = await started();
      backend.put(order(id: 'ord-new')); // a paid order waiting -> loud alarm
      await c.refresh();
      expect(alarm.starts, 1);
      backend.serverChange('ord-k1', OrderStatus.cancelled, by: CancelledBy.admin);
      await c.refresh();
      expect(c.takeKitchenCancellations(), hasLength(1), reason: 'still reported');
      expect(alarm.starts, 1, reason: 'no extra sound on top of the alarm');
      expect(alarm.ringing, isTrue, reason: 'the real alarm keeps ringing');
      c.dispose();
    });
  });

  // ------------------------------------------------------------------------------------------------ VE-05

  group('VE-05 veg / non-veg', () {
    testWidgets('the Add-dish form defaults to Veg, can switch to Non-veg, and sends it', (tester) async {
      _tallPhone(tester);
      final sent = <bool>[];
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        home: Scaffold(
          body: AddDishModal(onSubmit: (name, category, price, inStock, {bool isVeg = true}) async {
            sent.add(isVeg);
            return null;
          }),
        ),
      ));
      await tester.pump();
      expect(find.text('Veg'), findsOneWidget);
      expect(find.text('Non-veg'), findsOneWidget);

      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'Chicken Biryani');
      await tester.enterText(fields.at(1), '180');
      await tester.tap(find.byKey(const ValueKey('dish-nonveg')));
      await tester.pump();
      await tester.ensureVisible(find.text('Add to menu'));
      await tester.pump();
      await tester.tap(find.text('Add to menu'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(sent, [false]);
    });

    testWidgets('untouched, the dish is Veg', (tester) async {
      _tallPhone(tester);
      final sent = <bool>[];
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        home: Scaffold(
          body: AddDishModal(onSubmit: (name, category, price, inStock, {bool isVeg = true}) async {
            sent.add(isVeg);
            return null;
          }),
        ),
      ));
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'Dal Tadka');
      await tester.enterText(fields.at(1), '120');
      await tester.ensureVisible(find.text('Add to menu'));
      await tester.pump();
      await tester.tap(find.text('Add to menu'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(sent, [true]);
    });

    test('POST /vendors/:id/items carries isVeg', () async {
      late http.Request seen;
      await http.runWithClient(
        () => const HttpVendorBackend().addDish('ven-42', name: 'Chicken Biryani', category: 'Main Course', price: 180, isVeg: false),
        () => MockClient((req) async {
          seen = req;
          return http.Response('{"data":{"id":"m2","name":"Chicken Biryani","price":180,"isAvailable":true}}', 201);
        }),
      );
      expect(jsonDecode(seen.body)['isVeg'], false);
      await http.runWithClient(
        () => const HttpVendorBackend().addDish('ven-42', name: 'Dal', category: 'Main Course', price: 90),
        () => MockClient((req) async {
          seen = req;
          return http.Response('{"data":{"id":"m3","name":"Dal","price":90,"isAvailable":true}}', 201);
        }),
      );
      expect(jsonDecode(seen.body)['isVeg'], true);
    });
  });

  // ------------------------------------------------------------------------------------------------ VE-07 / VE-08 text

  group('VE-07 / VE-08 wording', () {
    testWidgets('VE-07 a phone already used elsewhere says "another Kraveo app or account"', (tester) async {
      _tallPhone(tester);
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        home: SignupScreen(onSubmit: (_) async => const SignupResult.failure(SignupFailure.phoneTaken, field: 'phone')),
      ));
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      Future<void> type(String key, String text) async {
        final f = find.byKey(ValueKey(key));
        await tester.ensureVisible(f);
        await tester.pump();
        await tester.enterText(f, text);
        await tester.pump();
      }

      await type('restaurant-field', 'Shiv Shakti Dhaba');
      await type('address-field', 'Ashta road, near Gate 2');
      await type('owner-field', 'Ramesh Kumar');
      await type('phone-field', '9811100001');
      await type('password-field', 'Passw0rd!x');
      await tester.ensureVisible(find.byKey(const ValueKey('signup-button')));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.byKey(const ValueKey('signup-button')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.textContaining('already registered in another Kraveo app or account'), findsOneWidget);
      expect(find.textContaining('different number'), findsOneWidget);
    });

    testWidgets('VE-08 the login screen shows the support email, not a phone number', (tester) async {
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.vendor(), home: LoginScreen(onSubmit: (p, w) async => const LoginResult.failure(LoginFailure.server))));
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      await tester.ensureVisible(find.byKey(const ValueKey('login-support-email')));
      expect(find.text(kSupportEmail), findsOneWidget);
      expect(find.textContaining('98765 43214'), findsNothing);
    });

    test('VE-08 "an accepted order cannot be declined" points to the email, not a call', () {
      final t = failureText(ApiFailure.conflict, code: 'CANNOT_REJECT');
      expect(t.english, contains(kSupportEmail));
      expect(t.english.toLowerCase(), isNot(contains('call')));
    });

    test('VE-08 the mailto link is addressed to Kraveo support', () {
      final uri = SupportContact.mailtoUri();
      expect(uri.scheme, 'mailto');
      expect(uri.path, 'kraveo.contact@gmail.com');
      expect(uri.toString(), contains('subject='));
    });

    test('VE-08 no placeholder helpline is left in the app source', () {
      for (final f in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'))) {
        expect(f.readAsStringSync(), isNot(contains('98765 43214')), reason: f.path);
        expect(f.readAsStringSync(), isNot(contains('Call helpline')), reason: f.path);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------ VE-09

  group('VE-09 money', () {
    test('formatRupees shows paise only when there are some', () {
      expect(formatRupees(245), '₹245');
      expect(formatRupees(245.0), '₹245');
      expect(formatRupees(49.5), '₹49.50');
      expect(formatRupees(245.15), '₹245.15');
      expect(formatRupees(1240), '₹1,240');
      expect(formatRupees(125000.05), '₹1,25,000.05');
      expect(formatRupees(0), '₹0');
      expect(formatRupees(-49.5), '-₹49.50');
      expect(formatRupees(49.5, paise: false), '₹50');
      expect(formatRupees(0.004), '₹0');
    });

    testWidgets('Earnings count only orders that were accepted or later (a PLACED order still waiting is not money yet)', (tester) async {
      final now = DateTime.now();
      final orders = [
        OrderModel.fromJson(orderJson(id: 'a', status: 'PLACED', createdAt: now.subtract(const Duration(minutes: 3))))!,
        OrderModel.fromJson(orderJson(id: 'b', status: 'ACCEPTED', createdAt: now.subtract(const Duration(minutes: 5)), acceptedAt: now))!,
        OrderModel.fromJson(orderJson(id: 'c', status: 'DELIVERED', createdAt: now.subtract(const Duration(minutes: 9))))!,
      ];
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.vendor(), home: Scaffold(body: SalesAnalyticsScreen(orders: orders, now: now))));
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('₹410'), findsOneWidget, reason: 'two counted orders x food 205, not three');
      expect(find.text('₹615'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a PLACED-only day shows no earnings yet', (tester) async {
      final now = DateTime.now();
      final orders = [OrderModel.fromJson(orderJson(id: 'a', status: 'PLACED', createdAt: now.subtract(const Duration(minutes: 3))))!];
      await tester.pumpWidget(MaterialApp(theme: KraveoTheme.vendor(), home: Scaffold(body: SalesAnalyticsScreen(orders: orders, now: now))));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('No orders yet'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });
  });

  // ------------------------------------------------------------------------------------------------ VE-12

  group('VE-12 price sheet', () {
    test('parseDishPrice accepts normal, decimal and Devanagari input and refuses junk', () {
      expect(parseDishPrice('49.50'), 49.5);
      expect(parseDishPrice(' 120 '), 120);
      expect(parseDishPrice('₹ 99'), 99);
      expect(parseDishPrice('४९'), 49);
      expect(parseDishPrice('४९.५०'), 49.5);
      expect(parseDishPrice('49,5'), 49.5);
      expect(parseDishPrice('12.345'), 12.35);
      expect(parseDishPrice(''), isNull);
      expect(parseDishPrice('abc'), isNull);
      expect(parseDishPrice('1e3'), isNull);
      expect(parseDishPrice('-5'), isNull);
      expect(parseDishPrice('1.2.3'), isNull);
    });

    test('priceFieldText keeps paise', () {
      expect(priceFieldText(49.5), '49.50');
      expect(priceFieldText(180), '180');
    });

    Future<List<double>> openSheet(WidgetTester tester, double price) async {
      final saved = <double>[];
      await tester.pumpWidget(MaterialApp(
        theme: KraveoTheme.vendor(),
        home: Scaffold(body: StockCard(dish: DishModel(id: 'd', name: 'Paneer', category: 'Main Course', price: price), onToggleStock: () {}, onUpdatePrice: saved.add)),
      ));
      await tester.tap(find.byIcon(Icons.edit).evaluate().isNotEmpty ? find.byIcon(Icons.edit) : find.textContaining('₹').first);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      return saved;
    }

    testWidgets('a price with paise is prefilled exactly and "Save price" without a change does not alter it', (tester) async {
      final saved = await openSheet(tester, 49.5);
      expect(tester.widget<TextField>(find.byKey(const ValueKey('price-field'))).controller!.text, '49.50');
      await tester.tap(find.text('Save price'));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump(const Duration(milliseconds: 400));
      expect(saved, isEmpty, reason: 'unchanged price is not re-sent (and certainly not rounded to 50)');
      expect(find.byKey(const ValueKey('price-field')), findsNothing, reason: 'sheet closed');
    });

    testWidgets('bad input shows a message and keeps the sheet open', (tester) async {
      final saved = await openSheet(tester, 180);
      await tester.enterText(find.byKey(const ValueKey('price-field')), 'abc');
      await tester.tap(find.text('Save price'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.textContaining('Enter a price from'), findsOneWidget);
      expect(find.byKey(const ValueKey('price-field')), findsOneWidget);
      expect(saved, isEmpty);

      await tester.enterText(find.byKey(const ValueKey('price-field')), '20000');
      await tester.tap(find.text('Save price'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.textContaining('Enter a price from'), findsOneWidget);
      expect(saved, isEmpty);

      await tester.enterText(find.byKey(const ValueKey('price-field')), '');
      await tester.tap(find.text('Save price'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(saved, isEmpty);
      expect(find.byKey(const ValueKey('price-field')), findsOneWidget);
    });

    testWidgets('Hindi digits are accepted and saved', (tester) async {
      final saved = await openSheet(tester, 180);
      await tester.enterText(find.byKey(const ValueKey('price-field')), '१५०');
      await tester.tap(find.text('Save price'));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump(const Duration(milliseconds: 400));
      expect(saved, [150.0]);
      expect(find.byKey(const ValueKey('price-field')), findsNothing);
    });
  });

  // ------------------------------------------------------------------------------------------------ VE-16 / VE-19 / VE-20

  group('release files', () {
    test('VE-16 the manifest opts out of backups', () {
      final manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
      expect(manifest, contains('android:allowBackup="false"'));
      expect(manifest, contains('android:dataExtractionRules="@xml/data_extraction_rules"'));
      final rules = File('android/app/src/main/res/xml/data_extraction_rules.xml').readAsStringSync();
      expect(rules, contains('<exclude domain="sharedpref"/>'));
    });

    test('VE-20 USE_FULL_SCREEN_INTENT stays because the new-order notification really uses a full-screen intent', () {
      final manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
      final code = File('lib/services/push/local_alarm_notifications.dart').readAsStringSync();
      expect(code, contains('fullScreenIntent: true'));
      expect(manifest, contains('android.permission.USE_FULL_SCREEN_INTENT'));
    });

    test('VE-19 the kitchen says "Preparing" like the other apps, and fixtures use real hostel names', () {
      expect(order(id: 'ord-1', status: 'PREPARING').studentLocation, 'BH1');
      expect(File('lib/widgets/order_card.dart').readAsStringSync(), isNot(contains("'Cooking'")));
      expect(File('lib/screens/kitchen_queue.dart').readAsStringSync(), isNot(contains("english: 'Cooking'")));
    });
  });
}
