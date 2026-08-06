export type UserRole = 'STUDENT' | 'VENDOR' | 'DRIVER' | 'ADMIN';

export type OrderStatus = 
  | 'PLACED'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'PICKED_UP'
  | 'ARRIVED_AT_GATE'
  | 'DELIVERED'
  | 'CANCELLED';

export interface User {
  id: string;
  name: string;
  phone: string;
  role: UserRole;
  hostelBlock?: string;
  createdAt: string;
}

export interface Vendor {
  id: string;
  userId: string;
  name: string;
  category: string;
  rating: number;
  eta: string;
  bannerImage: string;
  isAcceptingOrders: boolean;
  lat: number;
  lng: number;
  address: string;
}

export interface MenuItem {
  id: string;
  vendorId: string;
  name: string;
  price: number;
  category: string;
  description: string;
  imageUrl: string;
  isAvailable: boolean;
}

export interface OrderItem {
  itemId: string;
  name: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  vendorId: string;
  vendorName: string;
  driverId?: string;
  driverName?: string;
  driverPhone?: string;
  items: OrderItem[];
  totalAmount: number;
  deliveryFee: number;
  dropoffHostel: string;
  dropoffNotes?: string;
  status: OrderStatus;
  paymentStatus: 'PAID' | 'PENDING' | 'REFUNDED';
  createdAt: string;
  updatedAt: string;
}

export interface DriverLocation {
  driverId: string;
  driverName: string;
  lat: number;
  lng: number;
  heading: number;
  lastUpdated: string;
}
