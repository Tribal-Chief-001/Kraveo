import 'dart:async';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:geolocator/geolocator.dart';
import 'package:kraveo_ui/kraveo_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../widgets/duty_toggle.dart';
import '../widgets/earnings_card.dart';
import '../widgets/swipe_accept_card.dart';
import '../widgets/pipeline_stepper.dart';
import '../widgets/ui/icon_action.dart';
import '../widgets/ui/radar_pulse.dart';
import '../widgets/ui/screen_header.dart';
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
  bool _offerDismissed = false;

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
      if (val) _offerDismissed = false;
    });

    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_dutyPrefKey, val.toString());
      await prefs.setBool(_dutyPrefKey, val);
    } catch (_) {}

    DriverApiService.toggleDutyStatus(val);

    if (val) {
      _startLocationStreaming();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('You are on duty. Live location is on.'),
          duration: Duration(seconds: 2),
        ),
      );
    } else {
      _stopLocationStreaming();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('You are off duty. Location sharing paused.'),
          duration: Duration(seconds: 2),
        ),
      );
    }
  }

  void _startLocationStreaming() {
    _locationTimer?.cancel();
    _locationTimer = Timer.periodic(const Duration(seconds: 10), (timer) async {
      if (!isOnline) {
        timer.cancel();
        return;
      }
      try {
        final position = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.high,
          timeLimit: const Duration(seconds: 3),
        );
        DriverApiService.updateLocation(position.latitude, position.longitude, heading: position.heading);
      } catch (_) {
        // Background fail-safe coordinates for VIT Bhopal campus
        const baseLat = 23.0775;
        const baseLng = 76.8513;
        final stepOffset = (timer.tick % 6) * 0.0001;
        DriverApiService.updateLocation(baseLat + stepOffset, baseLng + stepOffset);
      }
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
        content: Text('Job accepted. Opening your delivery...'),
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
      _offerDismissed = false;
    });

    // Sync delivery completion to backend
    DriverApiService.updateDeliveryStatus('ord-101', 'DELIVERED', otpCode: '1234');

    showDialog(
      context: context,
      builder: (context) {
        final k = context.k;
        return AlertDialog(
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 88,
                height: 88,
                decoration: BoxDecoration(color: k.brand.withValues(alpha: 0.16), shape: BoxShape.circle, boxShadow: KShadow.glow(k.brand)),
                child: Icon(LucideIcons.check, color: k.brand, size: 48),
              ),
              const SizedBox(height: 16),
              Text('Delivered', style: KraveoType.displayMd.copyWith(color: k.ink)),
              const SizedBox(height: 4),
              KAnimatedNumber(value: 40, prefix: '+₹', style: KraveoType.displayLg.copyWith(color: k.brand, fontSize: 56)),
              const SizedBox(height: 4),
              Text('Order #ord-8492', style: KraveoType.bodySm.copyWith(color: k.inkFaint)),
              const SizedBox(height: 2),
              Text('Total today ₹${todayEarnings.toInt()}', style: KraveoType.titleMd.copyWith(color: k.inkMuted)),
              const SizedBox(height: 20),
              KButton(label: 'Back to home', icon: LucideIcons.house, large: true, onPressed: () => Navigator.pop(context)),
            ],
          ),
        );
      },
    );
  }

  void _callCampusAdminSupport() {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Row(
          children: [
            Icon(LucideIcons.phoneCall, color: context.k.accent),
            const SizedBox(width: 10),
            const Expanded(child: Text('Calling Kraveo Campus Dispatch SOS Hotline: +91 98765 43214')),
          ],
        ),
        duration: const Duration(seconds: 4),
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
    return Scaffold(
      extendBody: true,
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
      bottomNavigationBar: KGlassNav(
        index: selectedTab,
        onChanged: (index) {
          setState(() {
            selectedTab = index;
          });
        },
        items: [
          const KNavItem(LucideIcons.house, 'Home'),
          KNavItem(LucideIcons.bike, 'Active', badge: hasActiveJob ? 1 : 0),
          const KNavItem(LucideIcons.wallet, 'Earnings'),
          const KNavItem(LucideIcons.history, 'Trips'),
        ],
      ),
    );
  }

  Widget _buildHomeDutyTab() {
    final k = context.k;
    return SafeArea(
      bottom: false,
      child: Builder(builder: (context) {
        final bottomInset = MediaQuery.paddingOf(context).bottom;
        return ListView(
          padding: EdgeInsets.fromLTRB(KSpace.gutter, 12, KSpace.gutter, bottomInset + 24),
          children: [
            // Header: brand + ID pass + SOS
            Row(
              children: [
                const KBrandMark(height: 40),
                const Spacer(),
                KIconButton(icon: LucideIcons.badgeCheck, semanticLabel: 'Open runner ID pass', onTap: _openRunnerPass),
                const SizedBox(width: 10),
                KIconButton(icon: LucideIcons.siren, semanticLabel: 'Emergency campus support', tint: KraveoPalette.danger, onTap: _callCampusAdminSupport),
              ],
            ),
            const SizedBox(height: 20),

            // Hero duty control
            DutyToggle(isOnline: isOnline, onChanged: _toggleDuty),
            const SizedBox(height: 16),

            // Earnings hero + stat tiles
            KReveal(
              child: EarningsCard(
                todayEarnings: todayEarnings,
                completedTrips: completedTrips,
                onTap: () {
                  setState(() {
                    selectedTab = 2; // Jump to Earnings tab
                  });
                },
              ),
            ),
            const SizedBox(height: 8),

            // Job area
            if (!isOnline) ...[
              const SectionLabel('Orders', padding: EdgeInsets.fromLTRB(4, 16, 4, 8)),
              KCard(
                child: KEmptyState(
                  icon: LucideIcons.wifiOff,
                  title: 'You are off duty',
                  message: 'Go on duty to start receiving campus orders.',
                  action: KButton(label: 'Go on duty', icon: LucideIcons.power, large: true, expand: false, onPressed: () => _toggleDuty(true)),
                ),
              ),
            ] else if (!hasActiveJob && !_offerDismissed) ...[
              const SectionLabel('New order', padding: EdgeInsets.fromLTRB(4, 16, 4, 8)),
              KReveal(
                child: SwipeAcceptCard(
                  key: ValueKey('offer-$completedTrips'),
                  onAccepted: _acceptJob,
                  onDeclined: () => setState(() => _offerDismissed = true),
                ),
              ),
            ] else if (!hasActiveJob) ...[
              const SectionLabel('Orders', padding: EdgeInsets.fromLTRB(4, 16, 4, 8)),
              const KCard(
                padding: EdgeInsets.zero,
                clip: true,
                child: Stack(
                  clipBehavior: Clip.hardEdge,
                  alignment: Alignment.topCenter,
                  children: [
                    // Radar rings are centred on the KEmptyState icon circle (32px padding + 42px radius).
                    Positioned(top: 74 - 130, left: 0, right: 0, child: Center(child: RadarPulse(size: 260))),
                    KEmptyState(
                      icon: LucideIcons.radar,
                      title: 'You\'re online - waiting for orders',
                      message: 'Stay near the campus gate. New orders appear here.',
                    ),
                  ],
                ),
              ),
            ] else ...[
              // Active Delivery Summary preview card on Home tab
              const SectionLabel('In progress', padding: EdgeInsets.fromLTRB(4, 16, 4, 8)),
              KCard(
                padding: const EdgeInsets.all(20),
                borderColor: k.brand.withValues(alpha: 0.55),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Delivery in progress', style: KraveoType.headlineSm.copyWith(color: k.ink)),
                    const SizedBox(height: 16),
                    PipelineStepper(
                      currentStep: currentStep,
                      onStepTapped: (step) {
                        setState(() {
                          currentStep = step;
                        });
                      },
                    ),
                    const SizedBox(height: 20),
                    KButton(
                      label: 'Open active delivery',
                      icon: LucideIcons.arrowRight,
                      kind: KButtonKind.accent,
                      large: true,
                      onPressed: () {
                        setState(() {
                          selectedTab = 1;
                        });
                      },
                    ),
                  ],
                ),
              ),
            ],

            // Runner pass entry
            const SizedBox(height: 16),
            KCard(
              onTap: _openRunnerPass,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
              child: Row(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(color: k.brandSoft, borderRadius: BorderRadius.circular(KRadius.md)),
                    child: Icon(LucideIcons.badgeCheck, color: k.brand, size: 24),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Runner ID pass', style: KraveoType.titleLg.copyWith(color: k.ink)),
                        Text('Show at the hostel gate', style: KraveoType.bodySm.copyWith(color: k.inkMuted)),
                      ],
                    ),
                  ),
                  Icon(LucideIcons.chevronRight, color: k.inkFaint),
                ],
              ),
            ),
          ],
        );
      }),
    );
  }

  Widget _buildNoActiveJobView() {
    return SafeArea(
      bottom: false,
      child: KEmptyState(
        icon: LucideIcons.bike,
        title: 'No active delivery',
        message: 'Accept an order from Home to start step-by-step guidance.',
        action: KButton(
          label: 'Go to home',
          icon: LucideIcons.house,
          large: true,
          expand: false,
          onPressed: () {
            setState(() {
              selectedTab = 0;
            });
          },
        ),
      ),
    );
  }
}
