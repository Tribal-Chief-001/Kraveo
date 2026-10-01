import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/partner_session.dart';
import '../services/partner_auth_service.dart';
import '../widgets/ui/field_block.dart';
import '../widgets/ui/phone_input.dart';

/// Create a rider account (phone + password). With [existing] set it instead edits the details of a
/// pending or rejected application and sends them again; phone and password are not asked in that case.
class SignupScreen extends StatefulWidget {
  const SignupScreen({super.key, required this.onSubmit, this.existing});

  final Future<SignupResult> Function(PartnerSignupForm form) onSubmit;
  final PartnerSession? existing;

  @override
  State<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends State<SignupScreen> {
  late final TextEditingController _name = TextEditingController(text: widget.existing?.name ?? '');
  final _phone = TextEditingController();
  final _password = TextEditingController();
  late final TextEditingController _plate = TextEditingController(text: widget.existing?.vehicleRegNo ?? '');
  late final TextEditingController _emergency = TextEditingController(text: _digits(widget.existing?.emergencyPhone));
  late final TextEditingController _upi = TextEditingController(text: widget.existing?.upiId ?? '');

  final _phoneFocus = FocusNode();
  final _passwordFocus = FocusNode();

  late String _vehicle = kVehicleTypes.contains(widget.existing?.vehicleType) ? widget.existing!.vehicleType! : 'Bike';
  bool _showPassword = false;
  bool _showMore = false;
  bool _busy = false;
  final Map<String, String> _errors = {};
  String? _problem;

  bool get _editing => widget.existing != null;

  static String _digits(String? raw) {
    final d = (raw ?? '').replaceAll(RegExp(r'\D'), '');
    return d.length > 10 ? d.substring(d.length - 10) : d;
  }

  @override
  void initState() {
    super.initState();
    _showMore = _emergency.text.isNotEmpty || _upi.text.isNotEmpty;
  }

  @override
  void dispose() {
    for (final c in [_name, _phone, _password, _plate, _emergency, _upi]) {
      c.dispose();
    }
    _phoneFocus.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  Map<String, String> _validate() {
    final e = <String, String>{};
    if (_name.text.trim().length < 2) e['name'] = 'Enter your full name';
    if (!_editing) {
      if (!isValidIndianMobile(_phone.text.trim())) e['phone'] = 'Enter your 10-digit mobile number';
      if (_password.text.length < 8) e['password'] = 'Use at least 8 characters';
    }
    if (vehicleNeedsPlate(_vehicle) && _plate.text.trim().length < 4) e['vehicleRegNo'] = 'Enter the number plate of your vehicle';
    final emergency = _emergency.text.trim();
    if (emergency.isNotEmpty && !isValidIndianMobile(emergency)) e['emergencyPhone'] = 'Enter a valid 10-digit number, or leave it empty';
    if (emergency.isNotEmpty && emergency == _phone.text.trim()) e['emergencyPhone'] = 'The emergency contact must be someone else';
    final upi = _upi.text.trim();
    if (upi.isNotEmpty && !RegExp(r'^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$').hasMatch(upi)) e['upiId'] = 'That UPI id does not look right (example: name@upi)';
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
        if (errors.containsKey('emergencyPhone') || errors.containsKey('upiId')) _showMore = true;
      });
      return;
    }
    setState(() {
      _busy = true;
      _errors.clear();
      _problem = null;
    });
    final form = PartnerSignupForm(
      name: _name.text.trim(),
      phone: _phone.text.trim(),
      password: _password.text,
      vehicleType: _vehicle,
      vehicleRegNo: vehicleNeedsPlate(_vehicle) ? _plate.text.trim().toUpperCase() : '',
      emergencyPhone: _emergency.text.trim(),
      upiId: _upi.text.trim(),
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
          if (result.field != null && result.message != null) {
            _errors[result.field!] = result.message!;
            if (result.field == 'emergencyPhone' || result.field == 'upiId') _showMore = true;
          } else {
            _problem = result.message ?? 'Please check the details and try again.';
          }
        case SignupFailure.phoneTaken:
          _errors['phone'] = 'This number already has an account. Go back and log in.';
        case SignupFailure.rateLimited:
          _problem = 'Too many tries. Please try again in an hour.';
        case SignupFailure.unauthorized:
          _problem = 'Your session ended. Please log in again.';
        case SignupFailure.offline:
          _problem = 'Can\'t reach Kraveo. Check your internet and try again.';
        case SignupFailure.server:
          _problem = 'Kraveo is having trouble. Please try again in a moment.';
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

  InputDecoration _decoration({required String hint, String? errorKey, Widget? suffix, Widget? prefix}) => InputDecoration(
        hintText: hint,
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 20),
        suffixIcon: suffix,
        suffixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
        prefixIcon: prefix,
        prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
        enabledBorder: _errors.containsKey(errorKey) ? fieldErrorBorder : null,
      );

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final fieldStyle = KraveoType.titleLg.copyWith(color: k.ink, fontSize: 21);
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
                    child: Text(_editing ? 'Update your details' : 'Become a delivery partner', style: KraveoType.displayMd.copyWith(color: k.ink, fontSize: 30)),
                  ),
                ),
                const SizedBox(height: 6),
                KReveal(
                  index: 1,
                  child: Text(_editing ? 'Fix what is below and send it again.' : 'Create your account. It takes a minute.',
                      style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16)),
                ),
                const SizedBox(height: 22),
                KReveal(
                  index: 2,
                  child: FieldBlock(
                    label: 'FULL NAME',
                    error: _errors['name'],
                    child: TextField(
                      key: const ValueKey('name-field'),
                      controller: _name,
                      enabled: !_busy,
                      textCapitalization: TextCapitalization.words,
                      textInputAction: _editing ? TextInputAction.done : TextInputAction.next,
                      autofillHints: const [AutofillHints.name],
                      style: fieldStyle,
                      onChanged: (_) => _clear('name'),
                      onSubmitted: (_) => _editing ? FocusScope.of(context).unfocus() : _phoneFocus.requestFocus(),
                      decoration: _decoration(hint: 'Sunil Verma', errorKey: 'name'),
                    ),
                  ),
                ),
                if (!_editing) ...[
                  const SizedBox(height: 18),
                  KReveal(
                    index: 3,
                    child: FieldBlock(
                      label: 'MOBILE NUMBER',
                      hint: 'You will log in with this number',
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
                    index: 4,
                    child: FieldBlock(
                      label: 'CREATE A PASSWORD',
                      hint: 'At least 8 characters',
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
                        style: fieldStyle,
                        onChanged: (_) => _clear('password'),
                        onSubmitted: (_) => FocusScope.of(context).unfocus(),
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
                  index: 5,
                  child: FieldBlock(
                    label: 'HOW WILL YOU DELIVER?',
                    child: Wrap(spacing: 10, runSpacing: 10, children: [
                      for (final v in kVehicleTypes)
                        KChoiceChip(
                          key: ValueKey('vehicle-$v'),
                          label: v,
                          selected: _vehicle == v,
                          onTap: _busy
                              ? () {}
                              : () => setState(() {
                                    _vehicle = v;
                                    _errors.remove('vehicleRegNo');
                                  }),
                        ),
                    ]),
                  ),
                ),
                if (vehicleNeedsPlate(_vehicle)) ...[
                  const SizedBox(height: 18),
                  KReveal(
                    index: 6,
                    child: FieldBlock(
                      label: 'NUMBER PLATE',
                      error: _errors['vehicleRegNo'],
                      child: TextField(
                        key: const ValueKey('plate-field'),
                        controller: _plate,
                        enabled: !_busy,
                        textCapitalization: TextCapitalization.characters,
                        textInputAction: TextInputAction.done,
                        style: fieldStyle.copyWith(letterSpacing: 1),
                        onChanged: (_) => _clear('vehicleRegNo'),
                        decoration: _decoration(hint: 'MP04 AB 1234', errorKey: 'vehicleRegNo'),
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 14),
                KReveal(
                  index: 7,
                  child: _showMore
                      ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          FieldBlock(
                            label: 'EMERGENCY CONTACT',
                            hint: 'Optional. Someone we can call if there is a problem.',
                            error: _errors['emergencyPhone'],
                            child: TextField(
                              key: const ValueKey('emergency-field'),
                              controller: _emergency,
                              enabled: !_busy,
                              keyboardType: TextInputType.phone,
                              inputFormatters: const [IndianPhoneInputFormatter()],
                              style: fieldStyle,
                              onChanged: (_) => _clear('emergencyPhone'),
                              decoration: _decoration(hint: '98765 43210', errorKey: 'emergencyPhone'),
                            ),
                          ),
                          const SizedBox(height: 18),
                          FieldBlock(
                            label: 'UPI ID FOR PAYOUTS',
                            hint: 'Optional. You can add it later.',
                            error: _errors['upiId'],
                            child: TextField(
                              key: const ValueKey('upi-field'),
                              controller: _upi,
                              enabled: !_busy,
                              autocorrect: false,
                              keyboardType: TextInputType.emailAddress,
                              style: fieldStyle,
                              onChanged: (_) => _clear('upiId'),
                              decoration: _decoration(hint: 'name@upi', errorKey: 'upiId'),
                            ),
                          ),
                        ])
                      : KPressable(
                          semanticLabel: 'Add emergency contact and UPI id (optional)',
                          onTap: () => setState(() => _showMore = true),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 10),
                            child: Row(children: [
                              Icon(LucideIcons.plus, size: 20, color: k.brand),
                              const SizedBox(width: 8),
                              Expanded(child: Text('Add emergency contact and UPI id (optional)', style: KraveoType.titleMd.copyWith(color: k.brand, fontSize: 16))),
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
                                color: Color.alphaBlend(KraveoPalette.danger.withValues(alpha: 0.12), k.surface),
                                borderRadius: BorderRadius.circular(KRadius.lg),
                                border: Border.all(color: KraveoPalette.danger, width: 1.6),
                              ),
                              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                const Icon(LucideIcons.triangleAlert, size: 24, color: KraveoPalette.danger),
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
                      Icon(LucideIcons.shieldCheck, size: 24, color: k.brand),
                      const SizedBox(width: 12),
                      Expanded(child: Text('Kraveo checks every rider before the first order.', style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16))),
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
