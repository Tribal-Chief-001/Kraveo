import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/partner_session.dart';
import '../services/location/location_capture.dart';
import '../services/location/location_scope.dart';
import '../services/partner_auth_service.dart';
import '../widgets/location_sheet.dart';
import '../widgets/ui/choice_chip.dart';
import '../widgets/ui/field_block.dart';
import '../widgets/ui/phone_input.dart';
import '../widgets/ui/vendor_ui.dart';

/// Kinds of kitchen to pick from. One tap, no typing; the last choice is simply "Other".
const List<(String, String)> kVendorCategories = [
  ('North Indian', 'उत्तर भारतीय'),
  ('Rolls & Wraps', 'रोल'),
  ('Tea & Snacks', 'चाय-नाश्ता'),
  ('Chinese', 'चाइनीज़'),
  ('Biryani', 'बिरयानी'),
  ('South Indian', 'दक्षिण भारतीय'),
  ('Other', 'अन्य'),
];

/// Create a restaurant account (phone + password). With [existing] set it instead edits the details of a
/// pending or rejected application and sends them again; phone and password are not asked in that case.
class SignupScreen extends StatefulWidget {
  const SignupScreen({super.key, required this.onSubmit, this.existing});

  final Future<SignupResult> Function(PartnerSignupForm form) onSubmit;
  final PartnerSession? existing;

  @override
  State<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends State<SignupScreen> {
  late final TextEditingController _restaurant = TextEditingController(text: widget.existing?.vendorName ?? '');
  late final TextEditingController _address = TextEditingController(text: widget.existing?.address ?? '');
  late final TextEditingController _owner = TextEditingController(text: widget.existing?.name ?? '');
  final _phone = TextEditingController();
  final _password = TextEditingController();
  late final TextEditingController _fssai = TextEditingController(text: widget.existing?.fssaiNumber ?? '');

  final _ownerFocus = FocusNode();
  final _phoneFocus = FocusNode();
  final _passwordFocus = FocusNode();
  final _addressFocus = FocusNode();

  late String? _category = widget.existing?.category;
  bool _showPassword = false;
  bool _showFssai = false;
  bool _busy = false;

  /// The kitchen position detected with "Use my current location" (optional).
  LocationFix? _fix;
  final Map<String, String> _errors = {};
  String? _problem;

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    _showFssai = _fssai.text.isNotEmpty;
  }

  @override
  void dispose() {
    for (final c in [_restaurant, _address, _owner, _phone, _password, _fssai]) {
      c.dispose();
    }
    for (final f in [_ownerFocus, _phoneFocus, _passwordFocus, _addressFocus]) {
      f.dispose();
    }
    super.dispose();
  }

  Map<String, String> _validate() {
    final e = <String, String>{};
    if (_restaurant.text.trim().length < 2) e['restaurantName'] = 'Enter the restaurant name\nरेस्टोरेंट का नाम डालें';
    if (_address.text.trim().length < 3) e['address'] = 'Tell us where the kitchen is\nबताएं कि रसोई कहाँ है';
    if (_owner.text.trim().length < 2) e['name'] = 'Enter your name\nअपना नाम डालें';
    if (!_editing) {
      if (!isValidIndianMobile(_phone.text.trim())) e['phone'] = 'Enter your 10-digit mobile number\n10 अंकों का मोबाइल नंबर डालें';
      if (_password.text.length < 8) e['password'] = 'Use at least 8 characters\nकम से कम 8 अक्षर रखें';
    }
    final fssai = _fssai.text.replaceAll(RegExp(r'\s'), '');
    if (fssai.isNotEmpty && !RegExp(r'^\d{14}$').hasMatch(fssai)) e['fssaiNumber'] = 'FSSAI number has 14 digits\nFSSAI नंबर 14 अंकों का होता है';
    return e;
  }

  Future<void> _submit() async {
    if (_busy) return;
    FocusScope.of(context).unfocus();
    final errors = _validate();
    if (errors.isNotEmpty) {
      setState(() {
        _errors
          ..clear()
          ..addAll(errors);
        _problem = null;
      });
      return;
    }
    setState(() {
      _busy = true;
      _errors.clear();
      _problem = null;
    });
    final form = PartnerSignupForm(
      ownerName: _owner.text.trim(),
      phone: _phone.text.trim(),
      password: _password.text,
      restaurantName: _restaurant.text.trim(),
      address: _address.text.trim(),
      category: (_category == null || _category == 'Other') ? '' : _category!,
      fssaiNumber: _fssai.text.replaceAll(RegExp(r'\s'), ''),
      lat: _fix?.lat,
      lng: _fix?.lng,
      locationAccuracyM: _fix?.accuracyM,
    );
    SignupResult result;
    try {
      result = await widget.onSubmit(form);
    } catch (_) {
      result = const SignupResult.failure(SignupFailure.server);
    }
    if (!mounted) return;
    if (result.ok) {
      // The session gate swaps in the "waiting for approval" screen; close this form on top of it.
      _password.clear();
      setState(() => _busy = false);
      Navigator.of(context).popUntil((route) => route.isFirst);
      return;
    }
    setState(() {
      _busy = false;
      switch (result.failure!) {
        case SignupFailure.invalid:
          if (const {'location', 'lat', 'lng', 'locationAccuracyM'}.contains(result.field)) {
            // The server did not accept the detected spot: drop it and say why; the account can still be made without it.
            _fix = null;
            _problem = '${result.message ?? 'Kraveo could not use this location.'}\nThe location was removed. Detect it again, or create the account without it.\nलोकेशन हटा दी गई। फिर से पता करें या बिना लोकेशन के अकाउंट बनाएं।';
          } else if (result.field != null && result.message != null) {
            _errors[result.field!] = result.message!;
          } else {
            _problem = result.message ?? 'Please check the details and try again.\nजानकारी जाँचकर फिर कोशिश करें।';
          }
        case SignupFailure.phoneTaken:
          _errors['phone'] = 'This number already has an account. Go back and log in.\nइस नंबर का अकाउंट पहले से है। वापस जाकर लॉग इन करें।';
        case SignupFailure.rateLimited:
          _problem = 'Too many tries. Please try again in an hour.\nबहुत कोशिशें हो गईं। एक घंटे बाद फिर कोशिश करें।';
        case SignupFailure.unauthorized:
          _problem = 'Your session ended. Please log in again.\nसेशन खत्म हो गया। फिर से लॉग इन करें।';
        case SignupFailure.offline:
          _problem = 'Can\'t reach Kraveo. Check your internet and try again.\nइंटरनेट जाँचें और फिर कोशिश करें।';
        case SignupFailure.server:
          _problem = 'Kraveo is having trouble. Please try again in a moment.\nKraveo में दिक्कत है। थोड़ी देर बाद कोशिश करें।';
      }
    });
  }

  void _clear(String key) {
    if (_errors.containsKey(key) || _problem != null) {
      setState(() {
        _errors.remove(key);
        _problem = null;
      });
    }
  }

  /// "Use my current location": explains, reads the GPS once, shows the result; the owner may carry on without it.
  Future<void> _detectLocation() async {
    if (_busy) return;
    FocusScope.of(context).unfocus();
    final fix = await showLocationDetectSheet(
      context,
      services: LocationScope.of(context),
      title: 'Use my current location',
      hindiTitle: 'मेरी मौजूदा लोकेशन',
      skipLabel: 'Continue without',
      skipSublabel: 'बिना लोकेशन के आगे बढ़ें',
    );
    if (fix != null && mounted) setState(() => _fix = fix);
  }

  Widget _locationBlock(KraveoTokens k) {
    final fix = _fix;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (fix == null)
        KButton(
          key: const ValueKey('signup-location-button'),
          label: 'Use my current location',
          sublabel: 'मेरी मौजूदा लोकेशन',
          icon: LucideIcons.crosshair,
          kind: KButtonKind.tonal,
          expand: true,
          onPressed: _busy ? null : _detectLocation,
        )
      else
        Container(
          key: const ValueKey('signup-location-chip'),
          padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
          decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.lg)),
          child: Row(children: [
            Icon(LucideIcons.circleCheck, size: 24, color: k.brand),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Location captured (${formatAccuracy(fix.accuracyM)})', style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16, fontWeight: FontWeight.w800)),
                Text('लोकेशन मिल गई', style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
              ]),
            ),
            SizedBox(
              width: 124,
              child: KButton(
                key: const ValueKey('signup-location-change'),
                label: 'Change',
                sublabel: 'बदलें',
                kind: KButtonKind.ghost,
                expand: true,
                onPressed: _busy ? null : _detectLocation,
              ),
            ),
          ]),
        ),
      const SizedBox(height: 6),
      Text('Optional: riders use it to find your kitchen on the map  ·  चुनना जरूरी नहीं, राइडर इससे रसोई ढूंढते हैं',
          style: KraveoType.bodySm.copyWith(color: k.inkMuted, fontSize: 13)),
    ]);
  }

  TextStyle _fieldStyle(KraveoTokens k) => KraveoType.titleLg.copyWith(color: k.ink, fontSize: 21);

  InputDecoration _decoration({required String hint, String? errorKey, Widget? suffix, Widget? prefix}) => InputDecoration(
        hintText: hint,
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 20),
        suffixIcon: suffix,
        suffixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
        prefixIcon: prefix,
        prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
        enabledBorder: _errors.containsKey(errorKey) ? fieldErrorBorder() : null,
      );

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return Scaffold(
      backgroundColor: k.bg,
      appBar: AppBar(
        backgroundColor: k.bg,
        elevation: 0,
        scrolledUnderElevation: 0,
        leading: _editing && widget.existing?.approval == PartnerApproval.pending
            ? null
            : IconButton(
                tooltip: 'Back',
                icon: Icon(LucideIcons.arrowLeft, color: k.ink, size: 26),
                onPressed: _busy ? null : () => Navigator.of(context).maybePop(),
              ),
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(KSpace.gutter, 0, KSpace.gutter, 32),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                KReveal(
                  child: Semantics(
                    header: true,
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(_editing ? 'Update your details' : 'Create your restaurant account',
                          style: KraveoType.headline.copyWith(color: k.ink, fontSize: 28)),
                      const SizedBox(height: 4),
                      Text(_editing ? 'जानकारी सुधारें' : 'रेस्टोरेंट अकाउंट बनाएं', style: KraveoType.titleLg.copyWith(color: k.inkMuted, fontSize: 21)),
                    ]),
                  ),
                ),
                const SizedBox(height: 22),
                KReveal(
                  index: 1,
                  child: FieldBlock(
                    label: 'RESTAURANT NAME',
                    hindi: 'रेस्टोरेंट का नाम',
                    error: _errors['restaurantName'],
                    child: TextField(
                      key: const ValueKey('restaurant-field'),
                      controller: _restaurant,
                      enabled: !_busy,
                      textCapitalization: TextCapitalization.words,
                      textInputAction: TextInputAction.next,
                      style: _fieldStyle(k),
                      onChanged: (_) => _clear('restaurantName'),
                      onSubmitted: (_) => _addressFocus.requestFocus(),
                      decoration: _decoration(hint: 'Sharma Highway Dhaba', errorKey: 'restaurantName'),
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                KReveal(
                  index: 2,
                  child: FieldBlock(
                    label: 'WHERE IS THE KITCHEN?',
                    hindi: 'रसोई कहाँ है?',
                    error: _errors['address'],
                    child: TextField(
                      key: const ValueKey('address-field'),
                      controller: _address,
                      focusNode: _addressFocus,
                      enabled: !_busy,
                      textCapitalization: TextCapitalization.sentences,
                      textInputAction: TextInputAction.next,
                      style: _fieldStyle(k),
                      onChanged: (_) => _clear('address'),
                      onSubmitted: (_) => _ownerFocus.requestFocus(),
                      decoration: _decoration(hint: 'Near Gate 2, Ashta road', errorKey: 'address'),
                    ),
                  ),
                ),
                if (!_editing) ...[
                  const SizedBox(height: 10),
                  KReveal(index: 2, child: _locationBlock(k)),
                ],
                const SizedBox(height: 18),
                KReveal(
                  index: 3,
                  child: FieldBlock(
                    label: 'WHAT DO YOU SERVE?',
                    hindi: 'क्या बनाते हैं?',
                    hint: 'Optional  ·  चुनना जरूरी नहीं',
                    child: Wrap(spacing: 10, runSpacing: 10, children: [
                      for (final (en, hi) in kVendorCategories)
                        VChoiceChip(
                          key: ValueKey('category-$en'),
                          label: en,
                          sublabel: hi,
                          height: 58,
                          selected: _category == en,
                          onTap: _busy ? () {} : () => setState(() => _category = _category == en ? null : en),
                        ),
                    ]),
                  ),
                ),
                const SizedBox(height: 18),
                KReveal(
                  index: 4,
                  child: FieldBlock(
                    label: 'YOUR NAME',
                    hindi: 'आपका नाम',
                    error: _errors['name'],
                    child: TextField(
                      key: const ValueKey('owner-field'),
                      controller: _owner,
                      focusNode: _ownerFocus,
                      enabled: !_busy,
                      textCapitalization: TextCapitalization.words,
                      textInputAction: _editing ? TextInputAction.done : TextInputAction.next,
                      autofillHints: const [AutofillHints.name],
                      style: _fieldStyle(k),
                      onChanged: (_) => _clear('name'),
                      onSubmitted: (_) => _editing ? _submit() : _phoneFocus.requestFocus(),
                      decoration: _decoration(hint: 'Ramesh Sharma', errorKey: 'name'),
                    ),
                  ),
                ),
                if (!_editing) ...[
                  const SizedBox(height: 18),
                  KReveal(
                    index: 5,
                    child: FieldBlock(
                      label: 'MOBILE NUMBER',
                      hindi: 'मोबाइल नंबर',
                      hint: 'You will log in with this number  ·  इसी नंबर से लॉग इन होगा',
                      error: _errors['phone'],
                      child: TextField(
                        key: const ValueKey('phone-field'),
                        controller: _phone,
                        focusNode: _phoneFocus,
                        enabled: !_busy,
                        keyboardType: TextInputType.phone,
                        textInputAction: TextInputAction.next,
                        autofillHints: const [AutofillHints.telephoneNumberNational],
                        inputFormatters: const [IndianPhoneInputFormatter()],
                        style: KraveoType.headlineSm.copyWith(color: k.ink, letterSpacing: 1, fontSize: 24),
                        onChanged: (_) => _clear('phone'),
                        onSubmitted: (_) => _passwordFocus.requestFocus(),
                        decoration: _decoration(
                          hint: '98765 43210',
                          errorKey: 'phone',
                          prefix: Padding(
                            padding: const EdgeInsets.only(left: 18, right: 10),
                            child: Row(mainAxisSize: MainAxisSize.min, children: [
                              Text('+91', style: KraveoType.headlineSm.copyWith(color: k.inkMuted, fontSize: 24)),
                              const SizedBox(width: 10),
                              Container(width: 1.4, height: 28, color: k.line),
                            ]),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  KReveal(
                    index: 6,
                    child: FieldBlock(
                      label: 'CREATE A PASSWORD',
                      hindi: 'पासवर्ड बनाएं',
                      hint: 'At least 8 characters  ·  कम से कम 8 अक्षर',
                      error: _errors['password'],
                      child: TextField(
                        key: const ValueKey('password-field'),
                        controller: _password,
                        focusNode: _passwordFocus,
                        enabled: !_busy,
                        obscureText: !_showPassword,
                        enableSuggestions: false,
                        autocorrect: false,
                        keyboardType: TextInputType.visiblePassword,
                        textInputAction: TextInputAction.done,
                        autofillHints: const [AutofillHints.newPassword],
                        style: _fieldStyle(k),
                        onChanged: (_) => _clear('password'),
                        onSubmitted: (_) => _submit(),
                        decoration: _decoration(
                          hint: 'Choose a password',
                          errorKey: 'password',
                          suffix: Padding(
                            padding: const EdgeInsets.only(right: 6),
                            child: KPressable(
                              semanticLabel: _showPassword ? 'Hide password' : 'Show password',
                              onTap: () => setState(() => _showPassword = !_showPassword),
                              child: SizedBox(
                                width: 52,
                                height: 52,
                                child: ExcludeSemantics(child: Icon(_showPassword ? LucideIcons.eyeOff : LucideIcons.eye, size: 24, color: k.inkMuted)),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 18),
                KReveal(
                  index: 7,
                  child: _showFssai
                      ? FieldBlock(
                          label: 'FSSAI LICENCE NUMBER',
                          hindi: 'FSSAI नंबर',
                          hint: '14 digits  ·  optional, you can add it later',
                          error: _errors['fssaiNumber'],
                          child: TextField(
                            key: const ValueKey('fssai-field'),
                            controller: _fssai,
                            enabled: !_busy,
                            keyboardType: TextInputType.number,
                            style: KraveoType.headlineSm.copyWith(color: k.ink, letterSpacing: 1, fontSize: 22),
                            onChanged: (_) => _clear('fssaiNumber'),
                            decoration: _decoration(hint: '12345678901234', errorKey: 'fssaiNumber'),
                          ),
                        )
                      : KPressable(
                          semanticLabel: 'Add FSSAI licence number (optional)',
                          onTap: () => setState(() => _showFssai = true),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 10),
                            child: Row(children: [
                              Icon(LucideIcons.plus, size: 20, color: k.brand),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text('Have an FSSAI licence? Add it (optional)  ·  FSSAI नंबर जोड़ें',
                                    style: KraveoType.titleMd.copyWith(color: k.brand, fontSize: 16)),
                              ),
                            ]),
                          ),
                        ),
                ),
                AnimatedSize(
                  duration: KMotion.base,
                  curve: KMotion.emphasized,
                  alignment: Alignment.topCenter,
                  child: _problem == null
                      ? const SizedBox(width: double.infinity)
                      : Semantics(
                          liveRegion: true,
                          child: Padding(
                            padding: const EdgeInsets.only(top: 14),
                            child: Container(
                              key: const ValueKey('signup-problem'),
                              width: double.infinity,
                              padding: const EdgeInsets.all(16),
                              decoration: BoxDecoration(
                                color: Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.10), k.surface),
                                borderRadius: BorderRadius.circular(KRadius.lg),
                                border: Border.all(color: kDangerDeep, width: 1.6),
                              ),
                              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Icon(LucideIcons.triangleAlert, size: 24, color: kDangerDeep),
                                const SizedBox(width: 12),
                                Expanded(child: Text(_problem!, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16, fontWeight: FontWeight.w700))),
                              ]),
                            ),
                          ),
                        ),
                ),
                const SizedBox(height: 22),
                KReveal(
                  index: 8,
                  child: KButton(
                    key: const ValueKey('signup-button'),
                    label: _editing ? 'Send again' : 'Create account',
                    sublabel: _editing ? 'फिर से भेजें' : 'अकाउंट बनाएं',
                    icon: _editing ? LucideIcons.send : LucideIcons.userPlus,
                    large: true,
                    loading: _busy,
                    onPressed: _submit,
                  ),
                ),
                const SizedBox(height: 18),
                KReveal(
                  index: 9,
                  child: KCard(
                    color: k.brandSoft,
                    elevated: false,
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Icon(LucideIcons.shieldCheck, size: 26, color: k.brand),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text('Kraveo checks every restaurant before it can take orders.',
                              style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16)),
                          const SizedBox(height: 2),
                          Text('ऑर्डर लेने से पहले Kraveo हर रेस्टोरेंट की जाँच करता है।', style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 15)),
                        ]),
                      ),
                    ]),
                  ),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
