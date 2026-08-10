import 'dart:async';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../widgets/duty_toggle.dart';
import '../widgets/earnings_card.dart';
import '../widgets/swipe_accept_card.dart';
import '../widgets/pipeline_stepper.dart';
import '../services/driver_api_service.dart';
import 'active_delivery.dart';
import 'earnings_history.dart';
import 'trip_logs.dart';
import 'runner_id_card_screen.dart';

class DriverHomeScreen extends StatefulWidget {
  const DriverHomeScreen({super.key});

  @override
  State<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends State<DriverHomeScreen> {
  bool isOnline = true;
  bool hasActiveJob = false;
  int currentStep = 0;
  double todayEarnings = 420.0;
  int completedTrips = 11;
  int selectedTab = 0;

  Timer? _locationTimer;
  static const String _dutyPrefKey = 'kraveo_driver_duty_online';

  @override
  void initState() {
    super.initState();
    _loadSavedDutyState();
  }

  @override
  void dispose() {
    _stopLocationStreaming();
    super.dispose();
  }

  Future<void> _loadSavedDutyState() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final savedOnline = prefs.getBool(_dutyPrefKey) ?? true;
      if (mounted) {
        setState(() {
          isOnline = savedOnline;
        });
      }
      DriverApiService.toggleDutyStatus(savedOnline);
      if (savedOnline) {
        _startLocationStreaming();
      }
    } catch (_) {
      if (isOnline) _startLocationStreaming();
    }
  }

  Future<void> _toggleDuty(bool val) async {
    setState(() {
      isOnline = val;
    });

    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_dutyPrefKey, val);
    } catch (_) {}

    DriverApiService.toggleDutyStatus(val);

    if (val) {
      _startLocationStreaming();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Duty Status: ONLINE. GPS location streaming active.'),
          backgroundColor: Color(0xFF00450D),
          duration: Duration(seconds: 2),
        ),
      );
    } else {
      _stopLocationStreaming();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Duty Status: OFFLINE. Location streaming paused.'),
          backgroundColor: Colors.redAccent,
          duration: Duration(seconds: 2),
        ),
      );
    }
  }

  void _startLocationStreaming() {
    _locationTimer?.cancel();
    // Simulate background GPS heartbeat updates (VIT Bhopal Campus region)
    _locationTimer = Timer.periodic(const Duration(seconds: 10), (timer) {
      if (!isOnline) {
        timer.cancel();
        return;
      }
      const baseLat = 23.0775;
      const baseLng = 76.8513;
      final stepOffset = (timer.tick % 6) * 0.0001;
      DriverApiService.updateLocation(baseLat + stepOffset, baseLng + stepOffset);
    });
  }

  void _stopLocationStreaming() {
    _locationTimer?.cancel();
    _locationTimer = null;
  }

  void _acceptJob() {
    setState(() {
      hasActiveJob = true;
      currentStep = 0;
      selectedTab = 1; // Switch to Active Delivery tab
    });

    // Sync job acceptance to AWS EC2 backend
    DriverApiService.acceptJob('ord-101');

    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Job Accepted! Navigating to Active Delivery Console...'),
        backgroundColor: Color(0xFF00450D),
        duration: Duration(seconds: 2),
      ),
    );
  }

  void _completeJob() {
    setState(() {
      hasActiveJob = false;
      todayEarnings += 40;
      completedTrips += 1;
      currentStep = 0;
      selectedTab = 0; // Return to main dashboard
    });

    // Sync delivery completion to backend
    DriverApiService.updateDeliveryStatus('ord-101', 'DELIVERED', otpCode: '1234');

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF151C2C),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: const BoxDecoration(
                color: Color(0xFF00450D),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.check_circle_outline, color: Color(0xFF91D78A), size: 48),
            ),
            const SizedBox(height: 16),
            const Text(
              'DELIVERY COMPLETED!',
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.w900,
                fontSize: 18,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Earned ₹40 for Order #ord-8492',
              style: TextStyle(color: Color(0xFFFDD400), fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text(
              'Total Today: ₹${todayEarnings.toInt()}',
              style: const TextStyle(color: Colors.grey, fontSize: 13),
            ),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton(
                onPressed: () => Navigator.pop(context),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFFFDD400),
                  foregroundColor: const Color(0xFF1B1C1C),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                ),
                child: const Text('BACK TO DASHBOARD', style: TextStyle(fontWeight: FontWeight.w900, fontSize: 14)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _callCampusAdminSupport() {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Row(
          children: [
            Icon(Icons.phone_in_talk, color: Color(0xFFFDD400)),
            SizedBox(width: 10),
            Text('Calling Kraveo Campus Dispatch SOS Hotline: +91 98765 43214', style: TextStyle(fontWeight: FontWeight.bold)),
          ],
        ),
        backgroundColor: Color(0xFF00450D),
        duration: Duration(seconds: 4),
      ),
    );
  }

  void _openRunnerPass() {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (context) => const RunnerIdCardScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    const darkBg = Color(0xFF1B1C1C);
    const gold = Color(0xFFFDD400);

    return Scaffold(
      backgroundColor: darkBg,
      appBar: AppBar(
        backgroundColor: darkBg,
        elevation: 0,
        title: const Row(
          children: [
            Icon(Icons.bolt, color: gold, size: 24),
            SizedBox(width: 6),
            Text(
              'Kraveo Runner',
              style: TextStyle(
                fontWeight: FontWeight.w900,
                fontSize: 20,
                color: Colors.white,
                letterSpacing: 0.5,
              ),
            ),
          ],
        ),
        actions: [
          // Runner Pass ID Button
          IconButton(
            icon: const Icon(Icons.badge, color: gold),
            tooltip: 'View Runner Security Pass',
            onPressed: _openRunnerPass,
          ),
          // Emergency SOS Call Button
          IconButton(
            icon: const Icon(Icons.sos, color: Colors.redAccent),
            tooltip: 'Emergency Campus Support',
            onPressed: _callCampusAdminSupport,
          ),
          Padding(
            padding: const EdgeInsets.only(right: 12.0),
            child: DutyToggle(
              isOnline: isOnline,
              onChanged: _toggleDuty,
            ),
          ),
        ],
      ),
      body: IndexedStack(
        index: selectedTab,
        children: [
          // Tab 0: Home / Duty Console
          _buildHomeDutyTab(),

          // Tab 1: Active Delivery Console
          hasActiveJob
              ? ActiveDeliveryScreen(
                  currentStep: currentStep,
                  onStepChanged: (step) {
                    setState(() {
                      currentStep = step;
                    });
                  },
                  onCompleted: _completeJob,
                )
              : _buildNoActiveJobView(),

          // Tab 2: Earnings History Screen
          const EarningsHistoryScreen(),

          // Tab 3: Trip History Screen
          const TripLogsScreen(),
        ],
      ),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: Colors.white10, width: 1)),
        ),
        child: NavigationBar(
          selectedIndex: selectedTab,
          onDestinationSelected: (index) {
            setState(() {
              selectedTab = index;
            });
          },
          backgroundColor: darkBg,
          indicatorColor: gold.withValues(alpha: 0.2),
          destinations: [
            const NavigationDestination(
              icon: Icon(Icons.home_outlined, color: Colors.grey),
              selectedIcon: Icon(Icons.home, color: gold),
              label: 'Console',
            ),
            NavigationDestination(
              icon: Badge(
                isLabelVisible: hasActiveJob,
                label: const Text('1'),
                child: const Icon(Icons.delivery_dining_outlined, color: Colors.grey),
              ),
              selectedIcon: Badge(
                isLabelVisible: hasActiveJob,
                label: const Text('1'),
                child: const Icon(Icons.delivery_dining, color: gold),
              ),
              label: 'Active',
            ),
            const NavigationDestination(
              icon: Icon(Icons.account_balance_wallet_outlined, color: Colors.grey),
              selectedIcon: Icon(Icons.account_balance_wallet, color: gold),
              label: 'Earnings',
            ),
            const NavigationDestination(
              icon: Icon(Icons.history_outlined, color: Colors.grey),
              selectedIcon: Icon(Icons.history, color: gold),
              label: 'Trips',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHomeDutyTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Earnings Overview Widget Card
          EarningsCard(
            todayEarnings: todayEarnings,
            completedTrips: completedTrips,
            onTap: () {
              setState(() {
                selectedTab = 2; // Jump to Earnings tab
              });
            },
          ),
          const SizedBox(height: 24),

          // Offline Status Notice if Duty Offline
          if (!isOnline)
            Container(
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(
                color: Colors.red.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: Colors.red.shade400),
              ),
              child: Row(
                children: [
                  const Icon(Icons.pause_circle_outline, color: Colors.redAccent, size: 28),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'YOU ARE OFFLINE',
                          style: TextStyle(
                            color: Colors.redAccent,
                            fontWeight: FontWeight.w900,
                            fontSize: 14,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Switch Duty Online in the top right to start receiving campus delivery requests.',
                          style: TextStyle(color: Colors.grey.shade300, fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            )
          // Job Request Card if Online & No Active Job
          else if (!hasActiveJob) ...[
            const Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Nearby Campus Job Request',
                  style: TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                    fontSize: 16,
                  ),
                ),
                Row(
                  children: [
                    CircleAvatar(
                      radius: 4,
                      backgroundColor: Color(0xFF91D78A),
                    ),
                    SizedBox(width: 6),
                    Text(
                      'Matching live',
                      style: TextStyle(color: Color(0xFF91D78A), fontSize: 11),
                    ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 12),
            SwipeAcceptCard(
              onAccepted: _acceptJob,
            ),
          ]
          // Active Delivery Summary preview card on Home tab
          else ...[
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFF151C2C),
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: const Color(0xFF00450D), width: 2),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'ACTIVE DELIVERY IN PROGRESS',
                        style: TextStyle(
                          color: Color(0xFFFDD400),
                          fontWeight: FontWeight.w900,
                          fontSize: 14,
                        ),
                      ),
                      Icon(Icons.directions_bike, color: Color(0xFF91D78A)),
                    ],
                  ),
                  const SizedBox(height: 16),
                  PipelineStepper(
                    currentStep: currentStep,
                    onStepTapped: (step) {
                      setState(() {
                        currentStep = step;
                      });
                    },
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    height: 52,
                    child: ElevatedButton.icon(
                      onPressed: () {
                        setState(() {
                          selectedTab = 1;
                        });
                      },
                      icon: const Icon(Icons.fullscreen, color: Colors.white),
                      label: const Text(
                        'OPEN ACTIVE CONSOLE',
                        style: TextStyle(
                          fontWeight: FontWeight.w900,
                          letterSpacing: 0.8,
                        ),
                      ),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF00450D),
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildNoActiveJobView() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: const Color(0xFF151C2C),
                shape: BoxShape.circle,
                border: Border.all(color: const Color(0xFFFDD400), width: 2),
              ),
              child: const Icon(
                Icons.delivery_dining,
                color: Color(0xFFFDD400),
                size: 64,
              ),
            ),
            const SizedBox(height: 24),
            const Text(
              'No Active Delivery Right Now',
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
                fontSize: 18,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Accept a new job request from the main console to start step-by-step guidance.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.grey, fontSize: 13),
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: () {
                setState(() {
                  selectedTab = 0;
                });
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFFFDD400),
                foregroundColor: const Color(0xFF1B1C1C),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              ),
              child: const Text('GO TO CONSOLE', style: TextStyle(fontWeight: FontWeight.w900)),
            ),
          ],
        ),
      ),
    );
  }
}
