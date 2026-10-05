import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/location/campus_geo.dart';
import '../services/location/location_capture.dart';
import '../services/location/location_scope.dart';
import 'ui/confirm_sheet.dart';
import 'ui/vendor_ui.dart';

/// Keys for tests.
const Key kLocationDetectKey = ValueKey('location-detect-button');
const Key kLocationSkipKey = ValueKey('location-skip-button');
const Key kLocationCancelKey = ValueKey('location-cancel-button');
const Key kLocationRetryKey = ValueKey('location-retry-button');
const Key kLocationAcceptKey = ValueKey('location-accept-button');
const Key kLocationAcceptWeakKey = ValueKey('location-accept-weak-button');
const Key kLocationSettingsKey = ValueKey('location-settings-button');
const Key kLocationMapLinkKey = ValueKey('location-map-link');
const Key kLocationCoordsKey = ValueKey('location-coords');
const Key kLocationAccuracyKey = ValueKey('location-accuracy');
const Key kLocationProblemTitleKey = ValueKey('location-problem-title');
const Key kLocationWeakKey = ValueKey('location-weak-warning');
const Key kLocationSaveErrorKey = ValueKey('location-save-error');
const Key kLocationOutsideKey = ValueKey('location-outside-campus');

/// The one capture screen, shown as a bottom sheet: why we ask -> looking for GPS -> the result to check -> save.
/// Used by the create-account form (pick only), the login / app-start prompt, the banner and the account sheet
/// (save to Kraveo).
///
/// Resolves to the fix the owner accepted (and, when [onSave] is given, that Kraveo saved), or null when the sheet was
/// closed / skipped. Nothing is saved without the owner seeing the coordinates and accuracy first.
Future<LocationFix?> showLocationDetectSheet(
  BuildContext context, {
  required LocationServices services,
  required String title,
  required String hindiTitle,
  required String skipLabel,
  required String skipSublabel,
  String acceptLabel = 'Save location',
  String acceptSublabel = 'लोकेशन सेव करें',

  /// Saves an accepted fix. Returns null on success, else the message to show (the owner can retry).
  /// Null = just hand the fix back to the caller (create-account form).
  Future<String?> Function(LocationFix fix)? onSave,

  /// Ask "are you sure?" before saving (changing the pin of a running restaurant changes where riders go).
  bool confirmBeforeSave = false,
}) {
  return showKSheet<LocationFix>(
    context,
    builder: (ctx) => _LocationSheetBody(
      services: services,
      title: title,
      hindiTitle: hindiTitle,
      skipLabel: skipLabel,
      skipSublabel: skipSublabel,
      acceptLabel: acceptLabel,
      acceptSublabel: acceptSublabel,
      onSave: onSave,
      confirmBeforeSave: confirmBeforeSave,
    ),
  );
}

enum _Phase { intro, detecting, result, problem, outside }

class _LocationSheetBody extends StatefulWidget {
  const _LocationSheetBody({
    required this.services,
    required this.title,
    required this.hindiTitle,
    required this.skipLabel,
    required this.skipSublabel,
    required this.acceptLabel,
    required this.acceptSublabel,
    required this.onSave,
    required this.confirmBeforeSave,
  });

  final LocationServices services;
  final String title;
  final String hindiTitle;
  final String skipLabel;
  final String skipSublabel;
  final String acceptLabel;
  final String acceptSublabel;
  final Future<String?> Function(LocationFix fix)? onSave;
  final bool confirmBeforeSave;

  @override
  State<_LocationSheetBody> createState() => _LocationSheetBodyState();
}

class _LocationSheetBodyState extends State<_LocationSheetBody> {
  _Phase _phase = _Phase.intro;
  LocationProblem? _problem;
  CaptureResult? _result;
  LocationFix? _progress;
  bool _saving = false;
  String? _saveError;
  bool _linkFailed = false;
  int _attempt = 0;

  LocationCapture get _capture => widget.services.capture;

  @override
  void dispose() {
    // Closing the sheet while looking for GPS stops the GPS.
    if (_phase == _Phase.detecting) _capture.cancel();
    super.dispose();
  }

  Future<void> _detect() async {
    final attempt = ++_attempt;
    setState(() {
      _phase = _Phase.detecting;
      _progress = null;
      _saveError = null;
      _linkFailed = false;
    });
    final result = await _capture.detect(onProgress: (best, _) {
      if (mounted && attempt == _attempt) setState(() => _progress = best);
    });
    if (!mounted || attempt != _attempt) return;
    final problem = result.problem;
    if (problem == LocationProblem.cancelled) return;
    if (problem != null) {
      setState(() {
        _phase = _Phase.problem;
        _problem = problem;
      });
      return;
    }
    final fix = result.fix!;
    setState(() {
      _result = result;
      // A spot outside the campus area is shown, not saved: the server would refuse it anyway.
      _phase = isNearCampus(fix.lat, fix.lng) ? _Phase.result : _Phase.outside;
    });
  }

  void _cancelDetect() {
    _attempt++;
    _capture.cancel();
    setState(() => _phase = _Phase.intro);
  }

  Future<void> _openMap(LocationFix fix) async {
    bool opened;
    try {
      opened = await widget.services.openUrl(googleMapsLink(fix.lat, fix.lng));
    } catch (_) {
      opened = false;
    }
    if (mounted) setState(() => _linkFailed = !opened);
  }

  Future<void> _accept({required bool weak}) async {
    final fix = _result?.fix;
    if (fix == null || _saving) return;
    if (widget.confirmBeforeSave || weak) {
      final changing = widget.confirmBeforeSave;
      final yes = await showConfirmSheet(
        context,
        icon: weak ? LucideIcons.triangleAlert : LucideIcons.mapPin,
        title: changing ? 'Change your restaurant location?' : 'Save a rough location?',
        hindiTitle: changing ? 'रेस्टोरेंट की लोकेशन बदलें?' : 'अनुमानित लोकेशन सेव करें?',
        message: [
          if (changing) 'Riders will go to this new spot from now on.\nअब राइडर इस नई जगह पर आएंगे।',
          if (weak) 'The GPS is weak (${formatAccuracy(fix.accuracyM)}). Riders may be sent a little away from your kitchen.\nGPS कमज़ोर है, राइडर रसोई से थोड़ा दूर पहुँच सकते हैं।',
        ].join('\n\n'),
        safeLabel: 'Go back',
        safeSublabel: 'वापस जाएं',
        confirmLabel: changing ? 'Yes, change it' : 'Yes, save it',
        confirmSublabel: changing ? 'हाँ, बदलें' : 'हाँ, सेव करें',
        destructive: false,
      );
      if (!yes || !mounted) return;
    }
    final save = widget.onSave;
    if (save == null) {
      Navigator.of(context).pop(fix);
      return;
    }
    setState(() {
      _saving = true;
      _saveError = null;
    });
    String? error;
    try {
      error = await save(fix);
    } catch (_) {
      error = 'Could not save the location. Please try again.  ·  लोकेशन सेव नहीं हुई, फिर कोशिश करें';
    }
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop(fix);
      return;
    }
    setState(() {
      _saving = false;
      _saveError = error;
    });
  }

  void _skip() => Navigator.of(context).pop();

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, 24),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: switch (_phase) {
        _Phase.intro => _intro(k),
        _Phase.detecting => _detecting(k),
        _Phase.result => _resultView(k),
        _Phase.problem => _problemView(k),
        _Phase.outside => _outsideView(k),
      }),
    );
  }

  // ------------------------------------------------------------------ pieces

  Widget _badge(IconData icon, Color tone) => Center(
        child: Container(
          width: 76,
          height: 76,
          decoration: BoxDecoration(color: tone.withValues(alpha: 0.12), shape: BoxShape.circle),
          child: Icon(icon, size: 36, color: tone),
        ),
      );

  List<Widget> _heading(KraveoTokens k, String en, String hi, {Key? key}) => [
        Semantics(
          header: true,
          child: Text(en, key: key, textAlign: TextAlign.center, style: KraveoType.headline.copyWith(color: k.ink)),
        ),
        const SizedBox(height: 4),
        Text(hi, textAlign: TextAlign.center, style: KraveoType.titleLg.copyWith(color: k.inkMuted)),
      ];

  Widget _body(KraveoTokens k, String en, String hi) => Column(children: [
        Text(en, textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.ink, fontSize: 16)),
        const SizedBox(height: 4),
        Text(hi, textAlign: TextAlign.center, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 15)),
      ]);

  Widget _skipButton() => KButton(
        key: kLocationSkipKey,
        label: widget.skipLabel,
        sublabel: widget.skipSublabel,
        kind: KButtonKind.ghost,
        large: true,
        onPressed: _saving ? null : _skip,
      );

  List<Widget> _intro(KraveoTokens k) => [
        _badge(LucideIcons.mapPin, k.brand),
        const SizedBox(height: 16),
        ..._heading(k, widget.title, widget.hindiTitle),
        const SizedBox(height: 12),
        _body(k, 'Riders use this to find your kitchen. We only read your location when you tap Detect.',
            'राइडर इससे आपकी रसोई ढूंढते हैं। हम आपकी लोकेशन तभी पढ़ते हैं जब आप Detect दबाते हैं।'),
        const SizedBox(height: 8),
        Text('Stand at your kitchen, outside if you can.  ·  रसोई पर खड़े हों, हो सके तो बाहर।',
            textAlign: TextAlign.center, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
        const SizedBox(height: 22),
        KButton(key: kLocationDetectKey, label: 'Detect my location', sublabel: 'मेरी लोकेशन पता करें', icon: LucideIcons.crosshair, large: true, onPressed: _detect),
        const SizedBox(height: 12),
        _skipButton(),
      ];

  List<Widget> _detecting(KraveoTokens k) {
    final best = _progress;
    return [
      Center(child: SizedBox(width: 56, height: 56, child: CircularProgressIndicator(strokeWidth: 4, color: k.brand))),
      const SizedBox(height: 18),
      ..._heading(k, 'Looking for your location…', 'लोकेशन ढूंढ रहे हैं…'),
      const SizedBox(height: 12),
      Semantics(
        liveRegion: true,
        child: _body(
          k,
          best == null ? 'This can take up to 20 seconds. Stay still, outside if you can.' : 'Best so far: ${formatAccuracy(best.accuracyM)}. Still checking…',
          best == null ? '20 सेकंड तक लग सकते हैं। रुके रहें, हो सके तो बाहर।' : 'अब तक सबसे अच्छा। जाँच जारी है…',
        ),
      ),
      const SizedBox(height: 22),
      KButton(key: kLocationCancelKey, label: 'Cancel', sublabel: 'रद्द करें', kind: KButtonKind.ghost, large: true, onPressed: _cancelDetect),
    ];
  }

  Widget _coordsCard(KraveoTokens k, LocationFix fix) => KCard(
        elevated: false,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(LucideIcons.mapPin, size: 22, color: k.brand),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                '${fix.lat.toStringAsFixed(6)}, ${fix.lng.toStringAsFixed(6)}',
                key: kLocationCoordsKey,
                style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800),
              ),
            ),
          ]),
          const SizedBox(height: 6),
          Text('Accuracy: ${formatAccuracy(fix.accuracyM)}  ·  सटीकता', key: kLocationAccuracyKey, style: KraveoType.titleMd.copyWith(color: k.inkMuted, fontSize: 16)),
          const SizedBox(height: 10),
          KButton(
            key: kLocationMapLinkKey,
            label: 'Open in Google Maps to check',
            sublabel: 'गूगल मैप्स में देखें',
            kind: KButtonKind.tonal,
            icon: LucideIcons.externalLink,
            onPressed: () => _openMap(fix),
          ),
          if (_linkFailed)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Could not open Maps on this phone. The coordinates above are the location.  ·  मैप्स नहीं खुला, ऊपर लिखे अंक ही लोकेशन हैं।',
                  style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
            ),
        ]),
      );

  Widget _notice(KraveoTokens k, {required Key key, required IconData icon, required Color tone, required String en, required String hi}) => Container(
        key: key,
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Color.alphaBlend(tone.withValues(alpha: 0.10), k.surface),
          borderRadius: BorderRadius.circular(KRadius.lg),
          border: Border.all(color: tone, width: 1.6),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, size: 24, color: tone),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(en, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16, fontWeight: FontWeight.w800)),
              const SizedBox(height: 2),
              Text(hi, style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 14)),
            ]),
          ),
        ]),
      );

  List<Widget> _resultView(KraveoTokens k) {
    final r = _result!;
    final fix = r.fix!;
    final weak = r.weak;
    final saveWord = widget.onSave == null ? 'Use this location' : widget.acceptLabel;
    final saveHindi = widget.onSave == null ? 'यह लोकेशन लें' : widget.acceptSublabel;
    final err = _saveError;
    return [
      _badge(weak ? LucideIcons.triangleAlert : LucideIcons.circleCheck, weak ? KraveoPalette.warning : k.brand),
      const SizedBox(height: 16),
      ..._heading(k, weak ? 'Found, but the GPS is weak' : 'Location found', weak ? 'मिली, पर GPS कमज़ोर है' : 'लोकेशन मिल गई'),
      const SizedBox(height: 14),
      _coordsCard(k, fix),
      if (weak) ...[
        const SizedBox(height: 12),
        _notice(k,
            key: kLocationWeakKey,
            icon: LucideIcons.signalLow,
            tone: KraveoPalette.warning,
            en: 'GPS is weak - step outside and try again',
            hi: 'GPS कमज़ोर है - बाहर आकर फिर कोशिश करें'),
      ],
      if (err != null) ...[
        const SizedBox(height: 12),
        Semantics(
          liveRegion: true,
          child: _notice(k, key: kLocationSaveErrorKey, icon: LucideIcons.circleAlert, tone: kDangerDeep, en: err, hi: 'लोकेशन अभी सेव नहीं हुई।'),
        ),
      ],
      const SizedBox(height: 20),
      if (weak) ...[
        KButton(key: kLocationRetryKey, label: 'Try again', sublabel: 'फिर कोशिश करें', icon: LucideIcons.rotateCcw, large: true, onPressed: _saving ? null : _detect),
        const SizedBox(height: 12),
        KButton(
            key: kLocationAcceptWeakKey,
            label: err == null ? 'Save anyway' : 'Try saving again',
            sublabel: err == null ? 'फिर भी सेव करें' : 'फिर से सेव करें',
            kind: KButtonKind.tonal,
            large: true,
            loading: _saving,
            onPressed: () => _accept(weak: true)),
      ] else ...[
        KButton(
            key: kLocationAcceptKey,
            label: err == null ? saveWord : 'Try saving again',
            sublabel: err == null ? saveHindi : 'फिर से सेव करें',
            icon: LucideIcons.check,
            large: true,
            loading: _saving,
            onPressed: () => _accept(weak: false)),
        const SizedBox(height: 12),
        KButton(key: kLocationRetryKey, label: 'Try again', sublabel: 'फिर कोशिश करें', kind: KButtonKind.ghost, large: true, onPressed: _saving ? null : _detect),
      ],
      const SizedBox(height: 12),
      _skipButton(),
    ];
  }

  List<Widget> _outsideView(KraveoTokens k) {
    final fix = _result!.fix!;
    final km = distanceToCampusKm(fix.lat, fix.lng);
    final away = km < 10 ? km.toStringAsFixed(1) : km.round().toString();
    return [
      _badge(LucideIcons.mapPinOff, KraveoPalette.warning),
      const SizedBox(height: 16),
      ..._heading(k, 'This is not near the campus', 'यह जगह कैम्पस के पास नहीं है', key: kLocationOutsideKey),
      const SizedBox(height: 12),
      _body(k, 'Your phone says you are about $away km from the campus, so this was not saved. Go to your kitchen and try again.',
          'आपका फ़ोन कैम्पस से करीब $away किमी दूर बता रहा है, इसलिए सेव नहीं हुई। रसोई पर जाकर फिर कोशिश करें।'),
      const SizedBox(height: 14),
      _coordsCard(k, fix),
      const SizedBox(height: 20),
      KButton(key: kLocationRetryKey, label: 'Try again', sublabel: 'फिर कोशिश करें', icon: LucideIcons.rotateCcw, large: true, onPressed: _detect),
      const SizedBox(height: 12),
      _skipButton(),
    ];
  }

  List<Widget> _problemView(KraveoTokens k) {
    final p = _problem ?? LocationProblem.unavailable;
    final (IconData icon, String en, String hi, String bodyEn, String bodyHi) = switch (p) {
      LocationProblem.serviceOff => (
          LucideIcons.locateOff,
          'Location is switched off',
          'फ़ोन की लोकेशन बंद है',
          'Turn on your phone\'s location (GPS), then try again.',
          'फ़ोन की लोकेशन (GPS) चालू करें, फिर कोशिश करें।',
        ),
      LocationProblem.permissionDenied => (
          LucideIcons.lock,
          'Allow location to continue',
          'आगे बढ़ने के लिए लोकेशन की अनुमति दें',
          'Kraveo only reads your location when you tap Detect, and only to show riders your kitchen.',
          'Kraveo आपकी लोकेशन सिर्फ़ Detect दबाने पर पढ़ता है, ताकि राइडर आपकी रसोई ढूंढ सकें।',
        ),
      LocationProblem.permissionDeniedForever => (
          LucideIcons.lock,
          'Location is blocked for Kraveo',
          'Kraveo के लिए लोकेशन बंद है',
          'Open the app settings, tap Permissions, then Location, and choose "Allow only while using the app".',
          'ऐप सेटिंग खोलें, Permissions > Location में "ऐप इस्तेमाल करते समय अनुमति दें" चुनें।',
        ),
      LocationProblem.timeout => (
          LucideIcons.satelliteDish,
          'No GPS signal',
          'GPS सिग्नल नहीं मिला',
          'We could not find your location in 20 seconds. Step outside or stand near a window and try again.',
          '20 सेकंड में लोकेशन नहीं मिली। बाहर आएं या खिड़की के पास खड़े होकर फिर कोशिश करें।',
        ),
      _ => (
          LucideIcons.triangleAlert,
          'Could not read your location',
          'लोकेशन नहीं पढ़ पाए',
          'Something went wrong on the phone. Please try again.',
          'फ़ोन में कुछ दिक्कत आई। फिर कोशिश करें।',
        ),
    };
    final opensSettings = p == LocationProblem.serviceOff || p == LocationProblem.permissionDeniedForever;
    return [
      _badge(icon, KraveoPalette.warning),
      const SizedBox(height: 16),
      ..._heading(k, en, hi, key: kLocationProblemTitleKey),
      const SizedBox(height: 12),
      _body(k, bodyEn, bodyHi),
      const SizedBox(height: 22),
      if (opensSettings) ...[
        KButton(
          key: kLocationSettingsKey,
          label: p == LocationProblem.serviceOff ? 'Open location settings' : 'Open app settings',
          sublabel: p == LocationProblem.serviceOff ? 'लोकेशन सेटिंग खोलें' : 'ऐप सेटिंग खोलें',
          icon: LucideIcons.settings,
          large: true,
          onPressed: () => _capture.openSettingsFor(p),
        ),
        const SizedBox(height: 12),
        KButton(key: kLocationRetryKey, label: 'Try again', sublabel: 'फिर कोशिश करें', kind: KButtonKind.tonal, large: true, onPressed: _detect),
      ] else
        KButton(
          key: kLocationRetryKey,
          label: p == LocationProblem.permissionDenied ? 'Allow location' : 'Try again',
          sublabel: p == LocationProblem.permissionDenied ? 'लोकेशन की अनुमति दें' : 'फिर कोशिश करें',
          icon: LucideIcons.rotateCcw,
          large: true,
          onPressed: _detect,
        ),
      const SizedBox(height: 12),
      _skipButton(),
    ];
  }
}
