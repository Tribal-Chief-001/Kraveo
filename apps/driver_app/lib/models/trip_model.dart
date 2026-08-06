class TripModel {
  final String id;
  final String pickupName;
  final String pickupAddress;
  final String dropoffName;
  final String dropoffAddress;
  final double distanceKm;
  final double payout;
  final String estimatedMinutes;
  final String customerName;
  final String customerPhone;
  final String otpCode;
  final DateTime timestamp;
  final String status; // 'completed', 'active', 'pending'

  const TripModel({
    required this.id,
    required this.pickupName,
    required this.pickupAddress,
    required this.dropoffName,
    required this.dropoffAddress,
    required this.distanceKm,
    required this.payout,
    required this.estimatedMinutes,
    required this.customerName,
    required this.customerPhone,
    required this.otpCode,
    required this.timestamp,
    this.status = 'completed',
  });
}

class DriverStats {
  final double todayEarnings;
  final int completedTripsToday;
  final double weeklyEarnings;
  final int totalTrips;
  final double rating;

  const DriverStats({
    required this.todayEarnings,
    required this.completedTripsToday,
    required this.weeklyEarnings,
    required this.totalTrips,
    required this.rating,
  });
}
