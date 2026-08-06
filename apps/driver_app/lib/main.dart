import 'package:flutter/material.dart';
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
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        fontFamily: 'Plus Jakarta Sans',
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFFDD400),
          primary: const Color(0xFF00450D),
          secondary: const Color(0xFFFDD400),
          surface: const Color(0xFF151C2C),
          brightness: Brightness.dark,
        ),
        scaffoldBackgroundColor: const Color(0xFF1B1C1C),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xFF1B1C1C),
          surfaceTintColor: Colors.transparent,
        ),
      ),
      home: const DriverHomeScreen(),
    );
  }
}
