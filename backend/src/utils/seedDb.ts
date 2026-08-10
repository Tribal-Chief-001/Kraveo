import { PrismaClient, Role, OrderStatus, PaymentStatus, DutyStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding PostgreSQL Database with VIT Bhopal Campus Data...');

  // 1. Create Users (usr-1 to usr-9)
  await prisma.user.upsert({
    where: { phone: '+91 9876543210' },
    update: { name: 'Rahul Sharma', role: Role.STUDENT, hostelBlock: 'Boys Hostel Block 3', kraveoCoins: 30 },
    create: {
      id: 'usr-1',
      name: 'Rahul Sharma',
      phone: '+91 9876543210',
      role: Role.STUDENT,
      hostelBlock: 'Boys Hostel Block 3',
      kraveoCoins: 30,
    },
  });

  await prisma.user.upsert({
    where: { phone: '+91 9876543211' },
    update: { name: 'Ananya Verma', role: Role.STUDENT, hostelBlock: 'Girls Hostel Gate 1', kraveoCoins: 40 },
    create: {
      id: 'usr-2',
      name: 'Ananya Verma',
      phone: '+91 9876543211',
      role: Role.STUDENT,
      hostelBlock: 'Girls Hostel Gate 1',
      kraveoCoins: 40,
    },
  });

  await prisma.user.upsert({
    where: { phone: '+91 9876543212' },
    update: { name: 'Ram Singh (Sharma Dhaba)', role: Role.VENDOR },
    create: {
      id: 'usr-3',
      name: 'Ram Singh (Sharma Dhaba)',
      phone: '+91 9876543212',
      role: Role.VENDOR,
    },
  });

  await prisma.user.upsert({
    where: { phone: '+91 9876543213' },
    update: { name: 'Vikram Singh (Runner)', role: Role.DRIVER },
    create: {
      id: 'usr-4',
      name: 'Vikram Singh (Runner)',
      phone: '+91 9876543213',
      role: Role.DRIVER,
    },
  });

  await prisma.user.upsert({
    where: { phone: '+91 9876543214' },
    update: { name: 'Super Admin', role: Role.ADMIN },
    create: {
      id: 'usr-5',
      name: 'Super Admin',
      phone: '+91 9876543214',
      role: Role.ADMIN,
    },
  });

  await prisma.user.upsert({
    where: { phone: '+91 9876543215' },
    update: { name: 'Campus Night Canteen Owner', role: Role.VENDOR },
    create: {
      id: 'usr-6',
      name: 'Campus Night Canteen Owner',
      phone: '+91 9876543215',
      role: Role.VENDOR,
    },
  });

  await prisma.user.upsert({
    where: { phone: '+91 9876543216' },
    update: { name: 'Singh Punjabi Kitchen Owner', role: Role.VENDOR },
    create: {
      id: 'usr-7',
      name: 'Singh Punjabi Kitchen Owner',
      phone: '+91 9876543216',
      role: Role.VENDOR,
    },
  });

  await prisma.user.upsert({
    where: { phone: '+91 9123456780' },
    update: { name: 'Rohan Mehta (Runner)', role: Role.DRIVER },
    create: {
      id: 'usr-8',
      name: 'Rohan Mehta (Runner)',
      phone: '+91 9123456780',
      role: Role.DRIVER,
    },
  });

  await prisma.user.upsert({
    where: { phone: '+91 9112233445' },
    update: { name: 'Aman Deep (Runner)', role: Role.DRIVER },
    create: {
      id: 'usr-9',
      name: 'Aman Deep (Runner)',
      phone: '+91 9112233445',
      role: Role.DRIVER,
    },
  });

  // 2. Create Driver Partners (usr-4, usr-8, usr-9)
  await prisma.driverPartner.upsert({
    where: { id: 'usr-4' },
    update: {
      userId: 'usr-4',
      name: 'Vikram Singh',
      phone: '+91 9876543213',
      studentRegNo: '21BCG10045',
      runnerCode: 'RUN-8042',
      dutyStatus: DutyStatus.IN_TRANSIT,
      ordersToday: 8,
      totalEarningsToday: 320,
      avgCompletionTimeMinutes: 18.5,
      onTimeRatePercent: 98.2,
      rating: 4.9,
      upiId: 'vikram@upi',
    },
    create: {
      id: 'usr-4',
      userId: 'usr-4',
      name: 'Vikram Singh',
      phone: '+91 9876543213',
      studentRegNo: '21BCG10045',
      runnerCode: 'RUN-8042',
      avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop&q=80',
      vehicleType: 'TVS Jupiter Scooty',
      vehicleRegNo: 'MP 04 AB 1234',
      emergencyPhone: '+91 98989 12345',
      dutyStatus: DutyStatus.IN_TRANSIT,
      ordersToday: 8,
      totalEarningsToday: 320,
      avgCompletionTimeMinutes: 18.5,
      onTimeRatePercent: 98.2,
      rating: 4.9,
      upiId: 'vikram@upi',
    },
  });

  await prisma.driverPartner.upsert({
    where: { id: 'usr-8' },
    update: {
      userId: 'usr-8',
      name: 'Rohan Mehta',
      phone: '+91 9123456780',
      studentRegNo: '22BCE10192',
      runnerCode: 'RUN-8043',
      dutyStatus: DutyStatus.ONLINE,
      ordersToday: 5,
      totalEarningsToday: 200,
      avgCompletionTimeMinutes: 16.0,
      onTimeRatePercent: 99.0,
      rating: 4.8,
      upiId: 'rohanm@upi',
    },
    create: {
      id: 'usr-8',
      userId: 'usr-8',
      name: 'Rohan Mehta',
      phone: '+91 9123456780',
      studentRegNo: '22BCE10192',
      runnerCode: 'RUN-8043',
      avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=300&auto=format&fit=crop&q=80',
      vehicleType: 'Hero Splendor Bike',
      vehicleRegNo: 'MP 04 CD 5678',
      emergencyPhone: '+91 97777 54321',
      dutyStatus: DutyStatus.ONLINE,
      ordersToday: 5,
      totalEarningsToday: 200,
      avgCompletionTimeMinutes: 16.0,
      onTimeRatePercent: 99.0,
      rating: 4.8,
      upiId: 'rohanm@upi',
    },
  });

  await prisma.driverPartner.upsert({
    where: { id: 'usr-9' },
    update: {
      userId: 'usr-9',
      name: 'Aman Deep',
      phone: '+91 9112233445',
      studentRegNo: '23BCE10884',
      runnerCode: 'RUN-8044',
      dutyStatus: DutyStatus.OFFLINE,
      ordersToday: 0,
      totalEarningsToday: 0,
      avgCompletionTimeMinutes: 22.0,
      onTimeRatePercent: 95.5,
      rating: 4.7,
      upiId: 'amand@upi',
    },
    create: {
      id: 'usr-9',
      userId: 'usr-9',
      name: 'Aman Deep',
      phone: '+91 9112233445',
      studentRegNo: '23BCE10884',
      runnerCode: 'RUN-8044',
      avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=300&auto=format&fit=crop&q=80',
      vehicleType: 'Bicycle (Campus)',
      vehicleRegNo: 'CYCLE-B3',
      emergencyPhone: '+91 96666 11223',
      dutyStatus: DutyStatus.OFFLINE,
      ordersToday: 0,
      totalEarningsToday: 0,
      avgCompletionTimeMinutes: 22.0,
      onTimeRatePercent: 95.5,
      rating: 4.7,
      upiId: 'amand@upi',
    },
  });

  // 3. Create Vendors (ven-1, ven-2, ven-3)
  const dhaba1 = await prisma.vendor.upsert({
    where: { id: 'ven-1' },
    update: {
      userId: 'usr-3',
      name: 'Sharma Highway Dhaba',
      category: 'North Indian • Thalis • Parathas',
      address: 'Ashta-Kothri Highway, 1.2km from VIT Bhopal Gate',
      rating: 4.8,
      totalRatingsCount: 124,
      eta: '25-35 mins',
      bannerImage: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600&auto=format&fit=crop&q=80',
      isAcceptingOrders: true,
      lat: 23.0768,
      lng: 76.8524,
    },
    create: {
      id: 'ven-1',
      userId: 'usr-3',
      name: 'Sharma Highway Dhaba',
      category: 'North Indian • Thalis • Parathas',
      address: 'Ashta-Kothri Highway, 1.2km from VIT Bhopal Gate',
      rating: 4.8,
      totalRatingsCount: 124,
      eta: '25-35 mins',
      bannerImage: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600&auto=format&fit=crop&q=80',
      isAcceptingOrders: true,
      lat: 23.0768,
      lng: 76.8524,
    },
  });

  const dhaba2 = await prisma.vendor.upsert({
    where: { id: 'ven-2' },
    update: {
      userId: 'usr-6',
      name: 'Campus Night Canteen',
      category: 'Fast Food • Maggi • Beverages',
      address: 'Near VIT Bhopal Main Entry Gate',
      rating: 4.6,
      totalRatingsCount: 88,
      eta: '15-20 mins',
      bannerImage: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&auto=format&fit=crop&q=80',
      isAcceptingOrders: true,
      lat: 23.0785,
      lng: 76.8550,
    },
    create: {
      id: 'ven-2',
      userId: 'usr-6',
      name: 'Campus Night Canteen',
      category: 'Fast Food • Maggi • Beverages',
      address: 'Near VIT Bhopal Main Entry Gate',
      rating: 4.6,
      totalRatingsCount: 88,
      eta: '15-20 mins',
      bannerImage: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&auto=format&fit=crop&q=80',
      isAcceptingOrders: true,
      lat: 23.0785,
      lng: 76.8550,
    },
  });

  const dhaba3 = await prisma.vendor.upsert({
    where: { id: 'ven-3' },
    update: {
      userId: 'usr-7',
      name: 'Singh Punjabi Kitchen',
      category: 'Butter Chicken • Naan',
      address: 'Kothri Bypass Road',
      rating: 4.9,
      totalRatingsCount: 156,
      eta: '30-40 mins',
      bannerImage: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=600&auto=format&fit=crop&q=80',
      isAcceptingOrders: true,
      lat: 23.0750,
      lng: 76.8500,
    },
    create: {
      id: 'ven-3',
      userId: 'usr-7',
      name: 'Singh Punjabi Kitchen',
      category: 'Butter Chicken • Naan',
      address: 'Kothri Bypass Road',
      rating: 4.9,
      totalRatingsCount: 156,
      eta: '30-40 mins',
      bannerImage: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=600&auto=format&fit=crop&q=80',
      isAcceptingOrders: true,
      lat: 23.0750,
      lng: 76.8500,
    },
  });

  // 4. Create Menu Items (item-1 to item-7)
  await prisma.menuItem.upsert({
    where: { id: 'item-1' },
    update: { vendorId: dhaba1.id, name: 'Special Shahi Paneer Thali', price: 180.0, category: 'Thalis', description: 'Paneer, Dal Makhani, 4 Butter Rotis, Rice & Gulab Jamun', imageUrl: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400', isAvailable: true, isVeg: true, rating: 4.9, ratingCount: 42 },
    create: {
      id: 'item-1',
      vendorId: dhaba1.id,
      name: 'Special Shahi Paneer Thali',
      price: 180.0,
      category: 'Thalis',
      description: 'Paneer, Dal Makhani, 4 Butter Rotis, Rice & Gulab Jamun',
      imageUrl: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400',
      isAvailable: true,
      isVeg: true,
      rating: 4.9,
      ratingCount: 42,
    },
  });

  await prisma.menuItem.upsert({
    where: { id: 'item-2' },
    update: { vendorId: dhaba1.id, name: 'Aloo Pyaz Paratha (2 pcs)', price: 90.0, category: 'Parathas', description: 'Served with fresh curd & white butter', imageUrl: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=400', isAvailable: true, isVeg: true, rating: 4.7, ratingCount: 28 },
    create: {
      id: 'item-2',
      vendorId: dhaba1.id,
      name: 'Aloo Pyaz Paratha (2 pcs)',
      price: 90.0,
      category: 'Parathas',
      description: 'Served with fresh curd & white butter',
      imageUrl: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=400',
      isAvailable: true,
      isVeg: true,
      rating: 4.7,
      ratingCount: 28,
    },
  });

  await prisma.menuItem.upsert({
    where: { id: 'item-3' },
    update: { vendorId: dhaba1.id, name: 'Kulhad Sweet Lassi', price: 50.0, category: 'Beverages', description: 'Chilled thick creamy lassi in authentic earthen kulhad', imageUrl: 'https://images.unsplash.com/photo-1571006682855-3bc67776510d?w=400', isAvailable: true, isVeg: true, rating: 4.9, ratingCount: 65 },
    create: {
      id: 'item-3',
      vendorId: dhaba1.id,
      name: 'Kulhad Sweet Lassi',
      price: 50.0,
      category: 'Beverages',
      description: 'Chilled thick creamy lassi in authentic earthen kulhad',
      imageUrl: 'https://images.unsplash.com/photo-1571006682855-3bc67776510d?w=400',
      isAvailable: true,
      isVeg: true,
      rating: 4.9,
      ratingCount: 65,
    },
  });

  await prisma.menuItem.upsert({
    where: { id: 'item-4' },
    update: { vendorId: dhaba2.id, name: 'Cheese Butter Cheese Maggi', price: 70.0, category: 'Fast Food', description: 'Double cheese load with crispy onions and butter', imageUrl: 'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841?w=400', isAvailable: true, isVeg: true, rating: 4.8, ratingCount: 50 },
    create: {
      id: 'item-4',
      vendorId: dhaba2.id,
      name: 'Cheese Butter Cheese Maggi',
      price: 70.0,
      category: 'Fast Food',
      description: 'Double cheese load with crispy onions and butter',
      imageUrl: 'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841?w=400',
      isAvailable: true,
      isVeg: true,
      rating: 4.8,
      ratingCount: 50,
    },
  });

  await prisma.menuItem.upsert({
    where: { id: 'item-5' },
    update: { vendorId: dhaba2.id, name: 'Paneer Loaded Sandwich', price: 85.0, category: 'Fast Food', description: 'Grilled sandwich with spiced cottage cheese filling', imageUrl: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=400', isAvailable: true, isVeg: true, rating: 4.5, ratingCount: 30 },
    create: {
      id: 'item-5',
      vendorId: dhaba2.id,
      name: 'Paneer Loaded Sandwich',
      price: 85.0,
      category: 'Fast Food',
      description: 'Grilled sandwich with spiced cottage cheese filling',
      imageUrl: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=400',
      isAvailable: true,
      isVeg: true,
      rating: 4.5,
      ratingCount: 30,
    },
  });

  await prisma.menuItem.upsert({
    where: { id: 'item-6' },
    update: { vendorId: dhaba3.id, name: 'Butter Chicken (Half)', price: 260.0, category: 'Main Course', description: 'Rich tomato cream gravy with tender grilled chicken', imageUrl: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=400', isAvailable: true, isVeg: false, rating: 4.95, ratingCount: 80 },
    create: {
      id: 'item-6',
      vendorId: dhaba3.id,
      name: 'Butter Chicken (Half)',
      price: 260.0,
      category: 'Main Course',
      description: 'Rich tomato cream gravy with tender grilled chicken',
      imageUrl: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=400',
      isAvailable: true,
      isVeg: false,
      rating: 4.95,
      ratingCount: 80,
    },
  });

  await prisma.menuItem.upsert({
    where: { id: 'item-7' },
    update: { vendorId: dhaba3.id, name: 'Garlic Butter Naan (2 pcs)', price: 60.0, category: 'Breads', description: 'Crispy tandoori naan brushed with garlic & butter', imageUrl: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400', isAvailable: true, isVeg: true, rating: 4.85, ratingCount: 75 },
    create: {
      id: 'item-7',
      vendorId: dhaba3.id,
      name: 'Garlic Butter Naan (2 pcs)',
      price: 60.0,
      category: 'Breads',
      description: 'Crispy tandoori naan brushed with garlic & butter',
      imageUrl: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400',
      isAvailable: true,
      isVeg: true,
      rating: 4.85,
      ratingCount: 75,
    },
  });

  // 5. Create Initial Orders (ord-101, ord-102)
  await prisma.order.upsert({
    where: { id: 'ord-101' },
    update: {
      status: OrderStatus.PICKED_UP,
      paymentStatus: PaymentStatus.PAID,
      driverId: 'usr-4',
    },
    create: {
      id: 'ord-101',
      customerId: 'usr-1',
      vendorId: dhaba1.id,
      driverId: 'usr-4',
      totalAmount: 460.0,
      deliveryFee: 30.0,
      dropoffHostel: 'Boys Hostel Block 3',
      dropoffNotes: 'Call when at Hostel Gate 2',
      status: OrderStatus.PICKED_UP,
      paymentStatus: PaymentStatus.PAID,
      otpCode: '1234',
      items: {
        create: [
          { menuItemId: 'item-1', name: 'Special Shahi Paneer Thali', quantity: 2, price: 180.0 },
          { menuItemId: 'item-3', name: 'Kulhad Sweet Lassi', quantity: 2, price: 50.0 },
        ],
      },
    },
  });

  await prisma.order.upsert({
    where: { id: 'ord-102' },
    update: {
      status: OrderStatus.PREPARING,
      paymentStatus: PaymentStatus.PAID,
    },
    create: {
      id: 'ord-102',
      customerId: 'usr-2',
      vendorId: dhaba2.id,
      totalAmount: 175.0,
      deliveryFee: 20.0,
      dropoffHostel: 'Girls Hostel Gate 1',
      dropoffNotes: 'Leave with security if not answering',
      status: OrderStatus.PREPARING,
      paymentStatus: PaymentStatus.PAID,
      otpCode: '5678',
      items: {
        create: [
          { menuItemId: 'item-4', name: 'Cheese Butter Cheese Maggi', quantity: 1, price: 70.0 },
          { menuItemId: 'item-5', name: 'Paneer Loaded Sandwich', quantity: 1, price: 85.0 },
        ],
      },
    },
  });

  // 6. Create Driver Location (usr-4)
  await prisma.driverLocation.upsert({
    where: { driverId: 'usr-4' },
    update: {
      driverName: 'Vikram Singh',
      lat: 23.0772,
      lng: 76.8535,
      heading: 120,
      lastUpdated: new Date(),
    },
    create: {
      driverId: 'usr-4',
      driverName: 'Vikram Singh',
      lat: 23.0772,
      lng: 76.8535,
      heading: 120,
    },
  });

  console.log('✅ PostgreSQL Database Seeding Complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
