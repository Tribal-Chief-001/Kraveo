import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { LiveCommandCenter } from './components/LiveCommandCenter';
import { OrdersTable } from './components/OrdersTable';
import { VendorManager } from './components/VendorManager';
import { DriverManager } from './components/DriverManager';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { TabType, Order, Vendor, DriverPin, OrderStatus, DriverPartner } from './types';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('map');
  const [isLiveConnected, setIsLiveConnected] = useState<boolean>(true);

  // Initial Driver Partners State
  const [driverPartners, setDriverPartners] = useState<DriverPartner[]>([
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
      createdAt: new Date().toISOString()
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
      createdAt: new Date().toISOString()
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
      createdAt: new Date().toISOString()
    }
  ]);

  // Mock State Data (Synced with API backend)
  const [orders, setOrders] = useState<Order[]>([
    {
      id: 'ord-101',
      customerName: 'Rahul Sharma',
      customerPhone: '+91 9876543210',
      vendorName: 'Sharma Highway Dhaba',
      driverName: 'Vikram Singh',
      itemsCount: 4,
      totalAmount: 460,
      dropoffHostel: 'Boys Hostel Block 3',
      status: 'PICKED_UP',
      createdAt: '15 mins ago'
    },
    {
      id: 'ord-102',
      customerName: 'Ananya Verma',
      customerPhone: '+91 9876543211',
      vendorName: 'Campus Night Canteen',
      driverName: 'Aman Patel',
      itemsCount: 2,
      totalAmount: 175,
      dropoffHostel: 'Girls Hostel Gate 1',
      status: 'PREPARING',
      createdAt: '5 mins ago'
    },
    {
      id: 'ord-103',
      customerName: 'Siddharth Roy',
      customerPhone: '+91 9876543215',
      vendorName: 'Singh Punjabi Kitchen',
      driverName: 'Vikram Singh',
      itemsCount: 3,
      totalAmount: 320,
      dropoffHostel: 'Boys Hostel Block 1',
      status: 'ARRIVED_AT_GATE',
      createdAt: '22 mins ago'
    }
  ]);

  const [vendors, setVendors] = useState<Vendor[]>([
    {
      id: 'ven-1',
      name: 'Sharma Highway Dhaba',
      category: 'North Indian • Thalis',
      rating: 4.8,
      isAcceptingOrders: true,
      address: 'Ashta-Kothri Highway km 1.2',
      activeOrdersCount: 3
    },
    {
      id: 'ven-2',
      name: 'Campus Night Canteen',
      category: 'Fast Food • Maggi',
      rating: 4.6,
      isAcceptingOrders: true,
      address: 'VIT Bhopal Entry Gate 1',
      activeOrdersCount: 2
    },
    {
      id: 'ven-3',
      name: 'Singh Punjabi Kitchen',
      category: 'Butter Chicken • Naan',
      rating: 4.9,
      isAcceptingOrders: true,
      address: 'Kothri Bypass Road',
      activeOrdersCount: 1
    }
  ]);

  const [drivers, setDrivers] = useState<DriverPin[]>([
    {
      id: 'drv-1',
      name: 'Vikram Singh',
      lat: 23.0772,
      lng: 76.8535,
      heading: 120,
      status: 'EN_ROUTE_DHABA',
      currentOrderId: 'ord-101'
    },
    {
      id: 'drv-2',
      name: 'Aman Patel',
      lat: 23.0785,
      lng: 76.8550,
      heading: 90,
      status: 'DELIVERING_GATE',
      currentOrderId: 'ord-102'
    }
  ]);

  // Attempt real API fetch if server is running
  const fetchBackendData = async () => {
    try {
      const [ordersRes, vendorsRes, driversRes] = await Promise.all([
        fetch('http://localhost:5000/api/orders'),
        fetch('http://localhost:5000/api/vendors'),
        fetch('http://localhost:5000/api/drivers'),
      ]);

      if (ordersRes.ok) {
        const json = await ordersRes.json();
        if (json.data && json.data.length > 0) {
          setOrders(json.data);
          setIsLiveConnected(true);
        }
      }

      if (vendorsRes.ok) {
        const json = await vendorsRes.json();
        if (json.data && json.data.length > 0) {
          setVendors(json.data);
        }
      }

      if (driversRes.ok) {
        const json = await driversRes.json();
        if (json.data && json.data.length > 0) {
          setDriverPartners(json.data);
        }
      }
    } catch {
      // Offline fallback or standalone mode
    }
  };

  useEffect(() => {
    fetchBackendData();

    const socket = io('http://localhost:5000', {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
    });

    socket.on('connect', () => {
      setIsLiveConnected(true);
    });

    socket.on('disconnect', () => {
      setIsLiveConnected(false);
    });

    socket.on('order_updated', (updatedOrder: Order) => {
      setOrders((prev) => {
        const exists = prev.some((o) => o.id === updatedOrder.id);
        if (exists) {
          return prev.map((o) => (o.id === updatedOrder.id ? { ...o, ...updatedOrder } : o));
        } else {
          return [updatedOrder, ...prev];
        }
      });
    });

    socket.on('new_order_alert', (newOrder: Order) => {
      setOrders((prev) => [newOrder, ...prev.filter((o) => o.id !== newOrder.id)]);
    });

    socket.on('driver_location_update', (loc: { driverId: string; driverName: string; lat: number; lng: number; heading: number }) => {
      setDrivers((prev) => {
        const exists = prev.some((d) => d.id === loc.driverId);
        if (exists) {
          return prev.map((d) => (d.id === loc.driverId ? { ...d, lat: loc.lat, lng: loc.lng, heading: loc.heading } : d));
        } else {
          return [...prev, { id: loc.driverId, name: loc.driverName, lat: loc.lat, lng: loc.lng, heading: loc.heading, status: 'DELIVERING_GATE' }];
        }
      });
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const handleStatusChange = async (orderId: string, status: OrderStatus) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, status } : o))
    );
    try {
      await fetch(`http://localhost:5000/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer mock_jwt_token_usr-5'
        },
        body: JSON.stringify({ status })
      });
    } catch (e) {
      console.log('Backend status update fallback:', e);
    }
  };

  const handleToggleVendor = async (vendorId: string) => {
    const targetVendor = vendors.find((v) => v.id === vendorId);
    if (!targetVendor) return;

    const newStatus = !targetVendor.isAcceptingOrders;

    setVendors((prev) =>
      prev.map((v) => (v.id === vendorId ? { ...v, isAcceptingOrders: newStatus } : v))
    );

    try {
      await fetch(`http://localhost:5000/api/vendors/${vendorId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAcceptingOrders: newStatus }),
      });
    } catch (e) {
      console.log('Backend vendor status toggle fallback:', e);
    }
  };

  const handleReassignDriver = (orderId: string) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, driverName: 'Reassigning...', status: 'PLACED' } : o))
    );
  };

  return (
    <div className="flex min-h-screen bg-[#0B0F19]">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      
      <div className="flex-1 flex flex-col min-w-0">
        <Header 
          activeTab={activeTab} 
          isLiveConnected={isLiveConnected} 
          onRefresh={fetchBackendData} 
        />

        <main className="p-6 flex-1 overflow-y-auto">
          {activeTab === 'map' && (
            <LiveCommandCenter 
              drivers={drivers} 
              orders={orders} 
              onReassignDriver={handleReassignDriver} 
            />
          )}

          {activeTab === 'orders' && (
            <OrdersTable 
              orders={orders} 
              onStatusChange={handleStatusChange} 
            />
          )}

          {activeTab === 'vendors' && (
            <VendorManager 
              vendors={vendors} 
              onToggleVendor={handleToggleVendor} 
              onAddVendor={(newVendor) => setVendors((prev) => [...prev, newVendor])}
            />
          )}

          {activeTab === 'drivers' && (
            <DriverManager drivers={driverPartners} />
          )}

          {activeTab === 'analytics' && <AnalyticsPanel />}
        </main>
      </div>
    </div>
  );
};
