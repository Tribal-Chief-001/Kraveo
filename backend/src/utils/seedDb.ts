import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding PostgreSQL Database with VIT Bhopal Campus Data...');

  // 1. Create Users
  const student = await prisma.user.upsert({
    where: { email: 'student@vitbhopal.ac.in' },
    update: {},
    create: {
      id: 'usr-1',
      name: 'Rahul Sharma',
      email: 'student@vitbhopal.ac.in',
      phone: '+91 9876543210',
      role: 'STUDENT',
      hostelBlock: 'Block 3',
    },
  });

  const driver = await prisma.user.upsert({
    where: { email: 'runner@kraveo.in' },
    update: {},
    create: {
      id: 'usr-2',
      name: 'Amit Patel',
      email: 'runner@kraveo.in',
      phone: '+91 9876543211',
      role: 'DRIVER',
    },
  });

  const vendorUser = await prisma.user.upsert({
    where: { email: 'sharma@dhaba.com' },
    update: {},
    create: {
      id: 'usr-3',
      name: 'Sharma Dhaba Owner',
      email: 'sharma@dhaba.com',
      phone: '+91 9876543212',
      role: 'VENDOR',
    },
  });

  // 2. Create Vendors
  const dhaba1 = await prisma.vendor.upsert({
    where: { id: 'ven-1' },
    update: {},
    create: {
      id: 'ven-1',
      userId: vendorUser.id,
      name: 'Sharma Highway Dhaba',
      category: 'North Indian • Thalis • Parathas',
      address: 'Ashta-Kothri Highway, 1.2km from VIT Bhopal Gate',
      lat: 23.0768,
      lng: 76.8524,
      rating: 4.8,
      eta: '25-35 mins',
      bannerImage: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600&auto=format&fit=crop&q=80',
      isAcceptingOrders: true,
    },
  });

  const dhaba2 = await prisma.vendor.upsert({
    where: { id: 'ven-2' },
    update: {},
    create: {
      id: 'ven-2',
      userId: vendorUser.id,
      name: 'Campus Night Canteen',
      category: 'Fast Food • Maggi • Beverages',
      address: 'Near VIT Bhopal Main Entry Gate',
      lat: 23.0785,
      lng: 76.855,
      rating: 4.6,
      eta: '15-20 mins',
      bannerImage: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&auto=format&fit=crop&q=80',
      isAcceptingOrders: true,
    },
  });

  // 3. Create Menu Items
  await prisma.menuItem.upsert({
    where: { id: 'dish-1' },
    update: {},
    create: {
      id: 'dish-1',
      vendorId: dhaba1.id,
      name: 'Special Highway Butter Paneer',
      description: 'Rich tomato gravy with fresh cottage cheese cubes and butter glaze',
      price: 180.0,
      category: 'Main Course',
      isVeg: true,
      inStock: true,
      image: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=600&auto=format&fit=crop&q=80',
    },
  });

  await prisma.menuItem.upsert({
    where: { id: 'dish-2' },
    update: {},
    create: {
      id: 'dish-2',
      vendorId: dhaba1.id,
      name: 'Aloo Paratha with White Butter',
      description: '2 pcs spiced potato parathas served with curd and pickle',
      price: 90.0,
      category: 'Breads & Tandoor',
      isVeg: true,
      inStock: true,
      image: 'https://images.unsplash.com/photo-1626082927389-6cd097cdc6ec?w=600&auto=format&fit=crop&q=80',
    },
  });

  await prisma.menuItem.upsert({
    where: { id: 'dish-3' },
    update: {},
    create: {
      id: 'dish-3',
      vendorId: dhaba2.id,
      name: 'Cheese Butter Cheese Maggi',
      description: 'Double cheese load Maggi with butter and chili oil',
      price: 70.0,
      category: 'Snacks',
      isVeg: true,
      inStock: true,
      image: 'https://images.unsplash.com/photo-1612927601601-6638404737ce?w=600&auto=format&fit=crop&q=80',
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
