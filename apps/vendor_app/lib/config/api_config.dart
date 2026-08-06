class ApiConfig {
  static const bool isProduction = true;

  static const String _localBaseUrl = 'http://10.0.2.2:5000/api';
  static const String _productionBaseUrl = 'https://kraveo-backend.onrender.com/api';

  static String get baseUrl => isProduction ? _productionBaseUrl : _localBaseUrl;

  static const String _localSocketUrl = 'http://10.0.2.2:5000';
  static const String _productionSocketUrl = 'https://kraveo-backend.onrender.com';

  static String get socketUrl => isProduction ? _productionSocketUrl : _localSocketUrl;
}
