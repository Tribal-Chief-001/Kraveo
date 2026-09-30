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
import { LogoMark } from './components/ui/Logo';
import { useToast } from './components/ui/Toast';
import { ORDER_STATUS_LABEL } from './lib/tokens';
import { RefreshCw, X } from 'lucide-react';

export const App: React.FC = () => {
  const [isAuth, setIsAuth] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [adminProfile, setAdminProfile] = useState<AdminProfile | undefined>();
  const [activeTab, setActiveTab] = useState<TabType>('map');
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const toast = useToast();
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
      toast.success('Order updated', `Now ${ORDER_STATUS_LABEL[updated.status] ?? updated.status}.`);
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
      toast.success(updated.isAcceptingOrders ? 'Vendor is open' : 'Vendor is closed', `${updated.name} is ${updated.isAcceptingOrders ? 'now accepting' : 'no longer accepting'} orders.`);
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
      toast.success(driverId ? 'Runner assigned' : 'Runner unassigned', updated.driverName ? `${updated.driverName} is on this order.` : undefined);
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
    setSearchQuery('');
    setMobileNavOpen(false);
  };

  const handleSelectTab = useCallback((tab: TabType) => {
    setActiveTab(tab);
    setSearchQuery('');
  }, []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  if (authChecking) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-kraveo-night" role="status" aria-live="polite">
        <div className="animate-scale-in"><LogoMark size={64} /></div>
        <p className="flex items-center gap-2 text-sm font-semibold text-kraveo-ink2"><RefreshCw className="h-4 w-4 animate-spin text-kraveo-g400" aria-hidden="true" />Verifying admin session…</p>
      </div>
    );
  }

  if (!isAuth) {
    return <LoginScreen onLoginSuccess={(profile) => { setAdminProfile(profile); setIsAuth(true); }} />;
  }

  const activeOrderCount = orders.filter((order) => order.status !== 'DELIVERED' && order.status !== 'CANCELLED').length;
  const clearQuery = () => setSearchQuery('');

  return (
    <div className="min-h-screen bg-kraveo-night text-kraveo-ink lg:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[90] focus:rounded-k-sm focus:bg-kraveo-g400 focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-kraveo-g950">Skip to content</a>
      <Sidebar
        activeTab={activeTab}
        setActiveTab={handleSelectTab}
        isLiveConnected={isLiveConnected}
        mobileOpen={mobileNavOpen}
        onCloseMobile={closeMobileNav}
        badges={{ orders: activeOrderCount }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          activeTab={activeTab}
          isLiveConnected={isLiveConnected}
          isLoading={isLoading}
          adminProfile={adminProfile}
          onRefresh={fetchBackendData}
          onLogout={handleLogout}
          onOpenMenu={() => setMobileNavOpen(true)}
          query={searchQuery}
          onQueryChange={setSearchQuery}
        />
        {errorMessage && (
          <div role="alert" className="mx-4 mt-4 flex animate-fade-in items-center justify-between gap-3 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink sm:mx-6">
            <span className="min-w-0">{errorMessage}</span>
            <span className="flex shrink-0 items-center gap-1">
              <button className="k-btn-ghost !min-h-[36px] !px-3 text-xs" onClick={fetchBackendData}>Retry</button>
              <button aria-label="Dismiss error" className="k-icon-btn !h-9 !w-9" onClick={() => setErrorMessage('')}><X className="h-4 w-4" aria-hidden="true" /></button>
            </span>
          </div>
        )}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 pb-10 outline-none sm:p-6 sm:pb-12">
          <div key={activeTab} className="animate-fade-up">
            {activeTab === 'map' && <LiveCommandCenter drivers={drivers} orders={orders} driverPartners={driverPartners} onReassignDriver={handleReassignDriver} loading={isLoading} query={searchQuery} />}
            {activeTab === 'orders' && <OrdersTable orders={orders} onStatusChange={handleStatusChange} loading={isLoading} query={searchQuery} onClearQuery={clearQuery} />}
            {activeTab === 'vendors' && <VendorManager vendors={vendors} onToggleVendor={handleToggleVendor} onAddVendor={handleAddVendor} loading={isLoading} query={searchQuery} onClearQuery={clearQuery} />}
            {activeTab === 'drivers' && <DriverManager drivers={driverPartners} loading={isLoading} query={searchQuery} onClearQuery={clearQuery} />}
            {activeTab === 'analytics' && <AnalyticsPanel />}
          </div>
        </main>
      </div>
    </div>
  );
};
