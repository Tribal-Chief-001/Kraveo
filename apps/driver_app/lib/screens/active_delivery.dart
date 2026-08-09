import 'package:flutter/material.dart';
import '../widgets/pipeline_stepper.dart';
import '../widgets/gate_otp_dialog.dart';
import '../services/driver_api_service.dart';

class ActiveDeliveryScreen extends StatefulWidget {
  final int currentStep;
  final ValueChanged<int> onStepChanged;
  final VoidCallback onCompleted;
  final VoidCallback? onCancel;

  const ActiveDeliveryScreen({
    super.key,
    required this.currentStep,
    required this.onStepChanged,
    required this.onCompleted,
    this.onCancel,
  });

  @override
  State<ActiveDeliveryScreen> createState() => _ActiveDeliveryScreenState();
}

class _ActiveDeliveryScreenState extends State<ActiveDeliveryScreen> {
  final String orderId = '#ord-8492';
  final String customerName = 'Aman Sharma';
  final String customerPhone = '+91 98765 43210';
  final String dhabaName = 'FC Night Mess';
  final String hostelGate = 'Boys Hostel Block 1 (Gate 2)';

  void _callCustomer() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF151C2C),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Row(
          children: [
            const Icon(Icons.phone_in_talk, color: Color(0xFF91D78A)),
            const SizedBox(width: 10),
            Text('Call $customerName',
                style: const TextStyle(color: Colors.white, fontSize: 18)),
          ],
        ),
        content: Text(
          'Dialing $customerPhone...\nMake sure to coordinate exact pickup/handshake gate.',
          style: const TextStyle(color: Colors.grey),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('End Call', style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );
  }

  void _openMapRoute() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Opening Navigation Route to Campus Gate...'),
        backgroundColor: Color(0xFF00450D),
        duration: Duration(seconds: 2),
      ),
    );
  }

  void _triggerGateOtp() {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => GateOtpDialog(
        orderId: orderId,
        customerName: customerName,
        gateName: hostelGate,
        expectedOtp: '4829',
        onVerified: () {
          widget.onCompleted();
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    const gold = Color(0xFFFDD400);
    const emerald = Color(0xFF00450D);
    const emeraldLight = Color(0xFF91D78A);
    const darkBg = Color(0xFF1B1C1C);
    const darkSurface = Color(0xFF151C2C);

    return Scaffold(
      backgroundColor: darkBg,
      appBar: AppBar(
        backgroundColor: darkBg,
        elevation: 0,
        title: const Row(
          children: [
            Icon(Icons.navigation, color: emeraldLight, size: 22),
            SizedBox(width: 8),
            Text(
              'Active Delivery Console',
              style: TextStyle(
                fontWeight: FontWeight.w900,
                fontSize: 18,
                color: Colors.white,
              ),
            ),
          ],
        ),
        actions: [
          Container(
            margin: const EdgeInsets.only(right: 16),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: gold,
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Text(
              'EARN ₹40',
              style: TextStyle(
                color: Colors.black,
                fontWeight: FontWeight.w900,
                fontSize: 12,
              ),
            ),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Active Order Summary Card
            Container(
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(
                color: darkSurface,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: Colors.white10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'ORDER $orderId',
                        style: const TextStyle(
                          color: gold,
                          fontWeight: FontWeight.w900,
                          fontSize: 16,
                          letterSpacing: 0.8,
                        ),
                      ),
                      Row(
                        children: [
                          const Icon(Icons.timer_outlined,
                              color: Colors.grey, size: 14),
                          const SizedBox(width: 4),
                          const Text(
                            '12 mins ETA',
                            style: TextStyle(
                              color: Colors.grey,
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            customerName,
                            style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.bold,
                              fontSize: 16,
                            ),
                          ),
                          Text(
                            customerPhone,
                            style: const TextStyle(
                              color: Colors.grey,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                      OutlinedButton.icon(
                        onPressed: _callCustomer,
                        icon: const Icon(Icons.phone, color: emeraldLight, size: 18),
                        label: const Text(
                          'CALL',
                          style: TextStyle(
                            color: emeraldLight,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        style: OutlinedButton.styleFrom(
                          side: const BorderSide(color: emeraldLight),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(16),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),

            const SizedBox(height: 20),

            // 4-Step Pipeline Stepper Widget
            const Text(
              'Delivery Guidance Pipeline',
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
                fontSize: 16,
              ),
            ),
            const SizedBox(height: 12),

            PipelineStepper(
              currentStep: widget.currentStep,
              onStepTapped: (step) => widget.onStepChanged(step),
            ),

            const SizedBox(height: 20),

            // Action Panel for Current Step
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: darkSurface,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: emerald.withValues(alpha: 0.6), width: 1.5),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.touch_app, color: gold, size: 20),
                      const SizedBox(width: 8),
                      Text(
                        'STEP ${widget.currentStep + 1} ACTION',
                        style: const TextStyle(
                          color: gold,
                          fontWeight: FontWeight.w900,
                          fontSize: 13,
                          letterSpacing: 1.0,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),

                  if (widget.currentStep == 0) ...[
                    const Text(
                      'Navigate to FC Night Mess to collect package.',
                      style: TextStyle(color: Colors.white, fontSize: 14),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Expanded(
                          child: ElevatedButton.icon(
                            onPressed: _openMapRoute,
                            icon: const Icon(Icons.map, color: Colors.black),
                            label: const Text('OPEN MAP ROUTE'),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: gold,
                              foregroundColor: Colors.black,
                              padding: const EdgeInsets.symmetric(vertical: 14),
                              shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(14)),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ] else if (widget.currentStep == 1) ...[
                    const Text(
                      'Check items at dhaba counter & verify receipt.',
                      style: TextStyle(color: Colors.white, fontSize: 14),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      '✓ 1x Butter Paneer + 2x Butter Naan',
                      style: TextStyle(color: emeraldLight, fontSize: 13),
                    ),
                    const SizedBox(height: 16),
                  ] else if (widget.currentStep == 2) ...[
                    const Text(
                      'Ride to Boys Hostel Block 1 (Gate 2 Handshake).',
                      style: TextStyle(color: Colors.white, fontSize: 14),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Expanded(
                          child: ElevatedButton.icon(
                            onPressed: _openMapRoute,
                            icon: const Icon(Icons.navigation, color: Colors.white),
                            label: const Text('NAVIGATE TO HOSTEL GATE'),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: emerald,
                              foregroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(vertical: 14),
                              shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(14)),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ] else if (widget.currentStep == 3) ...[
                    const Text(
                      'Ask student at gate for their 4-digit Handshake OTP to complete order.',
                      style: TextStyle(color: Colors.white, fontSize: 14),
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        onPressed: _triggerGateOtp,
                        icon: const Icon(Icons.pin, color: Colors.black),
                        label: const Text('ENTER GATE OTP PIN'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: gold,
                          foregroundColor: Colors.black,
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(16)),
                        ),
                      ),
                    ),
                  ],

                  const SizedBox(height: 16),

                  // Next Step / Advance Button
                  if (widget.currentStep < 3)
                    SizedBox(
                      width: double.infinity,
                      height: 52,
                      child: ElevatedButton(
                        onPressed: () {
                          widget.onStepChanged(widget.currentStep + 1);
                        },
                        style: ElevatedButton.styleFrom(
                          backgroundColor: emerald,
                          foregroundColor: Colors.white,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(16),
                          ),
                        ),
                        child: Text(
                          'PROCEED TO STEP ${widget.currentStep + 2}',
                          style: const TextStyle(
                            fontWeight: FontWeight.w900,
                            fontSize: 14,
                            letterSpacing: 0.8,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
