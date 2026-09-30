class ApiConfig {
  static const bool isProduction = true;

  static const String _localBaseUrl = 'http://10.0.2.2:5000/api';
  // REST and Socket.IO both go through the dedicated HTTPS API hostname.
  static const String _productionBaseUrl = 'https://api.kraveo.site/api';

  static String get baseUrl => isProduction ? _productionBaseUrl : _localBaseUrl;

  static const String _localSocketUrl = 'http://10.0.2.2:5000';
  static const String _productionSocketUrl = 'https://api.kraveo.site';

  static String get socketUrl => isProduction ? _productionSocketUrl : _localSocketUrl;

  /// Optional Web OAuth client id for Google Sign-In, passed as `serverClientId`.
  /// On Android the plugin reads it from google-services.json (`default_web_client_id`), so this
  /// only needs to be set when that file has no web client:
  /// `--dart-define=GOOGLE_SERVER_CLIENT_ID=xxxx.apps.googleusercontent.com`.
  static const String googleServerClientId = String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID');
}
