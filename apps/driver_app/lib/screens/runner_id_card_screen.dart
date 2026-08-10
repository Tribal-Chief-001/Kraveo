import 'package:flutter/material.dart';

class RunnerIdCardScreen extends StatelessWidget {
  const RunnerIdCardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF1B1C1C),
      appBar: AppBar(
        backgroundColor: const Color(0xFF151C2C),
        elevation: 0,
        title: const Text(
          'CAMPUS RUNNER PASS & ID',
          style: TextStyle(
            fontWeight: FontWeight.w800,
            fontSize: 15,
            letterSpacing: 0.8,
            color: Colors.white,
          ),
        ),
        centerTitle: true,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          children: [
            // Security Badge Card
            Container(
              decoration: BoxDecoration(
                color: const Color(0xFF151C2C),
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: const Color(0xFFFDD400).withValues(alpha: 0.4), width: 1.5),
                boxShadow: [
                  BoxShadow(
                    color: const Color(0xFFFDD400).withValues(alpha: 0.1),
                    blurRadius: 20,
                    spreadRadius: 2,
                  ),
                ],
              ),
              child: Column(
                children: [
                  // Top Banner
                  Container(
                    padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 20),
                    decoration: const BoxDecoration(
                      color: Color(0xFF00450D),
                      borderRadius: BorderRadius.only(
                        topLeft: Radius.circular(22),
                        topRight: Radius.circular(22),
                      ),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Row(
                          children: [
                            Icon(Icons.verified_user, color: Color(0xFFFDD400), size: 20),
                            SizedBox(width: 8),
                            Text(
                              'OFFICIAL KRAVEO PASS',
                              style: TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.w800,
                                fontSize: 13,
                                letterSpacing: 0.5,
                              ),
                            ),
                          ],
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(
                            color: const Color(0xFFFDD400),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: const Text(
                            'ACTIVE',
                            style: TextStyle(
                              color: Color(0xFF1B1C1C),
                              fontWeight: FontWeight.w900,
                              fontSize: 10,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),

                  Padding(
                    padding: const EdgeInsets.all(20.0),
                    child: Column(
                      children: [
                        // Avatar Photo
                        Stack(
                          alignment: Alignment.bottomRight,
                          children: [
                            Container(
                              width: 96,
                              height: 96,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                border: Border.all(color: const Color(0xFFFDD400), width: 3),
                                image: const DecorationImage(
                                  image: NetworkImage(
                                    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop&q=80',
                                  ),
                                  fit: BoxFit.cover,
                                ),
                              ),
                            ),
                            Container(
                              padding: const EdgeInsets.all(4),
                              decoration: const BoxDecoration(
                                color: Color(0xFF00450D),
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(Icons.check, color: Color(0xFFFDD400), size: 16),
                            ),
                          ],
                        ),

                        const SizedBox(height: 14),

                        // Name & Reg No
                        const Text(
                          'Vikram Singh',
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 22,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 4),
                        const Text(
                          'Govt ID: Aadhar Verified',
                          style: TextStyle(
                            color: Color(0xFFFDD400),
                            fontSize: 13,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 0.5,
                          ),
                        ),

                        const SizedBox(height: 16),
                        const Divider(color: Color(0xFF242F46)),

                        // ID Details Grid
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 10.0),
                          child: Column(
                            children: [
                              _buildDetailRow(Icons.badge, 'Runner ID', 'RUN-8042'),
                              const SizedBox(height: 12),
                              _buildDetailRow(Icons.two_wheeler, 'Vehicle Info', 'TVS Jupiter (MP 04 AB 1234)'),
                              const SizedBox(height: 12),
                              _buildDetailRow(Icons.phone, 'Emergency Contact', '+91 98989 12345'),
                              const SizedBox(height: 12),
                              _buildDetailRow(Icons.location_on, 'Campus Gate Access', 'All Hostel Blocks (1-6 & Girls Gate)'),
                            ],
                          ),
                        ),

                        const Divider(color: Color(0xFF242F46)),
                        const SizedBox(height: 14),

                        // Gate Verification QR Code Simulator
                        Container(
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(16),
                          ),
                          child: const Column(
                            children: [
                              Icon(Icons.qr_code_2, size: 140, color: Color(0xFF1B1C1C)),
                              SizedBox(height: 6),
                              Text(
                                'SCAN FOR SECURITY GATE VERIFICATION',
                                style: TextStyle(
                                  color: Color(0xFF1B1C1C),
                                  fontSize: 10,
                                  fontWeight: FontWeight.w900,
                                  letterSpacing: 0.5,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'Show this Pass to Hostel Gate Security Guards upon entry.',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Colors.grey.shade400,
                fontSize: 12,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDetailRow(IconData icon, String label, String value) {
    return Row(
      children: [
        Icon(icon, size: 18, color: const Color(0xFF91D78A)),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label.toUpperCase(),
                style: const TextStyle(
                  color: Colors.grey,
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                ),
              ),
              Text(
                value,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
