import 'package:flutter/material.dart';
import '../models/trip_model.dart';

class TripLogsScreen extends StatefulWidget {
  const TripLogsScreen({super.key});

  @override
  State<TripLogsScreen> createState() => _TripLogsScreenState();
}

class _TripLogsScreenState extends State<TripLogsScreen> {
  String selectedFilter = 'All';

  final List<TripModel> dummyTrips = [
    TripModel(
      id: '#ord-8492',
      pickupName: 'FC Night Mess',
      pickupAddress: 'VIT Bhopal Entry Gate 1',
      dropoffName: 'Boys Hostel Block 1',
      dropoffAddress: 'Gate 2 Handshake',
      distanceKm: 1.8,
      payout: 40.0,
      estimatedMinutes: '12 mins',
      customerName: 'Aman Sharma',
      customerPhone: '+91 98765 43210',
      otpCode: '4829',
      timestamp: DateTime.now().subtract(const Duration(minutes: 45)),
    ),
    TripModel(
      id: '#ord-8488',
      pickupName: 'Underdoggs Campus Cafe',
      pickupAddress: 'Academic Block 2 Canteen',
      dropoffName: 'Girls Hostel Block 2',
      dropoffAddress: 'Security Counter Handshake',
      distanceKm: 2.3,
      payout: 45.0,
      estimatedMinutes: '15 mins',
      customerName: 'Priya Verma',
      customerPhone: '+91 98123 45678',
      otpCode: '9102',
      timestamp: DateTime.now().subtract(const Duration(hours: 2, minutes: 15)),
    ),
    TripModel(
      id: '#ord-8451',
      pickupName: 'Southern Spice Dhaba',
      pickupAddress: 'Kothri Kalan Highway Side',
      dropoffName: 'Boys Hostel Block 4',
      dropoffAddress: 'Main Entrance Gate 1',
      distanceKm: 3.1,
      payout: 55.0,
      estimatedMinutes: '18 mins',
      customerName: 'Rahul Nair',
      customerPhone: '+91 97654 32109',
      otpCode: '3341',
      timestamp: DateTime.now().subtract(const Duration(hours: 5)),
    ),
    TripModel(
      id: '#ord-8410',
      pickupName: 'Amul Ice Cream Parlour',
      pickupAddress: 'Student Activity Center',
      dropoffName: 'Faculty Quarter B3',
      dropoffAddress: 'Ground Floor Lobby',
      distanceKm: 1.2,
      payout: 35.0,
      estimatedMinutes: '8 mins',
      customerName: 'Dr. Suresh Mehta',
      customerPhone: '+91 99001 12233',
      otpCode: '7789',
      timestamp: DateTime.now().subtract(const Duration(days: 1, hours: 2)),
    ),
  ];

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
        title: const Text(
          'Trip History',
          style: TextStyle(
            fontWeight: FontWeight.w900,
            fontSize: 20,
            color: Colors.white,
          ),
        ),
      ),
      body: Column(
        children: [
          // Filter Chips Row
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: ['All', 'Today', 'Yesterday', 'This Week'].map((filter) {
                  final isSelected = selectedFilter == filter;
                  return Padding(
                    padding: const EdgeInsets.only(right: 8.0),
                    child: FilterChip(
                      selected: isSelected,
                      label: Text(
                        filter,
                        style: TextStyle(
                          color: isSelected ? Colors.black : Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 12,
                        ),
                      ),
                      selectedColor: gold,
                      backgroundColor: darkSurface,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(20),
                        side: BorderSide(
                          color: isSelected ? gold : Colors.white24,
                        ),
                      ),
                      onSelected: (selected) {
                        setState(() {
                          selectedFilter = filter;
                        });
                      },
                    ),
                  );
                }).toList(),
              ),
            ),
          ),

          const SizedBox(height: 8),

          // Trip List
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
              itemCount: dummyTrips.length,
              itemBuilder: (context, index) {
                final trip = dummyTrips[index];
                return Padding(
                  padding: const EdgeInsets.only(bottom: 12.0),
                  child: InkWell(
                    onTap: () => _showTripDetails(context, trip),
                    borderRadius: BorderRadius.circular(20),
                    child: Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: darkSurface,
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(color: Colors.white10),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          // Trip Card Header
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Text(
                                trip.id,
                                style: const TextStyle(
                                  color: gold,
                                  fontWeight: FontWeight.w900,
                                  fontSize: 15,
                                ),
                              ),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 10, vertical: 4),
                                decoration: BoxDecoration(
                                  color: emerald.withValues(alpha: 0.3),
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(color: emeraldLight),
                                ),
                                child: const Row(
                                  children: [
                                    Icon(Icons.check_circle,
                                        color: emeraldLight, size: 12),
                                    SizedBox(width: 4),
                                    Text(
                                      'DELIVERED',
                                      style: TextStyle(
                                        color: emeraldLight,
                                        fontSize: 10,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),

                          // Route summary
                          Row(
                            children: [
                              const Icon(Icons.circle,
                                  color: emeraldLight, size: 10),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  trip.pickupName,
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w700,
                                    fontSize: 14,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          Padding(
                            padding: const EdgeInsets.only(left: 4.0),
                            child: Container(
                              height: 14,
                              width: 2,
                              color: Colors.white24,
                            ),
                          ),
                          Row(
                            children: [
                              const Icon(Icons.location_on,
                                  color: gold, size: 12),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  trip.dropoffName,
                                  style: const TextStyle(
                                    color: gold,
                                    fontWeight: FontWeight.w700,
                                    fontSize: 14,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 14),

                          const Divider(color: Colors.white10, height: 1),
                          const SizedBox(height: 10),

                          // Footer with Distance, Time & Payout
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Text(
                                '${trip.distanceKm} km • ${trip.estimatedMinutes}',
                                style: const TextStyle(
                                  color: Colors.grey,
                                  fontSize: 12,
                                ),
                              ),
                              Text(
                                '+ ₹${trip.payout.toInt()}',
                                style: const TextStyle(
                                  color: gold,
                                  fontWeight: FontWeight.w900,
                                  fontSize: 16,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  void _showTripDetails(BuildContext context, TripModel trip) {
    const gold = Color(0xFFFDD400);
    const emerald = Color(0xFF00450D);
    const emeraldLight = Color(0xFF91D78A);
    const darkSurface = Color(0xFF151C2C);

    showModalBottomSheet(
      context: context,
      backgroundColor: darkSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      builder: (context) {
        return Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Colors.white24,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),

              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Trip Details ${trip.id}',
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w900,
                      fontSize: 18,
                    ),
                  ),
                  Text(
                    '₹${trip.payout.toInt()}',
                    style: const TextStyle(
                      color: gold,
                      fontWeight: FontWeight.w900,
                      fontSize: 22,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),

              const Text('Pickup Location',
                  style: TextStyle(color: Colors.grey, fontSize: 11)),
              Text(trip.pickupName,
                  style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 15)),
              Text(trip.pickupAddress,
                  style: const TextStyle(color: Colors.grey, fontSize: 12)),

              const SizedBox(height: 12),
              const Text('Dropoff Location',
                  style: TextStyle(color: Colors.grey, fontSize: 11)),
              Text(trip.dropoffName,
                  style: const TextStyle(
                      color: gold,
                      fontWeight: FontWeight.bold,
                      fontSize: 15)),
              Text(trip.dropoffAddress,
                  style: const TextStyle(color: Colors.grey, fontSize: 12)),

              const SizedBox(height: 16),
              const Divider(color: Colors.white10),
              const SizedBox(height: 8),

              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Customer', style: TextStyle(color: Colors.grey)),
                  Text(trip.customerName,
                      style: const TextStyle(
                          color: Colors.white, fontWeight: FontWeight.bold)),
                ],
              ),
              const SizedBox(height: 6),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Handshake OTP', style: TextStyle(color: Colors.grey)),
                  Text(trip.otpCode,
                      style: const TextStyle(
                          color: emeraldLight, fontWeight: FontWeight.bold)),
                ],
              ),

              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () => Navigator.of(context).pop(),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: emerald,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16)),
                  ),
                  child: const Text('Close'),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
