class ApiConfig {
  static const bool isProduction = true;

  static const String _localBaseUrl = 'http://10.0.2.2:5000/api';
  // Vercel provides the public HTTPS edge and forwards /api/* to the EC2 backend.
  // Keep Socket.IO on EC2 until a dedicated HTTPS API hostname is available;
  // Vercel rewrites are not a reliable long-lived WebSocket transport.
  static const String _productionBaseUrl = 'https://kraveo.vercel.app/api';

  static String get baseUrl => isProduction ? _productionBaseUrl : _localBaseUrl;

  static const String _localSocketUrl = 'http://10.0.2.2:5000';
  static const String _productionSocketUrl = 'http://3.110.189.80';

  static String get socketUrl => isProduction ? _productionSocketUrl : _localSocketUrl;
}
