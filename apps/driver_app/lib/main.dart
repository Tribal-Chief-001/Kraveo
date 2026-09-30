import 'package:flutter/material.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'screens/driver_home.dart';

void main() {
  runApp(const KraveoDriverApp());
}

class KraveoDriverApp extends StatelessWidget {
  const KraveoDriverApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Kraveo Runner | Delivery App',
      debugShowCheckedModeBanner: false,
      theme: KraveoTheme.driver(),
      home: const DriverHomeScreen(),
    );
  }
}
