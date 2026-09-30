import 'package:flutter/services.dart';

/// Digits-only formatter for a 10-digit Indian mobile field. Pasting "+91 98765 43210",
/// "919876543210" or "09876543210" keeps just the 10 subscriber digits.
class IndianPhoneInputFormatter extends TextInputFormatter {
  const IndianPhoneInputFormatter();

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final text = normalizeIndianPhone(newValue.text);
    if (text == newValue.text) return newValue;
    return TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
  }
}

/// Strips formatting and a leading country code / trunk zero, capped at 10 digits.
String normalizeIndianPhone(String raw) {
  var digits = raw.replaceAll(RegExp(r'\D'), '');
  if (digits.length > 10 && digits.startsWith('91')) {
    digits = digits.substring(2);
  } else if (digits.length > 10 && digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  return digits.length > 10 ? digits.substring(0, 10) : digits;
}

/// True for a plausible Indian mobile: 10 digits starting 6-9.
bool isValidIndianMobile(String phone) => RegExp(r'^[6-9]\d{9}$').hasMatch(phone);
