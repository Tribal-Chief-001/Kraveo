import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:provider/provider.dart';
import '../../models/auth_results.dart';
import '../../providers/session_provider.dart';
import '../../screens/profile_setup_screen.dart' show kNameMaxLength, validateFullName;
import 'error_line.dart';
import 'phone_input.dart';
import 'sheet_chrome.dart';

/// Sentence for a failed PUT /auth/profile that is not a field error.
String profileSaveFailure(ProfileResult r, {String fallback = 'We couldn\'t save that. Please try again.'}) {
  if (r.networkError) return 'We couldn\'t reach Kraveo. Check your connection and try again.';
  return r.message ?? fallback;
}

/// Bottom sheet to change the avatar. Saves with one PUT and closes on success.
Future<void> showAvatarSheet(BuildContext context) => showKSheet<void>(context, builder: (_) => const AvatarSheet());

class AvatarSheet extends StatefulWidget {
  const AvatarSheet({super.key});

  @override
  State<AvatarSheet> createState() => _AvatarSheetState();
}

class _AvatarSheetState extends State<AvatarSheet> {
  late int? _selected = context.read<SessionProvider>().user?.avatarId;
  late final int? _original = _selected;
  bool _busy = false;
  String? _error;

  Future<void> _save() async {
    final id = _selected;
    if (id == null || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    final result = await context.read<SessionProvider>().saveProfile(avatarId: id);
    if (!mounted) return;
    if (result.success) {
      navigator.pop();
      return;
    }
    if (result.unauthorized) return; // AuthGate is already showing login
    setState(() {
      _busy = false;
      _error = profileSaveFailure(result);
    });
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_busy,
      child: KSheetFrame(
        title: 'Choose your avatar',
        onClose: _busy ? () {} : null,
        footer: Column(mainAxisSize: MainAxisSize.min, children: [
          if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: SizedBox(width: double.infinity, child: KErrorLine(message: _error))),
          KButton(label: 'Save', loading: _busy, onPressed: _selected == null || _selected == _original ? null : _save),
        ]),
        children: [
          Center(child: KAvatar(id: _selected, size: 84, ring: _selected != null)),
          const SizedBox(height: 18),
          IgnorePointer(ignoring: _busy, child: KAvatarPicker(selectedId: _selected, onChanged: (id) => setState(() => _selected = id))),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

/// Bottom sheet to edit the name and mobile number. Sends only what changed.
Future<void> showDetailsSheet(BuildContext context) => showKSheet<void>(context, builder: (_) => const DetailsSheet());

class DetailsSheet extends StatefulWidget {
  const DetailsSheet({super.key});

  @override
  State<DetailsSheet> createState() => _DetailsSheetState();
}

class _DetailsSheetState extends State<DetailsSheet> {
  late final String _origName;
  late final String _origPhone;
  late final TextEditingController _name;
  late final TextEditingController _phone;
  bool _busy = false;
  String? _nameError;
  String? _phoneError;
  String? _formError;

  @override
  void initState() {
    super.initState();
    final user = context.read<SessionProvider>().user;
    _origName = user?.name ?? '';
    _origPhone = normalizeIndianPhone(user?.phone ?? '');
    _name = TextEditingController(text: _origName);
    _phone = TextEditingController(text: _origPhone);
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  String get _cleanName => _name.text.trim().replaceAll(RegExp(r'\s+'), ' ');
  String get _digits => normalizeIndianPhone(_phone.text);
  bool get _changed => _cleanName != _origName || _digits != _origPhone;

  Future<void> _save() async {
    if (_busy) return;
    final nameProblem = validateFullName(_name.text);
    final phoneProblem = validateIndianMobile(_digits);
    if (nameProblem != null || phoneProblem != null) {
      setState(() {
        _nameError = nameProblem;
        _phoneError = phoneProblem;
      });
      return;
    }
    setState(() {
      _busy = true;
      _formError = null;
    });
    final navigator = Navigator.of(context);
    final result = await context.read<SessionProvider>().saveProfile(
          name: _cleanName != _origName ? _cleanName : null,
          phone: _digits != _origPhone ? _digits : null,
        );
    if (!mounted) return;
    if (result.success) {
      navigator.pop();
      return;
    }
    if (result.unauthorized) return;
    setState(() {
      _busy = false;
      final msg = profileSaveFailure(result);
      if (result.field == 'name') {
        _nameError = msg;
      } else if (result.field == 'phone') {
        _phoneError = msg;
      } else {
        _formError = msg;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    return PopScope(
      canPop: !_busy,
      child: KSheetFrame(
        title: 'Your details',
        onClose: _busy ? () {} : null,
        footer: Column(mainAxisSize: MainAxisSize.min, children: [
          if (_formError != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: SizedBox(width: double.infinity, child: KErrorLine(message: _formError))),
          KButton(label: 'Save', loading: _busy, onPressed: _changed ? _save : null),
        ]),
        children: [
          Text('FULL NAME', style: KraveoType.label.copyWith(color: k.inkMuted)),
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('edit-name-field'),
            controller: _name,
            enabled: !_busy,
            textCapitalization: TextCapitalization.words,
            textInputAction: TextInputAction.next,
            inputFormatters: [LengthLimitingTextInputFormatter(kNameMaxLength)],
            style: KraveoType.titleLg.copyWith(color: k.ink),
            onChanged: (_) => setState(() => _nameError = _formError = null),
          ),
          KErrorLine(message: _nameError),
          const SizedBox(height: 18),
          Text('MOBILE NUMBER', style: KraveoType.label.copyWith(color: k.inkMuted)),
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('edit-phone-field'),
            controller: _phone,
            enabled: !_busy,
            keyboardType: TextInputType.phone,
            textInputAction: TextInputAction.done,
            inputFormatters: const [IndianPhoneInputFormatter()],
            style: KraveoType.titleLg.copyWith(color: k.ink, letterSpacing: 1),
            onChanged: (_) => setState(() => _phoneError = _formError = null),
            onSubmitted: (_) => _changed ? _save() : null,
            decoration: InputDecoration(
              hintText: '98765 43210',
              prefixIcon: Padding(
                padding: const EdgeInsets.only(left: 18, right: 10),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text('+91', style: KraveoType.titleLg.copyWith(color: k.inkMuted)),
                  const SizedBox(width: 10),
                  Container(width: 1.4, height: 24, color: k.line),
                ]),
              ),
              prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
            ),
          ),
          KErrorLine(message: _phoneError),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
