import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
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
      theme: KraveoTheme.vendor(),
      // The vendor theme already renders type ~12% larger; cap the system font scale so
      // huge accessibility settings enlarge text without breaking the fixed 64px targets.
      builder: (context, child) => MediaQuery.withClampedTextScaling(maxScaleFactor: 1.3, child: child ?? const SizedBox.shrink()),
      home: const VendorHomeScreen(),
    );
  }
}
