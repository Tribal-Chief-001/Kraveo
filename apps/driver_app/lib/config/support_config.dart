/// How a rider reaches Kraveo when something goes wrong on a delivery (locked code, cancelled order
/// in hand, emergency).
///
/// UNVERIFIED: this number was hard-coded in the old home screen (and the restaurant app) before the
/// order-flow work. Nobody has confirmed it is a staffed Kraveo line. Replace it with the real
/// support number before release.
class SupportConfig {
  static const String phone = '+91 98765 43214';
}
