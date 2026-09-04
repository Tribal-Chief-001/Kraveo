import React, { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { LiveCommandCenter } from './components/LiveCommandCenter';
import { OrdersTable } from './components/OrdersTable';
import { VendorManager } from './components/VendorManager';
import { DriverManager } from './components/DriverManager';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { AdminProfile, DriverPartner, DriverPin, Order, OrderStatus, TabType, Vendor, normalizeOrder } from './types';
import { ApiError, apiService, clearAuthToken, getAuthToken, isAuthenticated as hasSession, SOCKET_URL } from './services/api';
import { LoginScreen } from './components/LoginScreen';

export const App: React.FC = () => {
  const [isAuth, setIsAuth] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [adminProfile, setAdminProfile] = useState<AdminProfile | undefined>();
  const [activeTab, setActiveTab] = useState<TabType>('map');
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [driverPartners, setDriverPartners] = useState<DriverPartner[]>([]);
  const [drivers, setDrivers] = useState<DriverPin[]>([]);

  const handleAuthFailure = useCallback((error: unknown) => {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      clearAuthToken();
      setIsAuth(false);
      setAdminProfile(undefined);
    }
    setErrorMessage(error instanceof Error ? error.message : 'The operations request failed.');
  }, []);

  const fetchBackendData = useCallback(async () => {
    if (!getAuthToken()) return;
    setIsLoading(true);
    setErrorMessage('');
    const results = await Promise.allSettled([
      apiService.fetchOrders(),
      apiService.fetchVendors(),
      apiService.fetchDrivers(),
      apiService.fetchDriverLocations(),
    ]);
    const [ordersResult, vendorsResult, driversResult, locationsResult] = results;
    if (ordersResult.status === 'fulfilled') setOrders(ordersResult.value);
    if (vendorsResult.status === 'fulfilled') setVendors(vendorsResult.value);
    if (driversResult.status === 'fulfilled') setDriverPartners(driversResult.value);
    if (locationsResult.status === 'fulfilled') setDrivers(locationsResult.value);
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (firstError) handleAuthFailure(firstError.reason);
    setIsLoading(false);
  }, [handleAuthFailure]);

  useEffect(() => {
    if (!hasSession()) {
      setAuthChecking(false);
      return;
    }
    apiService.validateSession()
      .then((profile) => {
        setAdminProfile(profile);
        setIsAuth(true);
      })
      .catch((error) => {
        clearAuthToken();
        handleAuthFailure(error);
      })
      .finally(() => setAuthChecking(false));
  }, [handleAuthFailure]);

  useEffect(() => {
    if (!isAuth) return undefined;
    fetchBackendData();

    const token = getAuthToken();
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 8,
    });
    socket.on('connect', () => {
      setIsLiveConnected(true);
      socket.emit('join_room', 'admins');
    });
    socket.on('disconnect', () => setIsLiveConnected(false));
    socket.on('connect_error', () => setIsLiveConnected(false));
    socket.on('order_updated', (rawOrder: unknown) => {
      const updatedOrder = normalizeOrder(rawOrder);
      setOrders((previous) => {
        const exists = previous.some((order) => order.id === updatedOrder.id);
        return exists ? previous.map((order) => order.id === updatedOrder.id ? { ...order, ...updatedOrder } : order) : [updatedOrder, ...previous];
      });
    });
    socket.on('new_order_alert', (rawOrder: unknown) => {
      const newOrder = normalizeOrder(rawOrder);
      setOrders((previous) => [newOrder, ...previous.filter((order) => order.id !== newOrder.id)]);
    });
    socket.on('driver_location_update', (location: DriverPin) => {
      setDrivers((previous) => {
        const exists = previous.some((driver) => driver.id === location.id);
        return exists ? previous.map((driver) => driver.id === location.id ? { ...driver, ...location } : driver) : [location, ...previous];
      });
    });
    return () => {
      socket.disconnect();
    };
  }, [fetchBackendData, isAuth]);

  const handleStatusChange = async (orderId: string, status: OrderStatus, otpCode?: string) => {
    const previous = orders;
    setOrders((current) => current.map((order) => order.id === orderId ? { ...order, status } : order));
    try {
      const updated = await apiService.updateOrderStatus(orderId, status, otpCode);
      setOrders((current) => current.map((order) => order.id === orderId ? updated : order));
      setErrorMessage('');
    } catch (error) {
      setOrders(previous);
      handleAuthFailure(error);
    }
  };

  const handleToggleVendor = async (vendorId: string) => {
    const target = vendors.find((vendor) => vendor.id === vendorId);
    if (!target) return;
    const previous = vendors;
    const nextStatus = !target.isAcceptingOrders;
    setVendors((current) => current.map((vendor) => vendor.id === vendorId ? { ...vendor, isAcceptingOrders: nextStatus } : vendor));
    try {
      const updated = await apiService.toggleVendorStatus(vendorId, nextStatus);
      setVendors((current) => current.map((vendor) => vendor.id === vendorId ? updated : vendor));
    } catch (error) {
      setVendors(previous);
      handleAuthFailure(error);
    }
  };

  const handleAddVendor = async (vendorInput: Pick<Vendor, 'name' | 'category' | 'address'>) => {
    try {
      const created = await apiService.createVendor(vendorInput);
      setVendors((current) => [...current, created]);
      setErrorMessage('');
    } catch (error) {
      handleAuthFailure(error);
      throw error;
    }
  };

  const handleReassignDriver = async (orderId: string, driverId: string | null) => {
    const previous = orders;
    setOrders((current) => current.map((order) => order.id === orderId ? { ...order, driverId: driverId || undefined, driverName: driverId ? 'Updating assignment…' : undefined } : order));
    try {
      const updated = await apiService.reassignOrderDriver(orderId, driverId);
      setOrders((current) => current.map((order) => order.id === orderId ? updated : order));
    } catch (error) {
      setOrders(previous);
      handleAuthFailure(error);
    }
  };

  const handleLogout = () => {
    clearAuthToken();
    setIsAuth(false);
    setAdminProfile(undefined);
    setOrders([]);
    setVendors([]);
    setDriverPartners([]);
    setDrivers([]);
  };

  if (authChecking) {
    return <div className="min-h-screen bg-[#0B0F19] text-gray-300 flex items-center justify-center text-sm">Verifying admin session…</div>;
  }

  if (!isAuth) {
    return <LoginScreen onLoginSuccess={(profile) => { setAdminProfile(profile); setIsAuth(true); }} />;
  }

  return (
    <div className="min-h-screen bg-[#0B0F19] text-gray-100 lg:flex">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header activeTab={activeTab} isLiveConnected={isLiveConnected} isLoading={isLoading} adminProfile={adminProfile} onRefresh={fetchBackendData} onLogout={handleLogout} />
        {errorMessage && (
          <div role="alert" className="mx-4 mt-4 flex items-center justify-between gap-4 rounded-xl border border-red-500/40 bg-red-950/40 px-4 py-3 text-xs text-red-200 lg:mx-6">
            <span>{errorMessage}</span>
            <button className="font-bold text-white underline" onClick={fetchBackendData}>Retry</button>
          </div>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {activeTab === 'map' && <LiveCommandCenter drivers={drivers} orders={orders} driverPartners={driverPartners} onReassignDriver={handleReassignDriver} />}
          {activeTab === 'orders' && <OrdersTable orders={orders} onStatusChange={handleStatusChange} />}
          {activeTab === 'vendors' && <VendorManager vendors={vendors} onToggleVendor={handleToggleVendor} onAddVendor={handleAddVendor} />}
          {activeTab === 'drivers' && <DriverManager drivers={driverPartners} />}
          {activeTab === 'analytics' && <AnalyticsPanel />}
        </main>
      </div>
    </div>
  );
};
