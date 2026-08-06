import 'package:flutter/material.dart';
import 'screens/vendor_home_screen.dart';

void main() {
  runApp(const KraveoVendorApp());
}

class KraveoVendorApp extends StatelessWidget {
  const KraveoVendorApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FC Night Mess | Kraveo Vendor',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        fontFamily: 'Plus Jakarta Sans',
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF00450D),
          primary: const Color(0xFF00450D),
          secondary: const Color(0xFFFDD400),
          surface: const Color(0xFFFCF9F8),
        ),
        scaffoldBackgroundColor: const Color(0xFFFCF9F8),
      ),
      home: const VendorHomeScreen(),
    );
  }
}
