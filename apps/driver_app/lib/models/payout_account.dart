/// Where this rider gets paid (Docs/21 section 5): `GET/PUT /api/partner/payout-account`.
///
/// The server only ever sends the MASKED view (`accountLast4`, never the full account number), and the app never keeps
/// the full number either: it lives in a text field until the save succeeds and is cleared right after.
enum PayoutMethod {
  upi,
  bank;

  String get wire => this == PayoutMethod.upi ? 'UPI' : 'BANK';

  static PayoutMethod? parse(Object? raw) => switch (raw?.toString().trim().toUpperCase()) {
        'UPI' => PayoutMethod.upi,
        'BANK' => PayoutMethod.bank,
        _ => null,
      };
}

class PayoutAccount {
  const PayoutAccount({
    required this.method,
    this.upiId,
    this.accountHolder,
    this.accountLast4,
    this.ifsc,
    this.bankName,
    this.verifiedAt,
    this.updatedAt,
  });

  final PayoutMethod method;
  final String? upiId;
  final String? accountHolder;

  /// The only part of a bank account number the app ever knows.
  final String? accountLast4;
  final String? ifsc;
  final String? bankName;

  /// Set by Kraveo when it has checked the details. Saving different details clears it on the server.
  final DateTime? verifiedAt;
  final DateTime? updatedAt;

  bool get verified => verifiedAt != null;

  /// "UPI ram@okhdfcbank" or "Account ending 7890": what the saved-details card shows. Never a full number.
  String get destinationText {
    if (method == PayoutMethod.upi) return upiId ?? '';
    final last4 = accountLast4 ?? '';
    return last4.isEmpty ? 'Bank account' : 'Account ending $last4';
  }

  /// Reads the `data` object of the server answer. Null when it is not a readable account (no known method).
  static PayoutAccount? fromJson(Object? json) {
    if (json is! Map) return null;
    final method = PayoutMethod.parse(json['method']);
    if (method == null) return null;
    String? text(String key) {
      final v = json[key];
      if (v is! String) return null;
      final t = v.trim();
      return t.isEmpty ? null : t;
    }

    final last4 = text('accountLast4');
    return PayoutAccount(
      method: method,
      upiId: text('upiId'),
      accountHolder: text('accountHolder'),
      // Whatever the server sends, only the last four digits are ever kept.
      accountLast4: last4 == null ? null : (last4.length > 4 ? last4.substring(last4.length - 4) : last4),
      ifsc: text('ifsc'),
      bankName: text('bankName'),
      verifiedAt: json['verifiedAt'] is String ? DateTime.tryParse(json['verifiedAt'] as String) : null,
      updatedAt: json['updatedAt'] is String ? DateTime.tryParse(json['updatedAt'] as String) : null,
    );
  }
}

/// What the owner typed, already cleaned, ready to send. Built only by [PayoutForm.build] after validation.
class PayoutInput {
  const PayoutInput.upi({required String this.upiId, this.accountHolder})
      : method = PayoutMethod.upi,
        accountNumber = null,
        ifsc = null,
        bankName = null;

  const PayoutInput.bank({required String this.accountHolder, required String this.accountNumber, required String this.ifsc, this.bankName})
      : method = PayoutMethod.bank,
        upiId = null;

  final PayoutMethod method;
  final String? upiId;
  final String? accountHolder;
  final String? accountNumber;
  final String? ifsc;
  final String? bankName;

  /// The request body of `PUT /partner/payout-account` (the server refuses fields of the other method).
  Map<String, dynamic> toJson() => method == PayoutMethod.upi
      ? {'method': 'UPI', 'upiId': upiId, if (accountHolder != null) 'accountHolder': accountHolder}
      : {'method': 'BANK', 'accountHolder': accountHolder, 'accountNumber': accountNumber, 'ifsc': ifsc, if (bankName != null) 'bankName': bankName};

  // The full account number must never reach a log or a crash report.
  @override
  String toString() => 'PayoutInput(${method.wire})';
}

/// The answer of a save: the masked account the server stored and whether anything changed (saving the same details
/// again changes nothing, so a verified account stays verified).
class SavedPayout {
  const SavedPayout({required this.account, required this.changed, this.message});
  final PayoutAccount account;
  final bool changed;
  final String? message;
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation: the same rules as the server (backend/src/services/payoutAccount.ts), so a typo is caught before sending.
// ---------------------------------------------------------------------------------------------------------------------

final RegExp _upiRe = RegExp(r'^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,31}$');
final RegExp _ifscRe = RegExp(r'^[A-Z]{4}0[A-Z0-9]{6}$');
final RegExp _accountRe = RegExp(r'^\d{6,20}$');
final RegExp _holderRe = RegExp(r"^[\p{L}][\p{L}\p{M}\s.'-]*$", unicode: true);

String _squash(String s) => s.trim().replaceAll(RegExp(r'\s+'), ' ');

/// Field checks. Every method returns null when the value is fine, else a short English line and its Hindi twin.
abstract final class PayoutRules {
  static const int accountMin = 6;
  static const int accountMax = 20;

  /// Lower-cased and trimmed, as the server stores it.
  static String normalizeUpi(String raw) => raw.trim().toLowerCase();

  /// Upper-cased and trimmed.
  static String normalizeIfsc(String raw) => raw.trim().toUpperCase();

  /// Digits only (spaces and dashes pasted from a bank statement are dropped).
  static String normalizeAccount(String raw) => raw.replaceAll(RegExp(r'[\s-]'), '');

  static String? upiId(String raw) {
    final v = normalizeUpi(raw);
    if (v.isEmpty) return 'Enter your UPI id, for example name@okhdfcbank';
    if (!_upiRe.hasMatch(v)) return 'That does not look like a UPI id (example: name@okhdfcbank)';
    return null;
  }

  /// [required] for a bank account; optional for UPI.
  static String? holder(String raw, {required bool required}) {
    final v = _squash(raw);
    if (v.isEmpty) return required ? 'Enter the account holder name (2 to 80 letters)' : null;
    if (v.length < 2 || v.length > 80) return 'Name must be 2 to 80 characters';
    if (!_holderRe.hasMatch(v)) return "Use letters, spaces and . ' - only";
    return null;
  }

  static String? accountNumber(String raw) {
    final v = normalizeAccount(raw);
    if (v.isEmpty) return 'Enter the account number';
    if (!_accountRe.hasMatch(v)) return 'Account number must be $accountMin to $accountMax digits';
    return null;
  }

  static String? accountConfirm(String number, String again) {
    if (normalizeAccount(again).isEmpty) return 'Enter the account number again to confirm';
    if (normalizeAccount(number) != normalizeAccount(again)) return 'The two account numbers do not match';
    return null;
  }

  static String? ifsc(String raw) {
    final v = normalizeIfsc(raw);
    if (v.isEmpty) return 'Enter the IFSC code, for example HDFC0001234';
    if (!_ifscRe.hasMatch(v)) return 'IFSC is 4 letters, then 0, then 6 letters or digits';
    return null;
  }

  static String? bankName(String raw) {
    final v = _squash(raw);
    if (v.isEmpty) return null;
    if (v.length < 2 || v.length > 60) return 'Bank name must be 2 to 60 characters';
    return null;
  }
}

/// A whole form's worth of checks. [errors] is keyed by field (`upiId`, `accountHolder`, `accountNumber`,
/// `accountConfirm`, `ifsc`, `bankName`); an empty map means [input] is ready to send.
class PayoutForm {
  const PayoutForm({
    required this.method,
    this.upiId = '',
    this.accountHolder = '',
    this.accountNumber = '',
    this.accountConfirm = '',
    this.ifsc = '',
    this.bankName = '',
  });

  final PayoutMethod method;
  final String upiId;
  final String accountHolder;
  final String accountNumber;
  final String accountConfirm;
  final String ifsc;
  final String bankName;

  Map<String, String> get errors {
    final e = <String, String>{};
    void add(String key, String? problem) {
      if (problem != null) e[key] = problem;
    }

    if (method == PayoutMethod.upi) {
      add('upiId', PayoutRules.upiId(upiId));
      add('accountHolder', PayoutRules.holder(accountHolder, required: false));
    } else {
      add('accountHolder', PayoutRules.holder(accountHolder, required: true));
      add('accountNumber', PayoutRules.accountNumber(accountNumber));
      if (!e.containsKey('accountNumber')) add('accountConfirm', PayoutRules.accountConfirm(accountNumber, accountConfirm));
      add('ifsc', PayoutRules.ifsc(ifsc));
      add('bankName', PayoutRules.bankName(bankName));
    }
    return e;
  }

  /// The cleaned request, or null while [errors] is not empty.
  PayoutInput? build() {
    if (errors.isNotEmpty) return null;
    final holder = _squash(accountHolder);
    if (method == PayoutMethod.upi) {
      return PayoutInput.upi(upiId: PayoutRules.normalizeUpi(upiId), accountHolder: holder.isEmpty ? null : holder);
    }
    final bank = _squash(bankName);
    return PayoutInput.bank(
      accountHolder: holder,
      accountNumber: PayoutRules.normalizeAccount(accountNumber),
      ifsc: PayoutRules.normalizeIfsc(ifsc),
      bankName: bank.isEmpty ? null : bank,
    );
  }
}
