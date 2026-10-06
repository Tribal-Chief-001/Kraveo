/// How a rider reaches Kraveo when something goes wrong on a delivery (locked code, cancelled order
/// in hand, a question about the account).
///
/// Kraveo has no staffed phone line yet, so support is by email only. The old placeholder phone
/// number was removed on purpose: a number nobody answers is worse than none. For a real emergency
/// the rider dials the national emergency number ([emergencyNumber]).
class SupportConfig {
  static const String email = 'kraveo.contact@gmail.com';

  /// India's single emergency number (police, ambulance, fire).
  static const String emergencyNumber = '112';
}
