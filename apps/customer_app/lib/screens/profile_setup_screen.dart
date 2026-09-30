import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:provider/provider.dart';
import '../providers/session_provider.dart';
import '../widgets/ui/display_text.dart';
import '../widgets/ui/error_line.dart';
import '../widgets/ui/hostel_pill.dart';

/// Name rule shared with the backend (2-60 characters).
const int kNameMinLength = 2;
const int kNameMaxLength = 60;

/// Returns a user-facing problem with [raw], or null when it is an acceptable name.
String? validateFullName(String raw) {
  final name = raw.trim().replaceAll(RegExp(r'\s+'), ' ');
  if (name.isEmpty) return 'Tell us your name so the runner knows who to look for.';
  if (name.length < kNameMinLength) return 'Your name needs at least $kNameMinLength letters.';
  if (name.length > kNameMaxLength) return 'Keep your name under $kNameMaxLength characters.';
  if (!RegExp(r'\p{L}', unicode: true).hasMatch(name)) return 'Your name needs at least one letter.';
  return null;
}

/// First-time setup after a new number is verified: full name + drop-off point.
/// It cannot be skipped or dismissed; the only way out is to sign out and use another number.
class ProfileSetupScreen extends StatefulWidget {
  const ProfileSetupScreen({super.key});

  @override
  State<ProfileSetupScreen> createState() => _ProfileSetupScreenState();
}

class _ProfileSetupScreenState extends State<ProfileSetupScreen> {
  late final TextEditingController _name;
  final _nameFocus = FocusNode();
  String? _hostel;
  String? _nameError;
  String? _hostelError;
  String? _formError;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final session = context.read<SessionProvider>();
    _name = TextEditingController(text: session.user?.name ?? '');
    _hostel = session.hostel;
  }

  @override
  void dispose() {
    _name.dispose();
    _nameFocus.dispose();
    super.dispose();
  }

  Future<void> _pickHostel() async {
    FocusScope.of(context).unfocus();
    final picked = await showHostelPicker(context, blocks: kHostelBlocks, selected: _hostel ?? '');
    if (picked != null && mounted) {
      setState(() {
        _hostel = picked;
        _hostelError = null;
        _formError = null;
      });
    }
  }

  Future<void> _submit() async {
    if (_saving) return;
    FocusScope.of(context).unfocus();
    final nameProblem = validateFullName(_name.text);
    final hostelProblem = _hostel == null ? 'Choose where we should deliver.' : null;
    if (nameProblem != null || hostelProblem != null) {
      setState(() {
        _nameError = nameProblem;
        _hostelError = hostelProblem;
        _formError = null;
      });
      if (nameProblem != null) _nameFocus.requestFocus();
      return;
    }

    setState(() {
      _saving = true;
      _formError = null;
    });
    final session = context.read<SessionProvider>();
    final result = await session.saveProfile(name: _name.text.trim().replaceAll(RegExp(r'\s+'), ' '), hostelBlock: _hostel!);
    if (!mounted || result.success) return; // success: AuthGate swaps this screen for Home
    setState(() {
      _saving = false;
      final msg = result.networkError ? 'We couldn\'t reach Kraveo. Check your connection and try again.' : (result.message ?? 'We couldn\'t save your details. Please try again.');
      if (result.field == 'name') {
        _nameError = msg;
      } else if (result.field == 'hostelBlock') {
        _hostelError = msg;
      } else {
        _formError = msg;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final session = context.read<SessionProvider>();
    return PopScope(
      canPop: false,
      child: Scaffold(
        backgroundColor: k.bg,
        body: Stack(children: [
          Positioned(
            top: -90,
            right: -70,
            child: Container(width: 260, height: 260, decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle)),
          ),
          SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(KSpace.gutter, 16, KSpace.gutter, 24),
                keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 460),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const KReveal(child: Align(alignment: Alignment.centerLeft, child: KBrandMark(height: 46))),
                    const SizedBox(height: 28),
                    KReveal(index: 1, child: KDisplayText('Almost there', style: KraveoType.displayMd.copyWith(color: k.ink))),
                    const SizedBox(height: 12),
                    KReveal(
                      index: 2,
                      child: Text('Your name and drop-off point help the runner find you at the gate.', style: KraveoType.body.copyWith(color: k.inkMuted)),
                    ),
                    const SizedBox(height: 28),
                    KReveal(index: 3, child: _nameField(context)),
                    const SizedBox(height: 22),
                    KReveal(index: 4, child: _hostelField(context)),
                    if (_formError != null) KErrorLine(message: _formError),
                    const SizedBox(height: 28),
                    KReveal(
                      index: 5,
                      child: KButton(label: 'Continue', icon: LucideIcons.arrowRight, large: true, loading: _saving, onPressed: _submit),
                    ),
                    const SizedBox(height: 8),
                    Center(
                      child: KPressable(
                        onTap: _saving ? null : session.logout,
                        semanticLabel: 'Use a different phone number',
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 8),
                          child: Text('Use a different number', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13)),
                        ),
                      ),
                    ),
                  ]),
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }

  Widget _nameField(BuildContext context) {
    final k = context.k;
    final hasError = _nameError != null;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('FULL NAME', style: KraveoType.label.copyWith(color: k.inkMuted)),
      const SizedBox(height: 8),
      TextField(
        key: const ValueKey('name-field'),
        controller: _name,
        focusNode: _nameFocus,
        enabled: !_saving,
        textCapitalization: TextCapitalization.words,
        textInputAction: TextInputAction.next,
        keyboardType: TextInputType.name,
        autofillHints: const [AutofillHints.name],
        inputFormatters: [LengthLimitingTextInputFormatter(kNameMaxLength)],
        style: KraveoType.titleLg.copyWith(color: k.ink),
        onChanged: (_) {
          if (_nameError != null || _formError != null) setState(() => _nameError = _formError = null);
        },
        onSubmitted: (_) => _pickHostel(),
        decoration: InputDecoration(
          hintText: 'e.g. Aarav Sharma',
          prefixIcon: Icon(LucideIcons.user, size: 20, color: k.inkMuted),
          enabledBorder: hasError ? OutlineInputBorder(borderRadius: KRadius.control, borderSide: const BorderSide(color: KraveoPalette.danger, width: 1.6)) : null,
        ),
      ),
      KErrorLine(message: _nameError),
    ]);
  }

  Widget _hostelField(BuildContext context) {
    final k = context.k;
    final hasError = _hostelError != null;
    final chosen = _hostel;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('DROP-OFF POINT', style: KraveoType.label.copyWith(color: k.inkMuted)),
      const SizedBox(height: 8),
      KPressable(
        onTap: _saving ? null : _pickHostel,
        semanticLabel: chosen == null ? 'Choose your hostel or gate' : 'Drop-off point $chosen. Change',
        child: AnimatedContainer(
          duration: KMotion.base,
          padding: const EdgeInsets.fromLTRB(14, 12, 16, 12),
          decoration: BoxDecoration(
            color: k.surface,
            borderRadius: KRadius.control,
            border: Border.all(color: hasError ? KraveoPalette.danger : (chosen == null ? k.line : k.brand.withValues(alpha: 0.5)), width: hasError ? 1.6 : 1.2),
          ),
          child: Row(children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
              child: Icon(LucideIcons.mapPin, size: 20, color: k.brand),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                chosen ?? 'Choose your hostel or gate',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: chosen == null ? KraveoType.body.copyWith(color: k.inkFaint) : KraveoType.titleLg.copyWith(color: k.ink),
              ),
            ),
            Icon(LucideIcons.chevronDown, size: 20, color: k.inkMuted),
          ]),
        ),
      ),
      KErrorLine(message: _hostelError),
    ]);
  }
}
