import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:provider/provider.dart';
import 'providers/dhaba_provider.dart';
import 'providers/cart_provider.dart';
import 'providers/order_provider.dart';
import 'services/customer_api_service.dart';
import 'screens/auth_screen.dart';
import 'screens/home_screen.dart';

void main() {
  runApp(const KraveoCustomerApp());
}

class KraveoCustomerApp extends StatelessWidget {
  const KraveoCustomerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => DhabaProvider()),
        ChangeNotifierProvider(create: (_) => CartProvider()),
        ChangeNotifierProvider(create: (_) => OrderProvider()),
      ],
      child: MaterialApp(
        title: 'Kraveo',
        debugShowCheckedModeBanner: false,
        theme: KraveoTheme.customer(),
        home: const AuthGate(),
      ),
    );
  }
}

class AuthGate extends StatefulWidget {
  const AuthGate({super.key});

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  bool _isCheckingSession = true;
  bool _isAuthenticated = false;

  @override
  void initState() {
    super.initState();
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    final profile = await CustomerApiService.fetchProfile();
    if (!mounted) return;
    setState(() {
      _isAuthenticated = profile?['role'] == 'STUDENT';
      _isCheckingSession = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_isCheckingSession) {
      return const Scaffold(
        body: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            KBrandMark(height: 72),
            SizedBox(height: 28),
            SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 3)),
          ]),
        ),
      );
    }
    if (_isAuthenticated) return const HomeScreen();
    return AuthScreen(onAuthenticated: () => setState(() => _isAuthenticated = true));
  }
}
