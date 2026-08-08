import { Vendor, MenuItem, Order, DriverLocation, User, DriverPartner } from './types';

// Initial Mock Users
export const users: User[] = [
  { id: 'usr-1', name: 'Rahul Sharma', phone: '+91 9876543210', role: 'STUDENT', hostelBlock: 'Boys Hostel Block 3', createdAt: new Date().toISOString() },
  { id: 'usr-2', name: 'Ananya Verma', phone: '+91 9876543211', role: 'STUDENT', hostelBlock: 'Girls Hostel Gate 1', createdAt: new Date().toISOString() },
  { id: 'usr-3', name: 'Ram Singh (Sharma Dhaba)', phone: '+91 9876543212', role: 'VENDOR', createdAt: new Date().toISOString() },
  { id: 'usr-4', name: 'Vikram Singh (Runner)', phone: '+91 9876543213', role: 'DRIVER', createdAt: new Date().toISOString() },
  { id: 'usr-5', name: 'Super Admin', phone: '+91 9876543214', role: 'ADMIN', createdAt: new Date().toISOString() },
];

// Initial Mock Vendors (Highway Dhabas & Canteens near VIT Bhopal)
export const vendors: Vendor[] = [
  {
    id: 'ven-1',
    userId: 'usr-3',
    name: 'Sharma Highway Dhaba',
    category: 'North Indian • Thalis • Parathas',
    rating: 4.8,
    eta: '25-35 mins',
    bannerImage: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600&auto=format&fit=crop&q=80',
    isAcceptingOrders: true,
    lat: 23.0768,
    lng: 76.8524,
    address: 'Ashta-Kothri Highway, 1.2km from VIT Bhopal Gate'
  },
  {
    id: 'ven-2',
    userId: 'usr-6',
    name: 'Campus Night Canteen',
    category: 'Fast Food • Maggi • Beverages',
    rating: 4.6,
    eta: '15-20 mins',
    bannerImage: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&auto=format&fit=crop&q=80',
    isAcceptingOrders: true,
    lat: 23.0785,
    lng: 76.8550,
    address: 'Near VIT Bhopal Main Entry Gate'
  },
  {
    id: 'ven-3',
    userId: 'usr-7',
    name: 'Singh Punjabi Kitchen',
    category: 'Butter Chicken • Paneer • Naan',
    rating: 4.9,
    eta: '30-40 mins',
    bannerImage: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=600&auto=format&fit=crop&q=80',
    isAcceptingOrders: true,
    lat: 23.0750,
    lng: 76.8500,
    address: 'Kothri Bypass Road'
  }
];

// Initial Driver Partners
export const driverPartners: DriverPartner[] = [
  {
    id: 'usr-4',
    name: 'Vikram Singh',
    phone: '+91 9876543213',
    studentRegNo: '21BCG10045',
    runnerCode: 'RUN-8042',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop&q=80',
    vehicleType: 'TVS Jupiter Scooty',
    vehicleRegNo: 'MP 04 AB 1234',
    emergencyPhone: '+91 98989 12345',
    dutyStatus: 'IN_TRANSIT',
    ordersToday: 8,
    totalEarningsToday: 320,
    avgCompletionTimeMinutes: 18.5,
    onTimeRatePercent: 98.2,
    rating: 4.9,
    upiId: 'vikram@upi',
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'usr-8',
    name: 'Rohan Mehta',
    phone: '+91 9123456780',
    studentRegNo: '22BCE10192',
    runnerCode: 'RUN-8043',
    avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=300&auto=format&fit=crop&q=80',
    vehicleType: 'Hero Splendor Bike',
    vehicleRegNo: 'MP 04 CD 5678',
    emergencyPhone: '+91 97777 54321',
    dutyStatus: 'ONLINE',
    ordersToday: 5,
    totalEarningsToday: 200,
    avgCompletionTimeMinutes: 16.0,
    onTimeRatePercent: 99.0,
    rating: 4.8,
    upiId: 'rohanm@upi',
    createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'usr-9',
    name: 'Aman Deep',
    phone: '+91 9112233445',
    studentRegNo: '23BCE10884',
    runnerCode: 'RUN-8044',
    avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=300&auto=format&fit=crop&q=80',
    vehicleType: 'Bicycle (Campus)',
    vehicleRegNo: 'CYCLE-B3',
    emergencyPhone: '+91 96666 11223',
    dutyStatus: 'OFFLINE',
    ordersToday: 0,
    totalEarningsToday: 0,
    avgCompletionTimeMinutes: 22.0,
    onTimeRatePercent: 95.5,
    rating: 4.7,
    upiId: 'amand@upi',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  }
];

// Initial Mock Menu Items
export const menuItems: MenuItem[] = [
  // Sharma Dhaba
  { id: 'item-1', vendorId: 'ven-1', name: 'Special Shahi Paneer Thali', price: 180, category: 'Thalis', description: 'Paneer, Dal Makhani, 4 Butter Rotis, Rice & Gulab Jamun', imageUrl: 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400', isAvailable: true },
  { id: 'item-2', vendorId: 'ven-1', name: 'Aloo Pyaz Paratha (2 pcs)', price: 90, category: 'Parathas', description: 'Served with fresh curd & white butter', imageUrl: 'https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=400', isAvailable: true },
  { id: 'item-3', vendorId: 'ven-1', name: 'Kulhad Sweet Lassi', price: 50, category: 'Beverages', description: 'Chilled thick creamy lassi in authentic earthen kulhad', imageUrl: 'https://images.unsplash.com/photo-1571006682855-3bc67776510d?w=400', isAvailable: true },

  // Campus Night Canteen
  { id: 'item-4', vendorId: 'ven-2', name: 'Cheese Butter Cheese Maggi', price: 70, category: 'Fast Food', description: 'Double cheese load with crispy onions and butter', imageUrl: 'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841?w=400', isAvailable: true },
  { id: 'item-5', vendorId: 'ven-2', name: 'Paneer Loaded Sandwich', price: 85, category: 'Fast Food', description: 'Grilled sandwich with spiced cottage cheese filling', imageUrl: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=400', isAvailable: true },

  // Singh Punjabi Kitchen
  { id: 'item-6', vendorId: 'ven-3', name: 'Butter Chicken (Half)', price: 260, category: 'Main Course', description: 'Rich tomato cream gravy with tender grilled chicken', imageUrl: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=400', isAvailable: true },
  { id: 'item-7', vendorId: 'ven-3', name: 'Garlic Butter Naan (2 pcs)', price: 60, category: 'Breads', description: 'Crispy tandoori naan brushed with garlic & butter', imageUrl: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400', isAvailable: true }
];

// Initial Active Orders
export const orders: Order[] = [
  {
    id: 'ord-101',
    customerId: 'usr-1',
    customerName: 'Rahul Sharma',
    customerPhone: '+91 9876543210',
    vendorId: 'ven-1',
    vendorName: 'Sharma Highway Dhaba',
    driverId: 'usr-4',
    driverName: 'Vikram Singh',
    driverPhone: '+91 9876543213',
    items: [
      { itemId: 'item-1', name: 'Special Shahi Paneer Thali', quantity: 2, price: 180 },
      { itemId: 'item-3', name: 'Kulhad Sweet Lassi', quantity: 2, price: 50 }
    ],
    totalAmount: 460,
    deliveryFee: 30,
    dropoffHostel: 'Boys Hostel Block 3',
    dropoffNotes: 'Call when at Hostel Gate 2',
    status: 'PICKED_UP',
    paymentStatus: 'PAID',
    createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'ord-102',
    customerId: 'usr-2',
    customerName: 'Ananya Verma',
    customerPhone: '+91 9876543211',
    vendorId: 'ven-2',
    vendorName: 'Campus Night Canteen',
    items: [
      { itemId: 'item-4', name: 'Cheese Butter Cheese Maggi', quantity: 1, price: 70 },
      { itemId: 'item-5', name: 'Paneer Loaded Sandwich', quantity: 1, price: 85 }
    ],
    totalAmount: 175,
    deliveryFee: 20,
    dropoffHostel: 'Girls Hostel Gate 1',
    dropoffNotes: 'Leave with security if not answering',
    status: 'PREPARING',
    paymentStatus: 'PAID',
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString()
  }
];

// Driver Locations (Simulated continuous GPS feed near VIT Bhopal)
export const driverLocations: Map<string, DriverLocation> = new Map([
  [
    'usr-4',
    {
      driverId: 'usr-4',
      driverName: 'Vikram Singh',
      lat: 23.0772,
      lng: 76.8535,
      heading: 120,
      lastUpdated: new Date().toISOString()
    }
  ]
]);
