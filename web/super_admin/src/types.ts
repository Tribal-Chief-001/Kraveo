export type TabType = 'map' | 'orders' | 'vendors' | 'drivers' | 'analytics';

export type OrderStatus = 
  | 'PLACED'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'PICKED_UP'
  | 'ARRIVED_AT_GATE'
  | 'DELIVERED'
  | 'CANCELLED';

export interface Order {
  id: string;
  customerName: string;
  customerPhone: string;
  vendorName: string;
  driverName?: string;
  itemsCount: number;
  totalAmount: number;
  dropoffHostel: string;
  status: OrderStatus;
  createdAt: string;
}

export interface Vendor {
  id: string;
  name: string;
  category: string;
  rating: number;
  isAcceptingOrders: boolean;
  address: string;
  activeOrdersCount: number;
}

export interface DriverPin {
  id: string;
  name: string;
  lat: number;
  lng: number;
  heading: number;
  status: 'IDLE' | 'EN_ROUTE_DHABA' | 'DELIVERING_GATE';
  currentOrderId?: string;
}

export interface DriverPartner {
  id: string;
  name: string;
  phone: string;
  studentRegNo: string;
  runnerCode: string;
  avatarUrl: string;
  vehicleType: string;
  vehicleRegNo: string;
  emergencyPhone: string;
  dutyStatus: 'ONLINE' | 'OFFLINE' | 'IN_TRANSIT';
  ordersToday: number;
  totalEarningsToday: number;
  avgCompletionTimeMinutes: number;
  onTimeRatePercent: number;
  rating: number;
  upiId: string;
  createdAt: string;
}
