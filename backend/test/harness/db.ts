import { prisma } from '../../src/db';
import { Role, OrderStatus, PaymentStatus, DutyStatus } from '@prisma/client';

export { prisma };

export const seedTestDatabase = async () => {
  // 1. Seed standard test users
  const student = await prisma.user.upsert({
    where: { phone: '+91 9876543210' },
    update: { name: 'Rahul Sharma', role: Role.STUDENT, hostelBlock: 'Boys Hostel Block 3' },
    create: {
      id: 'usr-1',
      name: 'Rahul Sharma',
      phone: '+91 9876543210',
      role: Role.STUDENT,
      hostelBlock: 'Boys Hostel Block 3',
      kraveoCoins: 30
    }
  });

  const vendorUser = await prisma.user.upsert({
    where: { phone: '+91 9876543212' },
    update: { name: 'Ram Singh (Sharma Dhaba)', role: Role.VENDOR },
    create: {
      id: 'usr-3',
      name: 'Ram Singh (Sharma Dhaba)',
      phone: '+91 9876543212',
      role: Role.VENDOR
    }
  });

  const driverUser = await prisma.user.upsert({
    where: { phone: '+91 9876543213' },
    update: { name: 'Vikram Singh (Runner)', role: Role.DRIVER },
    create: {
      id: 'usr-4',
      name: 'Vikram Singh (Runner)',
      phone: '+91 9876543213',
      role: Role.DRIVER
    }
  });

  const adminUser = await prisma.user.upsert({
    where: { phone: '+91 9876543214' },
    update: { name: 'Super Admin', role: Role.ADMIN },
    create: {
      id: 'usr-5',
      name: 'Super Admin',
      phone: '+91 9876543214',
      role: Role.ADMIN
    }
  });

  // 2. Seed Vendor
  const vendor = await prisma.vendor.upsert({
    where: { id: 'ven-1' },
    update: {
      userId: vendorUser.id,
      name: 'Sharma Highway Dhaba',
      category: 'North Indian • Thalis • Parathas',
      address: 'Ashta-Kothri Highway, 1.2km from VIT Bhopal Gate',
      isAcceptingOrders: true
    },
    create: {
      id: 'ven-1',
      userId: vendorUser.id,
      name: 'Sharma Highway Dhaba',
      category: 'North Indian • Thalis • Parathas',
      address: 'Ashta-Kothri Highway, 1.2km from VIT Bhopal Gate',
      rating: 4.8,
      totalRatingsCount: 124,
      eta: '25-35 mins',
      bannerImage: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600',
      isAcceptingOrders: true
    }
  });

  // 3. Seed Menu Items
  const menuItem1 = await prisma.menuItem.upsert({
    where: { id: 'item-1' },
    update: { vendorId: vendor.id, name: 'Special Shahi Paneer Thali', price: 180.0, isAvailable: true },
    create: {
      id: 'item-1',
      vendorId: vendor.id,
      name: 'Special Shahi Paneer Thali',
      price: 180.0,
      category: 'Thalis',
      description: 'Paneer, Dal Makhani, 4 Butter Rotis, Rice & Gulab Jamun',
      imageUrl: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400',
      isAvailable: true,
      isVeg: true
    }
  });

  const menuItem2 = await prisma.menuItem.upsert({
    where: { id: 'item-2' },
    update: { vendorId: vendor.id, name: 'Aloo Pyaz Paratha (2 pcs)', price: 90.0, isAvailable: true },
    create: {
      id: 'item-2',
      vendorId: vendor.id,
      name: 'Aloo Pyaz Paratha (2 pcs)',
      price: 90.0,
      category: 'Parathas',
      description: 'Served with fresh curd & white butter',
      imageUrl: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=400',
      isAvailable: true,
      isVeg: true
    }
  });

  // 4. Seed Driver Partner
  await prisma.driverPartner.upsert({
    where: { id: 'usr-4' },
    update: {
      userId: driverUser.id,
      name: 'Vikram Singh',
      phone: driverUser.phone,
      dutyStatus: DutyStatus.ONLINE
    },
    create: {
      id: 'usr-4',
      userId: driverUser.id,
      name: 'Vikram Singh',
      phone: driverUser.phone,
      studentRegNo: '21BCG10045',
      runnerCode: 'RUN-8042',
      avatarUrl: 'https://images.unsplash.com/photo-1534528741775',
      vehicleType: 'TVS Jupiter Scooty',
      vehicleRegNo: 'MP 04 AB 1234',
      emergencyPhone: '+91 98989 12345',
      dutyStatus: DutyStatus.ONLINE
    }
  });

  return { student, vendorUser, driverUser, adminUser, vendor, menuItem1, menuItem2 };
};

export const cleanTestOrders = async () => {
  // Delete test created orders/payments/orderItems
  await prisma.payment.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
};

export const cleanTestUsers = async () => {
  await prisma.user.deleteMany({
    where: { phone: { startsWith: '+91 9999' } }
  });
};

export const resetTestDatabase = async () => {
  await cleanTestOrders();
  await cleanTestUsers();
  await seedTestDatabase();
};
