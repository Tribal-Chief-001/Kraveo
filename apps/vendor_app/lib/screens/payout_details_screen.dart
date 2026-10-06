import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models/payout_account.dart';
import '../services/failure_messages.dart';
import '../services/payout/payout_controller.dart';
import '../widgets/ui/choice_chip.dart';
import '../widgets/ui/field_block.dart';
import '../widgets/ui/vendor_ui.dart';

/// Keys for tests.
const Key kPayoutSavedCardKey = ValueKey('payout-saved-card');
const Key kPayoutVerifiedKey = ValueKey('payout-verified');
const Key kPayoutEditKey = ValueKey('payout-edit-button');
const Key kPayoutSaveKey = ValueKey('payout-save-button');
const Key kPayoutProblemKey = ValueKey('payout-problem');
const Key kPayoutMethodUpiKey = ValueKey('payout-method-upi');
const Key kPayoutMethodBankKey = ValueKey('payout-method-bank');
const Key kPayoutUpiFieldKey = ValueKey('payout-upi-field');
const Key kPayoutHolderFieldKey = ValueKey('payout-holder-field');
const Key kPayoutAccountFieldKey = ValueKey('payout-account-field');
const Key kPayoutConfirmFieldKey = ValueKey('payout-account-confirm-field');
const Key kPayoutIfscFieldKey = ValueKey('payout-ifsc-field');
const Key kPayoutBankFieldKey = ValueKey('payout-bank-field');
const Key kPayoutRetryKey = ValueKey('payout-retry');
const Key kPayoutCancelKey = ValueKey('payout-cancel-button');

/// Capital letters and digits only (an IFSC code), at most 11 characters.
class _IfscFormatter extends TextInputFormatter {
  const _IfscFormatter();

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final cleaned = newValue.text.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
    final text = cleaned.length > 11 ? cleaned.substring(0, 11) : cleaned;
    return TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
  }
}

/// "Payout details": where Kraveo sends this restaurant's money. UPI id or a bank account. After saving, only the masked
/// view is shown ("Account ending 7890"); the full account number is never shown again and never kept in state.
class PayoutDetailsScreen extends StatefulWidget {
  const PayoutDetailsScreen({super.key, required this.controller});

  final PayoutController controller;

  @override
  State<PayoutDetailsScreen> createState() => _PayoutDetailsScreenState();
}

class _PayoutDetailsScreenState extends State<PayoutDetailsScreen> {
  final _upi = TextEditingController();
  final _holder = TextEditingController();
  final _number = TextEditingController();
  final _confirm = TextEditingController();
  final _ifsc = TextEditingController();
  final _bank = TextEditingController();

  PayoutMethod _method = PayoutMethod.upi;
  bool _editing = false;
  final Map<String, String> _errors = {};
  FailureText? _problem;

  PayoutController get _c => widget.controller;

  @override
  void initState() {
    super.initState();
    // After the first frame: other screens (the Earnings banner) listen to the same controller, and a controller must not
    // notify while the framework is still building.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_c.loaded && !_c.loading) _c.load();
    });
  }

  @override
  void dispose() {
    for (final c in [_upi, _holder, _number, _confirm, _ifsc, _bank]) {
      c.dispose();
    }
    super.dispose();
  }

  /// "Change details": the form opens with what is saved (never the account number: it is not known here, so it is typed again).
  void _startEditing() {
    final a = _c.account;
    setState(() {
      _method = a?.method ?? PayoutMethod.upi;
      _upi.text = a?.upiId ?? '';
      _holder.text = a?.accountHolder ?? '';
      _ifsc.text = a?.ifsc ?? '';
      _bank.text = a?.bankName ?? '';
      _number.clear();
      _confirm.clear();
      _errors.clear();
      _problem = null;
      _editing = true;
    });
  }

  void _cancelEditing() {
    _wipeSecrets();
    setState(() {
      _editing = false;
      _errors.clear();
      _problem = null;
    });
  }

  /// The typed account number leaves the screen's memory as soon as it is no longer needed.
  void _wipeSecrets() {
    _number.clear();
    _confirm.clear();
  }

  void _touch(String key) {
    if (_errors.containsKey(key) || _problem != null) {
      setState(() {
        _errors.remove(key);
        if (key == 'accountNumber') _errors.remove('accountConfirm');
        _problem = null;
      });
    }
  }

  Future<void> _save() async {
    if (_c.saving) return; // a double tap sends one request
    FocusScope.of(context).unfocus();
    final form = PayoutForm(
      method: _method,
      upiId: _upi.text,
      accountHolder: _holder.text,
      accountNumber: _number.text,
      accountConfirm: _confirm.text,
      ifsc: _ifsc.text,
      bankName: _bank.text,
    );
    final errors = form.errors;
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
      _errors.clear();
      _problem = null;
    });
    final ok = await _c.save(form.build()!);
    if (!mounted) return;
    if (ok) {
      _wipeSecrets();
      setState(() => _editing = false);
      final changed = _c.lastSaved?.changed ?? true;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(changed
              ? 'Payout details saved. Kraveo will check them before the first payout.  ·  जानकारी सेव हो गई, पहले पेआउट से पहले Kraveo जाँचेगा'
              : 'These payout details were already saved.  ·  यह जानकारी पहले से सेव है'),
          duration: const Duration(seconds: 4),
        ));
    } else {
      setState(() => _problem = _c.saveProblem);
    }
  }

  TextStyle _fieldStyle(KraveoTokens k) => KraveoType.titleLg.copyWith(color: k.ink, fontSize: 21);

  InputDecoration _decoration({required String hint, String? errorKey}) => InputDecoration(
        hintText: hint,
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 20),
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
        leading: IconButton(
          tooltip: 'Back',
          icon: Icon(LucideIcons.arrowLeft, color: k.ink, size: 26),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
      ),
      body: SafeArea(
        child: ListenableBuilder(listenable: _c, builder: (context, _) => _body(context, k)),
      ),
    );
  }

  Widget _header(KraveoTokens k) => Semantics(
        header: true,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Payout details', style: KraveoType.headline.copyWith(color: k.ink, fontSize: 28)),
          const SizedBox(height: 4),
          Text('पेआउट की जानकारी', style: KraveoType.titleLg.copyWith(color: k.inkMuted, fontSize: 21)),
        ]),
      );

  Widget _body(BuildContext context, KraveoTokens k) {
    if (!_c.loaded) {
      if (_c.loadFailure == null) {
        return const Center(child: CircularProgressIndicator());
      }
      return VMaxWidth(
        child: VScrollCenter(
          child: KEmptyState(
            icon: LucideIcons.wifiOff,
            title: "Can't load payout details",
            message: _c.loadFailure!.both,
            action: KButton(key: kPayoutRetryKey, label: 'Retry', sublabel: 'फिर कोशिश करें', icon: LucideIcons.rotateCcw, large: true, loading: _c.loading, onPressed: _c.load),
          ),
        ),
      );
    }
    final account = _c.account;
    final showForm = account == null || _editing;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(KSpace.gutter, 0, KSpace.gutter, 32),
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            _header(k),
            const SizedBox(height: 18),
            if (account != null && !_editing) ...[
              _SavedCard(account: account),
              const SizedBox(height: 16),
              KButton(
                key: kPayoutEditKey,
                label: 'Change details',
                sublabel: 'जानकारी बदलें',
                icon: LucideIcons.pencil,
                kind: KButtonKind.tonal,
                large: true,
                onPressed: _startEditing,
              ),
            ],
            if (showForm) ..._form(k, account),
            const SizedBox(height: 18),
            KCard(
              color: k.brandSoft,
              elevated: false,
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(LucideIcons.shieldCheck, size: 26, color: k.brand),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Kraveo pays you here every evening for delivered orders. Your full account number is never shown again after you save it.',
                        style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16)),
                    const SizedBox(height: 2),
                    Text('Kraveo हर शाम डिलीवर हुए ऑर्डर का पैसा यहीं भेजता है। सेव करने के बाद पूरा खाता नंबर दोबारा नहीं दिखता।', style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 15)),
                  ]),
                ),
              ]),
            ),
          ]),
        ),
      ),
    );
  }

  List<Widget> _form(KraveoTokens k, PayoutAccount? account) {
    final busy = _c.saving;
    return [
      if (account != null) ...[
        const SizedBox(height: 18),
        Container(
          key: const ValueKey('payout-restart-note'),
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: KraveoPalette.warning.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(KRadius.lg),
            border: Border.all(color: KraveoPalette.warning.withValues(alpha: 0.6)),
          ),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(LucideIcons.info, size: 22, color: k.ink),
            const SizedBox(width: 10),
            Expanded(
              child: Text('Saving changed details restarts verification. Kraveo checks them again before paying.\nबदली हुई जानकारी सेव करने पर जाँच फिर से शुरू होगी।',
                  style: KraveoType.bodySm.copyWith(color: k.ink, fontSize: 15, fontWeight: FontWeight.w700)),
            ),
          ]),
        ),
      ],
      const SizedBox(height: 18),
      FieldBlock(
        label: 'HOW SHOULD WE PAY YOU?',
        hindi: 'पैसा कैसे भेजें?',
        child: Row(children: [
          Expanded(
            child: VChoiceChip(
              key: kPayoutMethodUpiKey,
              label: 'UPI',
              sublabel: 'UPI id',
              height: 58,
              selected: _method == PayoutMethod.upi,
              onTap: busy ? () {} : () => setState(() {
                    _method = PayoutMethod.upi;
                    _errors.clear();
                    _problem = null;
                  }),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: VChoiceChip(
              key: kPayoutMethodBankKey,
              label: 'Bank account',
              sublabel: 'बैंक खाता',
              height: 58,
              selected: _method == PayoutMethod.bank,
              onTap: busy ? () {} : () => setState(() {
                    _method = PayoutMethod.bank;
                    _errors.clear();
                    _problem = null;
                  }),
            ),
          ),
        ]),
      ),
      const SizedBox(height: 18),
      if (_method == PayoutMethod.upi) ..._upiFields(k, busy) else ..._bankFields(k, busy),
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
                    key: kPayoutProblemKey,
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
                      Expanded(child: Text(_problem!.both, style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 16, fontWeight: FontWeight.w700))),
                    ]),
                  ),
                ),
              ),
      ),
      const SizedBox(height: 20),
      KButton(
        key: kPayoutSaveKey,
        label: 'Save payout details',
        sublabel: 'जानकारी सेव करें',
        icon: LucideIcons.save,
        large: true,
        loading: busy,
        onPressed: _save,
      ),
      if (account != null) ...[
        const SizedBox(height: 12),
        KButton(key: kPayoutCancelKey, label: 'Cancel', sublabel: 'रद्द करें', kind: KButtonKind.ghost, large: true, onPressed: busy ? null : _cancelEditing),
      ],
    ];
  }

  List<Widget> _upiFields(KraveoTokens k, bool busy) => [
        FieldBlock(
          label: 'UPI ID',
          hindi: 'UPI आईडी',
          hint: 'For example name@okhdfcbank  ·  जैसे name@okhdfcbank',
          error: _errors['upiId'],
          child: TextField(
            key: kPayoutUpiFieldKey,
            controller: _upi,
            enabled: !busy,
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            autocorrect: false,
            enableSuggestions: false,
            inputFormatters: [FilteringTextInputFormatter.deny(RegExp(r'\s'))],
            style: _fieldStyle(k),
            onChanged: (_) => _touch('upiId'),
            decoration: _decoration(hint: 'name@okhdfcbank', errorKey: 'upiId'),
          ),
        ),
        const SizedBox(height: 18),
        FieldBlock(
          label: 'NAME ON THE UPI ACCOUNT',
          hindi: 'UPI खाते पर नाम',
          hint: 'Optional  ·  चुनना जरूरी नहीं',
          error: _errors['accountHolder'],
          child: _holderField(k, busy),
        ),
      ];

  Widget _holderField(KraveoTokens k, bool busy) => TextField(
        key: kPayoutHolderFieldKey,
        controller: _holder,
        enabled: !busy,
        textCapitalization: TextCapitalization.words,
        textInputAction: TextInputAction.next,
        style: _fieldStyle(k),
        onChanged: (_) => _touch('accountHolder'),
        decoration: _decoration(hint: 'Ramesh Sharma', errorKey: 'accountHolder'),
      );

  List<Widget> _bankFields(KraveoTokens k, bool busy) => [
        FieldBlock(label: 'ACCOUNT HOLDER NAME', hindi: 'खाताधारक का नाम', error: _errors['accountHolder'], child: _holderField(k, busy)),
        const SizedBox(height: 18),
        FieldBlock(
          label: 'ACCOUNT NUMBER',
          hindi: 'खाता नंबर',
          hint: '6 to 20 digits  ·  6 से 20 अंक',
          error: _errors['accountNumber'],
          child: TextField(
            key: kPayoutAccountFieldKey,
            controller: _number,
            enabled: !busy,
            keyboardType: TextInputType.number,
            textInputAction: TextInputAction.next,
            autocorrect: false,
            enableSuggestions: false,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(PayoutRules.accountMax)],
            style: KraveoType.headlineSm.copyWith(color: k.ink, letterSpacing: 1, fontSize: 22),
            onChanged: (_) => _touch('accountNumber'),
            decoration: _decoration(hint: '50100234567890', errorKey: 'accountNumber'),
          ),
        ),
        const SizedBox(height: 18),
        FieldBlock(
          label: 'ACCOUNT NUMBER AGAIN',
          hindi: 'खाता नंबर फिर से',
          hint: 'Type it again to be sure  ·  पक्का करने के लिए फिर से डालें',
          error: _errors['accountConfirm'],
          child: TextField(
            key: kPayoutConfirmFieldKey,
            controller: _confirm,
            enabled: !busy,
            keyboardType: TextInputType.number,
            textInputAction: TextInputAction.next,
            autocorrect: false,
            enableSuggestions: false,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(PayoutRules.accountMax)],
            style: KraveoType.headlineSm.copyWith(color: k.ink, letterSpacing: 1, fontSize: 22),
            onChanged: (_) => _touch('accountConfirm'),
            decoration: _decoration(hint: 'Same number again', errorKey: 'accountConfirm'),
          ),
        ),
        const SizedBox(height: 18),
        FieldBlock(
          label: 'IFSC CODE',
          hindi: 'IFSC कोड',
          hint: 'For example HDFC0001234  ·  जैसे HDFC0001234',
          error: _errors['ifsc'],
          child: TextField(
            key: kPayoutIfscFieldKey,
            controller: _ifsc,
            enabled: !busy,
            textCapitalization: TextCapitalization.characters,
            textInputAction: TextInputAction.next,
            autocorrect: false,
            enableSuggestions: false,
            inputFormatters: const [_IfscFormatter()],
            style: KraveoType.headlineSm.copyWith(color: k.ink, letterSpacing: 1, fontSize: 22),
            onChanged: (_) => _touch('ifsc'),
            decoration: _decoration(hint: 'HDFC0001234', errorKey: 'ifsc'),
          ),
        ),
        const SizedBox(height: 18),
        FieldBlock(
          label: 'BANK NAME',
          hindi: 'बैंक का नाम',
          hint: 'Optional  ·  चुनना जरूरी नहीं',
          error: _errors['bankName'],
          child: TextField(
            key: kPayoutBankFieldKey,
            controller: _bank,
            enabled: !busy,
            textCapitalization: TextCapitalization.words,
            textInputAction: TextInputAction.done,
            style: _fieldStyle(k),
            onChanged: (_) => _touch('bankName'),
            onSubmitted: (_) => _save(),
            decoration: _decoration(hint: 'HDFC Bank', errorKey: 'bankName'),
          ),
        ),
      ];
}

/// The saved details, masked, with whether Kraveo has verified them.
class _SavedCard extends StatelessWidget {
  const _SavedCard({required this.account});

  final PayoutAccount account;

  @override
  Widget build(BuildContext context) {
    final k = context.k;
    final isUpi = account.method == PayoutMethod.upi;
    final verified = account.verified;
    final lines = <String>[
      if (account.accountHolder != null) account.accountHolder!,
      if (!isUpi && account.ifsc != null) 'IFSC ${account.ifsc}',
      if (!isUpi && account.bankName != null) account.bankName!,
    ];
    return KCard(
      key: kPayoutSavedCardKey,
      elevated: false,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(color: k.brandSoft, shape: BoxShape.circle),
            child: Icon(isUpi ? LucideIcons.smartphone : LucideIcons.landmark, size: 24, color: k.brand),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(isUpi ? 'UPI' : 'Bank account', style: KraveoType.label.copyWith(color: k.inkMuted, fontSize: 13)),
              Text(account.destinationText, key: const ValueKey('payout-destination'), style: KraveoType.titleLg.copyWith(color: k.ink, fontWeight: FontWeight.w800)),
            ]),
          ),
        ]),
        for (final line in lines) Padding(padding: const EdgeInsets.only(top: 6), child: Text(line, style: KraveoType.body.copyWith(color: k.inkMuted, fontSize: 16))),
        const SizedBox(height: 12),
        Semantics(
          container: true,
          label: verified ? 'Verified by Kraveo' : 'Not verified yet',
          excludeSemantics: true,
          child: Container(
            key: kPayoutVerifiedKey,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: (verified ? k.brand : KraveoPalette.warning).withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(KRadius.lg),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(verified ? LucideIcons.badgeCheck : LucideIcons.clock, size: 20, color: verified ? k.brand : k.ink),
              const SizedBox(width: 8),
              Flexible(
                child: Text(verified ? 'Verified by Kraveo  ·  Kraveo ने जाँच लिया' : 'Not verified yet  ·  अभी जाँच बाकी है',
                    style: KraveoType.titleMd.copyWith(color: k.ink, fontSize: 15, fontWeight: FontWeight.w800)),
              ),
            ]),
          ),
        ),
      ]),
    );
  }
}
