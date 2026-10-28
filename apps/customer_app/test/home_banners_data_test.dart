// Home banners (Docs/25 section 4): model parsing, the two API calls and the provider (last good list,
// refresh paths, event batching and dedupe). Payloads are copied from the real backend.
import 'dart:convert';

import 'package:customer_app/models/home_banner.dart';
import 'package:customer_app/providers/banner_provider.dart';
import 'package:customer_app/services/customer_api_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/banner_fixtures.dart';
import 'support/category_fixtures.dart' show jsonResponse;

class _Call {
  _Call(this.method, this.path, this.body);
  final String method, path;
  final Map<String, dynamic>? body;
}

/// A fake server: [onGet] answers GET /banners, every POST /banners/events is recorded.
List<_Call> _serve({required http.Response Function() onGet, http.Response Function()? onPost}) {
  final calls = <_Call>[];
  CustomerApiService.httpClientOverride = MockClient((req) async {
    calls.add(_Call(req.method, req.url.path, req.body.isEmpty ? null : jsonDecode(req.body) as Map<String, dynamic>));
    if (req.method == 'GET' && req.url.path.endsWith('/banners')) return onGet();
    if (req.method == 'POST' && req.url.path.endsWith('/banners/events')) return (onPost ?? () => jsonResponse({'success': true}))();
    return jsonResponse({'success': false}, 404);
  });
  return calls;
}

void main() {
  tearDown(() => CustomerApiService.httpClientOverride = null);

  group('HomeBanner parsing', () {
    test('the real GET /banners rows parse, including a display-only DARK one and a LIGHT one with a link', () {
      final list = HomeBanner.parseList(realBannersBody()['data']);
      expect(list.map((b) => b.title), ['Second', 'First']);
      expect(list[0].theme, BannerTheme.dark);
      expect(list[0].subtitle, isNull);
      expect(list[0].hasLink, isFalse);
      expect(list[1].theme, BannerTheme.light);
      expect(list[1].linkUrl, 'https://forms.gle/AbC123');
      expect(list[1].ctaLabel, 'Join now');
      expect(list[1].semanticLabel, 'First, Sub. Opens link');
      expect(list[0].semanticLabel, 'Second');
    });

    test('every link that is not a plain https address becomes "no link", the banner stays', () {
      for (final bad in [
        'http://example.com/x',
        'javascript:alert(1)',
        'data:text/html,hi',
        'intent://scan/#Intent;scheme=zxing;end',
        'market://details?id=x',
        'mailto:a@b.com',
        'tel:+911234567890',
        'file:///etc/passwd',
        'kraveo://open',
        'https:example.com',
        'https://user:pw@example.com/',
        'https://localhost/x',
        'https://exa mple.com',
        '//example.com',
        'example.com',
        '',
        '   ',
        42,
        true,
        {'a': 1},
      ]) {
        final b = HomeBanner.tryParse(bannerRow('x', linkUrl: null)..['linkUrl'] = bad);
        expect(b, isNotNull, reason: '$bad');
        expect(b!.linkUrl, isNull, reason: '$bad');
        expect(b.linkUri, isNull, reason: '$bad');
        expect(b.semanticLabel.contains('Opens link'), isFalse);
      }
      for (final ok in ['https://play.google.com/store/apps/details?id=x', 'HTTPS://Forms.gle/AbC', '  https://docs.google.com/forms/d/e/1/viewform  ']) {
        final b = HomeBanner.tryParse(bannerRow('x')..['linkUrl'] = ok)!;
        expect(b.linkUri!.scheme, 'https', reason: ok);
      }
    });

    test('garbled rows are skipped, bad fields get defaults', () {
      final list = HomeBanner.parseList([
        'text',
        null,
        7,
        <String, dynamic>{},
        bannerRow('a', title: '   '), // blank title
        {...bannerRow('b'), 'id': null},
        {...bannerRow('c'), 'title': 12},
        {...bannerRow('d'), 'imageUrl': null},
        {...bannerRow('e'), 'imageUrl': 'http://insecure.example.com/a.jpg'}, // an image is https too
        {...bannerRow('f'), 'imageUrl': 'javascript:1'},
        {...bannerRow('g', title: '  Spaced \n out  ', subtitle: '   ', ctaLabel: ''), 'theme': 'purple'},
        {...bannerRow('h'), 'theme': 'light'},
        bannerRow('g'), // repeated id
      ]);
      expect(list.map((b) => b.id), ['g', 'h']);
      expect(list.first.title, 'Spaced out');
      expect(list.first.subtitle, isNull);
      expect(list.first.ctaLabel, isNull);
      expect(list.first.theme, BannerTheme.dark, reason: 'unknown theme -> DARK');
      expect(list.last.theme, BannerTheme.light);
      for (final bad in [null, 'x', 5, <String, dynamic>{}, {'data': []}]) {
        expect(HomeBanner.parseList(bad), isEmpty);
      }
    });

    test('at most ten banners are kept', () {
      expect(HomeBanner.parseList([for (var i = 0; i < 14; i++) bannerRow('b$i')]).length, 10);
    });
  });

  group('API calls', () {
    test('fetchBanners reads the real answer; an empty list is an answer', () async {
      _serve(onGet: () => jsonResponse(realBannersBody()));
      expect((await CustomerApiService.fetchBanners()).length, 2);
      _serve(onGet: () => jsonResponse(emptyBannersBody()));
      expect(await CustomerApiService.fetchBanners(), isEmpty);
    });

    test('404 (old server), 500, non-JSON, wrong shapes and "rows but none usable" all throw', () async {
      final answers = <http.Response Function()>[
        () => jsonResponse({'success': false, 'code': 'NOT_FOUND'}, 404),
        () => jsonResponse({'success': false}, 500),
        () => jsonResponse('<html>gateway</html>'),
        () => jsonResponse({'success': true}),
        () => jsonResponse({'success': true, 'data': 'x'}),
        () => jsonResponse({'success': false, 'data': []}),
        () => jsonResponse([1, 2]),
        () => jsonResponse({'success': true, 'data': [{'id': 1}, 'junk']}),
      ];
      for (final a in answers) {
        _serve(onGet: a);
        await expectLater(CustomerApiService.fetchBanners(), throwsA(anything));
      }
    });

    test('sendBannerEvents posts only what it is given, and never throws', () async {
      final calls = _serve(onGet: () => jsonResponse(realBannersBody()));
      await CustomerApiService.sendBannerEvents();
      expect(calls, isEmpty);
      await CustomerApiService.sendBannerEvents(views: ['v1']);
      await CustomerApiService.sendBannerEvents(clicks: ['c1']);
      expect(calls.map((c) => c.path.endsWith('/banners/events')), [true, true]);
      expect(calls[0].body, {'views': ['v1']});
      expect(calls[1].body, {'clicks': ['c1']});
      CustomerApiService.httpClientOverride = MockClient((_) async => throw Exception('offline'));
      await CustomerApiService.sendBannerEvents(views: ['v1']);
      CustomerApiService.httpClientOverride = MockClient((_) async => jsonResponse('', 500));
      await CustomerApiService.sendBannerEvents(views: ['v1']);
    });
  });

  group('BannerProvider', () {
    test('starts empty, shows the list after the first success', () async {
      _serve(onGet: () => jsonResponse(realBannersBody()));
      final p = BannerProvider();
      addTearDown(p.dispose);
      expect(p.banners, isEmpty);
      var notified = 0;
      p.addListener(() => notified++);
      await p.refresh();
      expect(p.banners.map((b) => b.title), ['Second', 'First']);
      expect(notified, 1);
    });

    test('a failed refresh keeps the last good list (no notification), a first failure leaves it empty', () async {
      var body = realBannersBody();
      var status = 200;
      _serve(onGet: () => jsonResponse(body, status));
      final p = BannerProvider();
      addTearDown(p.dispose);
      status = 404;
      await p.refresh();
      expect(p.banners, isEmpty, reason: 'old server: nothing to show');
      status = 200;
      await p.refresh();
      expect(p.banners.length, 2);
      var notified = 0;
      p.addListener(() => notified++);
      for (final broken in [
        () => jsonResponse({'success': false}, 500),
        () => jsonResponse('not json'),
        () => jsonResponse(bannersBody([{'id': 1}])), // rows, none usable
      ]) {
        _serve(onGet: broken);
        await p.refresh();
      }
      CustomerApiService.httpClientOverride = MockClient((_) async => throw Exception('offline'));
      await p.refresh();
      expect(p.banners.length, 2);
      expect(notified, 0);
    });

    test('the server answer replaces the list: new banners appear, an empty answer clears it, an identical one is silent', () async {
      var rows = [bannerRow('a'), bannerRow('b')];
      _serve(onGet: () => jsonResponse(bannersBody(rows)));
      final p = BannerProvider();
      addTearDown(p.dispose);
      var notified = 0;
      p.addListener(() => notified++);
      await p.refresh();
      await p.refresh();
      expect(notified, 1, reason: 'the second answer was identical');
      rows = [bannerRow('b'), bannerRow('c', title: 'New')];
      await p.refresh();
      expect(p.banners.map((b) => b.id), ['b', 'c']);
      rows = [];
      await p.refresh();
      expect(p.banners, isEmpty);
      expect(notified, 3);
    });

    test('overlapping refreshes (open + resume + pull) share one request', () async {
      final calls = _serve(onGet: () => jsonResponse(realBannersBody()));
      final p = BannerProvider();
      addTearDown(p.dispose);
      await Future.wait([p.refresh(), p.refresh(), p.refresh()]);
      expect(calls.where((c) => c.method == 'GET').length, 1);
      await p.refresh();
      expect(calls.where((c) => c.method == 'GET').length, 2);
    });

    testWidgets('views count once per banner per app session and are sent together after a short wait', (tester) async {
      final calls = _serve(onGet: () => jsonResponse(realBannersBody()));
      final p = BannerProvider(eventDelay: const Duration(seconds: 2));
      addTearDown(p.dispose);
      p.recordView('a');
      p.recordView('a');
      p.recordView('b');
      await tester.pump(const Duration(seconds: 1));
      expect(calls, isEmpty, reason: 'still waiting for company');
      p.recordView('a'); // a duplicate does not restart anything
      await tester.pump(const Duration(seconds: 1, milliseconds: 100));
      await tester.pump();
      expect(calls.length, 1);
      expect(calls.single.method, 'POST');
      expect((calls.single.body!['views'] as List).toSet(), {'a', 'b'});
      expect(calls.single.body!.containsKey('clicks'), isFalse);
      p.recordView('a');
      await p.flushEvents();
      expect(calls.length, 1, reason: 'seen this session: never counted twice');
    });

    test('every tap is a click; clicks and views travel together, within the server caps (10 views / 5 clicks, an id once per call)', () async {
      final calls = _serve(onGet: () => jsonResponse(realBannersBody()));
      final p = BannerProvider();
      addTearDown(p.dispose);
      for (var i = 0; i < 12; i++) {
        p.recordView('v$i');
      }
      for (final id in ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        p.recordClick(id);
      }
      await p.flushEvents();
      expect(calls.length, 2);
      for (final c in calls) {
        expect((c.body!['views'] as List? ?? const []).length, lessThanOrEqualTo(10));
        final clicks = (c.body!['clicks'] as List? ?? const []);
        expect(clicks.length, lessThanOrEqualTo(5));
        expect(clicks.toSet().length, clicks.length);
      }
      final views = calls.expand((c) => (c.body!['views'] as List? ?? const [])).toList();
      expect(views.length, 12);
      final clicks = calls.expand((c) => (c.body!['clicks'] as List? ?? const [])).toList()..sort();
      expect(clicks, ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
    });

    test('a failing events call is ignored and does not block later ones', () async {
      final calls = _serve(onGet: () => jsonResponse(realBannersBody()), onPost: () => jsonResponse({'success': false}, 500));
      final p = BannerProvider();
      addTearDown(p.dispose);
      p.recordView('a');
      await p.flushEvents();
      p.recordClick('a');
      await p.flushEvents();
      expect(calls.length, 2);
    });
  });
}
