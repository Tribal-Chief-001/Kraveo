import 'package:flutter/material.dart';
import '../services/customer_api_service.dart';
import '../theme/app_theme.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.onAuthenticated});

  final VoidCallback onAuthenticated;

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _phoneController = TextEditingController();
  final _otpController = TextEditingController();
  final _nameController = TextEditingController();
  bool _otpRequested = false;
  bool _isLoading = false;
  String? _errorMessage;

  @override
  void dispose() {
    _phoneController.dispose();
    _otpController.dispose();
    _nameController.dispose();
    super.dispose();
  }

  String get _phone => _phoneController.text.trim();

  Future<void> _requestOtp() async {
    FocusScope.of(context).unfocus();
    if (!RegExp(r'^\d{10}$').hasMatch(_phone)) {
      setState(() => _errorMessage = 'Enter your 10-digit Indian mobile number.');
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final sent = await CustomerApiService.sendOtp(_phone);
    if (!mounted) return;
    setState(() {
      _isLoading = false;
      _otpRequested = sent;
      _errorMessage = sent ? null : 'Unable to send OTP. Check your connection and try again.';
    });
  }

  Future<void> _verifyOtp() async {
    FocusScope.of(context).unfocus();
    if (!RegExp(r'^\d{4}$').hasMatch(_otpController.text.trim())) {
      setState(() => _errorMessage = 'Enter the 4-digit OTP sent to your phone.');
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final token = await CustomerApiService.verifyOtp(
      _phone,
      _otpController.text.trim(),
      name: _nameController.text.trim().isEmpty ? null : _nameController.text.trim(),
    );
    if (!mounted) return;
    setState(() => _isLoading = false);
    if (token == null) {
      setState(() => _errorMessage = 'Invalid or expired OTP. Request a new code and try again.');
      return;
    }
    widget.onAuthenticated();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.surfaceBackground,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.restaurant_menu, size: 64, color: AppTheme.primaryEmerald),
                  const SizedBox(height: 16),
                  const Text('Welcome to Kraveo', textAlign: TextAlign.center, style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: AppTheme.textDark)),
                  const SizedBox(height: 8),
                  const Text('Order from campus restaurants and track your runner live.', textAlign: TextAlign.center, style: TextStyle(color: AppTheme.textMuted)),
                  const SizedBox(height: 32),
                  TextField(
                    controller: _phoneController,
                    enabled: !_otpRequested && !_isLoading,
                    keyboardType: TextInputType.phone,
                    maxLength: 10,
                    decoration: const InputDecoration(labelText: 'Mobile number', prefixText: '+91 ', border: OutlineInputBorder()),
                  ),
                  if (_otpRequested) ...[
                    const SizedBox(height: 12),
                    TextField(
                      controller: _nameController,
                      enabled: !_isLoading,
                      textCapitalization: TextCapitalization.words,
                      decoration: const InputDecoration(labelText: 'Your name (optional)', border: OutlineInputBorder()),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _otpController,
                      enabled: !_isLoading,
                      keyboardType: TextInputType.number,
                      maxLength: 4,
                      autofocus: true,
                      decoration: const InputDecoration(labelText: '4-digit OTP', border: OutlineInputBorder()),
                    ),
                  ],
                  if (_errorMessage != null) ...[
                    const SizedBox(height: 8),
                    Text(_errorMessage!, style: const TextStyle(color: AppTheme.accentRed), textAlign: TextAlign.center),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _isLoading ? null : (_otpRequested ? _verifyOtp : _requestOtp),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      child: _isLoading ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : Text(_otpRequested ? 'VERIFY & ENTER KRAVEO' : 'SEND LOGIN OTP'),
                    ),
                  ),
                  if (_otpRequested)
                    TextButton(
                      onPressed: _isLoading ? null : () => setState(() { _otpRequested = false; _otpController.clear(); _errorMessage = null; }),
                      child: const Text('Use a different number'),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
