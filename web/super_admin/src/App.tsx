import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { LiveCommandCenter } from './components/LiveCommandCenter';
import { OrdersTable } from './components/OrdersTable';
import { VendorManager } from './components/VendorManager';
import { DriverManager } from './components/DriverManager';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { ApplicationsPanel } from './components/ApplicationsPanel';
import { CustomersPanel } from './components/CustomersPanel';
import { AdminProfile, AttentionEntry, DriverPartner, DriverPin, Order, OrderStatus, TabType, Vendor, normalizeDriverPin, normalizeOrderPartial } from './types';
import { ApiError, apiService, clearAuthToken, getAuthToken, isAuthenticated as hasSession, SOCKET_URL } from './services/api';
import { LoginScreen } from './components/LoginScreen';
import { LogoMark } from './components/ui/Logo';
import { useToast } from './components/ui/Toast';
import { ORDER_STATUS_LABEL } from './lib/tokens';
import { RefreshCw, X } from 'lucide-react';
import { NeedsAttentionPanel } from './components/NeedsAttentionPanel';
import { DrawerMode, OrderDrawer } from './components/OrderDrawer';
import { appendOlderPage, mergeInto, mergeOrderLists, oldestOrderId, patchOrder, restoreIfUntouched, upsertOrder } from './lib/orders';
import { sameData } from './lib/dashboardStats';
import { isSessionRejected, reassignFailureMessage, sessionRetryDelayMs } from './lib/adminMessages';
import { useConfirm } from './components/ui/ConfirmDialog';
import { localAttention, pruneWithLiveOrders } from './lib/orderProblems';
import { SavedPin, vendorsNeedingLocation } from './lib/vendorLocation';
import { mergeRiderPins, newestPerRider, replaceRiderPins } from './lib/riderMarkers';

/** Contract 3: sockets are only a speed-up; the REST list is polled while the page is visible. */
const POLL_MS = 15_000;
const ATTENTION_DEBOUNCE_MS = 1_500;
/** Rider position events are applied to the map at most this often. */
const LOCATION_FLUSH_MS = 1_000;
/** One page of "Load older" orders. */
const OLDER_PAGE_SIZE = 100;

/** Thrown inside an order action when the admin answers "no" to a question: roll back quietly, no error toast. */
class ActionCancelled extends Error {}

/** Makes the server's rider errors readable (see lib/adminMessages). */
const plainReassignError = (error: unknown): unknown => (error instanceof ApiError
  ? new ApiError(error.status, reassignFailureMessage(error.code, error.message), error.code, error.field)
  : error);

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
  const [pendingApplications, setPendingApplications] = useState(0);
  const [applicationsKey, setApplicationsKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // The stored session could not be checked because the server was unreachable (the token is kept and the check retried).
  const [sessionUnreachable, setSessionUnreachable] = useState(false);
  // "Load older": whether the server has more orders than the ones loaded, and whether a page is being fetched.
  const [hasMoreOrders, setHasMoreOrders] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderLoadedRef = useRef(false);
  // Restaurants whose open/close request is in flight (the switch is disabled meanwhile).
  const [busyVendorIds, setBusyVendorIds] = useState<ReadonlySet<string>>(() => new Set());
  const busyVendorRef = useRef<Set<string>>(new Set());
  const { confirm, dialog: confirmDialog } = useConfirm();
  // Needs-attention list (server). `available: false` = old server without the endpoint -> local fallback.
  const [attention, setAttention] = useState<{ available: boolean | null; entries: AttentionEntry[]; loading: boolean; error: string; checkedAt: number | null }>(
    { available: null, entries: [], loading: false, error: '', checkedAt: null },
  );
  // Order drawer: the id to show; `drawerFallback` holds a copy for orders outside the loaded page.
  const [drawer, setDrawer] = useState<{ id: string; mode: DrawerMode } | null>(null);
  const [drawerFallback, setDrawerFallback] = useState<Order | null>(null);
  const [drawerLoad, setDrawerLoad] = useState<{ loading: boolean; error: string }>({ loading: false, error: '' });
  const ordersRef = useRef<Order[]>([]);
  ordersRef.current = orders;
  const vendorsRef = useRef<Vendor[]>([]);
  vendorsRef.current = vendors;
  const attentionTimer = useRef<number | undefined>(undefined);

  const handleAuthFailure = useCallback((error: unknown) => {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      clearAuthToken();
      setIsAuth(false);
      setAdminProfile(undefined);
    }
    setErrorMessage(error instanceof Error ? error.message : 'The operations request failed.');
  }, []);

  // Panels keep their own inline error message; this only logs the admin out when the session is no longer valid.
  const handleSessionError = useCallback((error: unknown) => {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      clearAuthToken();
      setIsAuth(false);
      setAdminProfile(undefined);
    }
  }, []);

  const refreshPendingCount = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      const result = await apiService.fetchApplications('PENDING');
      setPendingApplications(result.counts.PENDING);
    } catch { /* the badge is a nicety; the Applications tab shows real errors */ }
  }, []);

  const loadAttention = useCallback(async () => {
    if (!getAuthToken()) return;
    setAttention((current) => ({ ...current, loading: true }));
    try {
      const result = await apiService.fetchNeedsAttention();
      setAttention({ available: result.available, entries: result.entries, loading: false, error: '', checkedAt: Date.now() });
    } catch (error) {
      handleSessionError(error);
      setAttention((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : 'The needs-attention list could not be loaded.' }));
    }
  }, [handleSessionError]);

  /** Many socket events in a burst trigger one reload. */
  const scheduleAttention = useCallback(() => {
    window.clearTimeout(attentionTimer.current);
    attentionTimer.current = window.setTimeout(loadAttention, ATTENTION_DEBOUNCE_MS);
  }, [loadAttention]);

  /** Background poll: no spinner, no error banner (the live socket or the next poll catches up). */
  const silentRefresh = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      const page = await apiService.fetchOrderPage();
      setOrders((current) => mergeOrderLists(current, page.orders, { keepOlder: olderLoadedRef.current }));
      if (!olderLoadedRef.current) setHasMoreOrders(page.nextCursor !== null);
    } catch (error) {
      handleSessionError(error);
    }
    // Restaurants (open/closed, map pin) and the rider roster (duty) have no live event for every change: refetch them too,
    // and only replace the state when something really changed, so an idle poll re-renders nothing.
    apiService.fetchVendors()
      .then((fresh) => { if (busyVendorRef.current.size === 0) setVendors((current) => (sameData(current, fresh) ? current : fresh)); })
      .catch(() => { /* the next poll catches up */ });
    apiService.fetchDrivers()
      .then((fresh) => setDriverPartners((current) => (sameData(current, fresh) ? current : fresh)))
      .catch(() => { /* the next poll catches up */ });
    // Rider positions too: after a missed socket event the next poll puts every marker right again (no change = no re-render).
    apiService.fetchDriverLocations().then((fresh) => setDrivers((current) => replaceRiderPins(current, fresh))).catch(() => { /* the live socket or the next poll catches up */ });
    loadAttention();
  }, [handleSessionError, loadAttention]);

  const fetchBackendData = useCallback(async () => {
    if (!getAuthToken()) return;
    setIsLoading(true);
    setErrorMessage('');
    const results = await Promise.allSettled([
      apiService.fetchOrderPage(),
      apiService.fetchVendors(),
      apiService.fetchDrivers(),
      apiService.fetchDriverLocations(),
    ]);
    const [ordersResult, vendorsResult, driversResult, locationsResult] = results;
    if (ordersResult.status === 'fulfilled') {
      setOrders((current) => mergeOrderLists(current, ordersResult.value.orders, { keepOlder: olderLoadedRef.current }));
      if (!olderLoadedRef.current) setHasMoreOrders(ordersResult.value.nextCursor !== null);
    }
    if (vendorsResult.status === 'fulfilled') setVendors(vendorsResult.value);
    if (driversResult.status === 'fulfilled') setDriverPartners(driversResult.value);
    if (locationsResult.status === 'fulfilled') setDrivers((current) => replaceRiderPins(current, locationsResult.value));
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (firstError) handleAuthFailure(firstError.reason);
    setIsLoading(false);
    refreshPendingCount();
    loadAttention();
  }, [handleAuthFailure, refreshPendingCount, loadAttention]);

  // Check the stored session. Only a rejected token (401/403) ends it; if the server or network is down the token is
  // kept and the check retries with a growing delay, so a blip never throws away a valid 30-day session.
  useEffect(() => {
    if (!hasSession()) {
      setAuthChecking(false);
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    const check = (attempt: number) => {
      apiService.validateSession()
        .then((profile) => {
          if (cancelled || !getAuthToken()) return;
          setSessionUnreachable(false);
          setAdminProfile(profile);
          setIsAuth(true);
          setAuthChecking(false);
        })
        .catch((error) => {
          if (cancelled) return;
          if (isSessionRejected(error)) {
            clearAuthToken();
            handleAuthFailure(error);
            setSessionUnreachable(false);
            setAuthChecking(false);
            return;
          }
          setSessionUnreachable(true);
          timer = window.setTimeout(() => check(attempt + 1), sessionRetryDelayMs(attempt));
        });
    };
    check(0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [handleAuthFailure]);

  useEffect(() => {
    if (!isAuth) return undefined;
    fetchBackendData();

    const token = getAuthToken();
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      // Never give up: a server restart or a Wi-Fi outage of any length must heal by itself.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
    });
    let connectedBefore = false;
    socket.on('connect', () => {
      setIsLiveConnected(true);
      // The server answers join_room with { ok }; without the admins room no admin events arrive.
      socket.emit('join_room', 'admins', (reply: { ok?: boolean } | undefined) => {
        if (reply && reply.ok === false) {
          setIsLiveConnected(false);
          toast.error('Live updates refused', 'The server did not let this session join the admin room. Log in again.');
        }
      });
      // After a reconnect, events sent while we were offline are lost: catch up from REST.
      if (connectedBefore) silentRefresh();
      connectedBefore = true;
    });
    socket.on('disconnect', (reason: string) => {
      setIsLiveConnected(false);
      // socket.io does not retry after the server itself closed the connection: do it ourselves.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', () => setIsLiveConnected(false));
    // Same OrderView as REST (contract 2.1/3). Merge by updatedAt so an older event never rolls an order back.
    const applyLiveOrder = (rawOrder: unknown) => {
      const incoming = normalizeOrderPartial(rawOrder);
      if (!incoming.id) return;
      setOrders((previous) => upsertOrder(previous, incoming));
      setDrawerFallback((current) => mergeInto(current, incoming));
      scheduleAttention();
    };
    socket.on('order_updated', applyLiveOrder);
    socket.on('new_order_alert', (rawOrder: unknown) => {
      const incoming = normalizeOrderPartial(rawOrder);
      const isNew = Boolean(incoming.id) && !ordersRef.current.some((order) => order.id === incoming.id);
      applyLiveOrder(rawOrder);
      if (isNew) toast.info('New order', `${incoming.vendorName ?? 'A restaurant'} has a new paid order.`);
    });
    socket.on('partner_application', (info: { kind?: string; name?: string; resubmitted?: boolean }) => {
      const who = info?.kind === 'VENDOR' ? 'A restaurant' : 'A rider';
      toast.info(info?.resubmitted ? 'Application updated' : 'New application', `${who}${info?.name ? ` (${info.name})` : ''} is waiting for your approval.`);
      setApplicationsKey((key) => key + 1);
      refreshPendingCount();
    });
    socket.on('driver_duty_update', (update: { id?: string; dutyStatus?: DriverPartner['dutyStatus'] }) => {
      if (!update?.id || !update.dutyStatus) return;
      setDriverPartners((previous) => previous.map((driver) => driver.id === update.id ? { ...driver, dutyStatus: update.dutyStatus! } : driver));
    });
    socket.on('partner_application_updated', () => {
      setApplicationsKey((key) => key + 1);
      refreshPendingCount();
    });
    // Rider positions arrive every few seconds per rider. They are buffered and applied at most once a second
    // (newest fix per rider), so a busy hour never causes a render storm; unchanged riders keep their identity.
    let pendingLocations: DriverPin[] = [];
    let locationTimer: number | undefined;
    const flushLocations = () => {
      locationTimer = undefined;
      const batch = newestPerRider(pendingLocations);
      pendingLocations = [];
      setDrivers((previous) => mergeRiderPins(previous, batch));
    };
    socket.on('driver_location_update', (raw: unknown) => {
      const pin = normalizeDriverPin(raw);
      if (!pin) return;
      pendingLocations.push(pin);
      if (locationTimer === undefined) locationTimer = window.setTimeout(flushLocations, LOCATION_FLUSH_MS);
    });
    return () => {
      socket.disconnect();
      window.clearTimeout(attentionTimer.current);
      window.clearTimeout(locationTimer);
    };
  }, [fetchBackendData, isAuth, refreshPendingCount, toast, scheduleAttention, silentRefresh]);

  // Polling fallback while the page is visible, plus an immediate catch-up when the admin comes back to the tab.
  useEffect(() => {
    if (!isAuth) return undefined;
    const tick = () => { if (document.visibilityState === 'visible') silentRefresh(); };
    const poll = window.setInterval(tick, POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') { setNow(Date.now()); silentRefresh(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(poll); window.clearInterval(clock); document.removeEventListener('visibilitychange', onVisible); };
  }, [isAuth, silentRefresh]);

  /**
   * One optimistic order action: patch the order at once, call the server, then take the server's copy.
   * On failure only this order is rolled back (and only if no newer live update arrived meanwhile), and the
   * server's own message is shown.
   */
  const runOrderAction = async (
    orderId: string,
    optimistic: Partial<Order> | null,
    call: () => Promise<Order | null>,
    messages: { ok: (order: Order | null) => [string, string?, 'error'?]; fail: string },
    onError?: (message: string) => void,
  ): Promise<boolean> => {
    const snapshot = ordersRef.current.find((order) => order.id === orderId) ?? (drawerFallback?.id === orderId ? drawerFallback : null);
    if (optimistic) {
      setOrders((current) => patchOrder(current, orderId, optimistic));
      setDrawerFallback((current) => (current?.id === orderId ? { ...current, ...optimistic } : current));
    }
    try {
      let updated = await call();
      if (!updated) updated = await apiService.fetchOrder(orderId).catch(() => null);
      if (updated) {
        const fresh = updated;
        // Orders outside the loaded page live only in the drawer copy; do not push old orders into the live list.
        setOrders((current) => (current.some((order) => order.id === orderId) ? upsertOrder(current, fresh) : current));
        setDrawerFallback((current) => mergeInto(current, fresh));
      }
      setErrorMessage('');
      const [title, description, kind] = messages.ok(updated);
      if (kind === 'error') toast.error(title, description); else toast.success(title, description);
      return true;
    } catch (error) {
      if (snapshot) {
        setOrders((current) => restoreIfUntouched(current, snapshot));
        setDrawerFallback((current) => (current?.id === orderId ? restoreIfUntouched([current], snapshot)[0] : current));
      }
      if (error instanceof ActionCancelled) return false; // the admin said no: nothing failed
      handleSessionError(error);
      const message = error instanceof Error ? error.message : 'Please try again.';
      toast.error(messages.fail, message);
      onError?.(message);
      return false;
    } finally {
      scheduleAttention();
    }
  };

  const handleStatusChange = (orderId: string, status: OrderStatus, otpCode?: string) => runOrderAction(
    orderId,
    { status },
    () => apiService.updateOrderStatus(orderId, status, otpCode),
    { ok: (updated) => ['Order updated', `Now ${ORDER_STATUS_LABEL[updated?.status ?? status] ?? status}.`], fail: 'Status not changed' },
  );

  const askAssignOffline = (name?: string) => confirm({
    title: name ? `Assign ${name}?` : 'Assign this rider?',
    message: 'This rider is offline. Assign anyway?',
    confirmLabel: 'Assign anyway',
  });

  const handleReassignDriver = async (orderId: string, driverId: string | null) => {
    const rider = driverId ? driverPartners.find((driver) => driver.id === driverId) : undefined;
    // The roster already says offline: ask before anything changes on screen.
    let force = false;
    if (driverId && rider?.dutyStatus === 'OFFLINE') {
      if (!(await askAssignOffline(rider.name))) return false;
      force = true;
    }
    return runOrderAction(
      orderId,
      { driverId: driverId ? rider?.userId ?? driverId : undefined, driverName: driverId ? rider?.name ?? 'Updating assignment…' : undefined, driverPhone: driverId ? rider?.phone : undefined },
      async () => {
        try {
          return await apiService.reassignOrderDriver(orderId, driverId, force);
        } catch (error) {
          // The roster was out of date and the server knows the rider is offline: same question, then resend with force.
          if (driverId && !force && error instanceof ApiError && error.code === 'RIDER_OFFLINE') {
            if (!(await askAssignOffline(rider?.name))) throw new ActionCancelled();
            try { return await apiService.reassignOrderDriver(orderId, driverId, true); } catch (second) { throw plainReassignError(second); }
          }
          throw plainReassignError(error);
        }
      },
      { ok: (updated) => [driverId ? 'Rider assigned' : 'Rider unassigned', updated?.driverName ? `${updated.driverName} is on this order.` : undefined], fail: 'Rider not changed' },
    );
  };

  const handleCancelOrder = async (orderId: string, reason: string): Promise<string | null> => {
    const paid = (ordersRef.current.find((order) => order.id === orderId) ?? drawerFallback)?.paymentStatus === 'PAID';
    let failure: string | null = null;
    await runOrderAction(
      orderId,
      { status: 'CANCELLED', cancelledBy: 'ADMIN', cancelReason: reason, cancelledAt: new Date().toISOString() },
      () => apiService.cancelOrder(orderId, reason),
      {
        ok: (updated) => ['Order cancelled', updated?.refundStatus === 'FAILED'
          ? 'The refund failed. It is listed under Needs attention and retried automatically.'
          : paid ? 'The customer is being refunded automatically.' : 'No payment was captured, nothing to refund.'],
        fail: 'Order not cancelled',
      },
      (message) => { failure = message; },
    );
    return failure;
  };

  const handleResetOtpLock = (orderId: string) => runOrderAction(
    orderId,
    { otpLocked: false, otpAttempts: 0 },
    () => apiService.resetOtpLock(orderId),
    { ok: () => ['OTP lock reset', 'The customer got a new gate code; the rider can try again.'], fail: 'OTP lock not reset' },
  );

  // No optimistic patch: whether the refund now succeeds is only known from the server's answer.
  const handleRetryRefund = (orderId: string) => runOrderAction(
    orderId,
    null,
    () => apiService.retryRefund(orderId),
    {
      ok: (updated) => (updated?.refundStatus === 'DONE' || updated?.paymentStatus === 'REFUNDED'
        ? ['Refund done', 'The customer has been refunded.']
        : updated?.refundStatus === 'FAILED'
          ? ['Refund failed again', updated.refundError ?? 'Razorpay refused it again. Check the payment in Razorpay.', 'error']
          : ['Refund retried', 'The refund is in progress.']),
      fail: 'Refund not retried',
    },
  );

  const openOrder = useCallback((orderId: string, mode: DrawerMode = 'view', fallback?: Order | null) => {
    setDrawer({ id: orderId, mode });
    if (ordersRef.current.some((order) => order.id === orderId)) {
      setDrawerFallback(null);
      setDrawerLoad({ loading: false, error: '' });
      return;
    }
    // Not in the loaded page (e.g. an old order from the needs-attention list): show what we have, then load it.
    setDrawerFallback(fallback ?? null);
    setDrawerLoad({ loading: true, error: '' });
    apiService.fetchOrder(orderId)
      .then((order) => { setDrawerFallback((current) => (current && current.id === orderId ? mergeInto(current, order) : order)); setDrawerLoad({ loading: false, error: '' }); })
      .catch((error) => { handleSessionError(error); setDrawerLoad({ loading: false, error: error instanceof Error ? error.message : 'This order could not be loaded.' }); });
  }, [handleSessionError]);

  const closeDrawer = useCallback(() => { setDrawer(null); setDrawerFallback(null); setDrawerLoad({ loading: false, error: '' }); }, []);
  const setDrawerMode = useCallback((mode: DrawerMode) => setDrawer((current) => (current ? { ...current, mode } : current)), []);

  const setVendorBusy = (vendorId: string, busy: boolean) => {
    if (busy) busyVendorRef.current.add(vendorId); else busyVendorRef.current.delete(vendorId);
    setBusyVendorIds(new Set(busyVendorRef.current));
  };

  const handleToggleVendor = async (vendorId: string) => {
    if (busyVendorRef.current.has(vendorId)) return; // one request at a time per restaurant
    const first = vendorsRef.current.find((vendor) => vendor.id === vendorId);
    if (!first) return;
    if (first.isAcceptingOrders) {
      const ok = await confirm({
        title: `Close ${first.name}?`,
        message: 'Customers cannot place new orders with this restaurant until it is opened again.',
        confirmLabel: 'Close restaurant',
        danger: true,
      });
      if (!ok) return;
    }
    if (busyVendorRef.current.has(vendorId)) return;
    const target = vendorsRef.current.find((vendor) => vendor.id === vendorId);
    if (!target) return;
    setVendorBusy(vendorId, true);
    const wasAccepting = target.isAcceptingOrders;
    const nextStatus = !wasAccepting;
    setVendors((current) => current.map((vendor) => vendor.id === vendorId ? { ...vendor, isAcceptingOrders: nextStatus } : vendor));
    try {
      const updated = await apiService.toggleVendorStatus(vendorId, nextStatus);
      setVendors((current) => current.map((vendor) => vendor.id === vendorId ? updated : vendor));
      toast.success(updated.isAcceptingOrders ? 'Vendor is open' : 'Vendor is closed', `${updated.name} is ${updated.isAcceptingOrders ? 'now accepting' : 'no longer accepting'} orders.`);
    } catch (error) {
      // Put back only this restaurant's switch: a pin saved meanwhile must not be undone.
      setVendors((current) => current.map((vendor) => vendor.id === vendorId ? { ...vendor, isAcceptingOrders: wasAccepting } : vendor));
      handleAuthFailure(error);
    } finally {
      setVendorBusy(vendorId, false);
    }
  };

  const handleLoadOlder = async () => {
    const cursor = oldestOrderId(ordersRef.current);
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await apiService.fetchOrderPage(cursor, OLDER_PAGE_SIZE);
      olderLoadedRef.current = true;
      setOrders((current) => appendOlderPage(current, page.orders));
      setHasMoreOrders(page.nextCursor !== null);
      if (page.orders.length === 0) toast.info('No older orders', 'Every order is already loaded.');
    } catch (error) {
      handleSessionError(error);
      toast.error('Older orders not loaded', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleVendorLocationSaved = useCallback((vendorId: string, saved: SavedPin) => {
    setVendors((current) => current.map((vendor) => vendor.id === vendorId ? { ...vendor, lat: saved.lat, lng: saved.lng, hasLocation: saved.hasLocation, locationSource: saved.locationSource, locationSetAt: saved.locationSetAt, locationAccuracyM: saved.locationAccuracyM } : vendor));
  }, []);

  const handleLogout = () => {
    clearAuthToken();
    setIsAuth(false);
    setAdminProfile(undefined);
    setOrders([]);
    setVendors([]);
    setDriverPartners([]);
    setDrivers([]);
    setPendingApplications(0);
    olderLoadedRef.current = false;
    setHasMoreOrders(false);
    setAttention({ available: null, entries: [], loading: false, error: '', checkedAt: null });
    closeDrawer();
    setSearchQuery('');
    setMobileNavOpen(false);
  };

  const handleSelectTab = useCallback((tab: TabType) => {
    setActiveTab(tab);
    setSearchQuery('');
  }, []);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  // Server list when available; otherwise what the dashboard can detect itself (clearly labelled in the panel).
  // Embedded order copies are replaced by the live ones so the list never shows a stale status.
  const attentionEntries = useMemo<AttentionEntry[]>(() => {
    const byId = new Map(orders.map((order) => [order.id, order]));
    const base = attention.available === false ? localAttention(orders, now) : attention.entries;
    return pruneWithLiveOrders(base.map((entry) => (entry.orderId && byId.has(entry.orderId) ? { ...entry, order: byId.get(entry.orderId)! } : entry)));
  }, [attention.available, attention.entries, orders, now]);
  const locationGaps = useMemo(() => vendorsNeedingLocation(vendors), [vendors]);
  const attentionIds = useMemo(() => new Set(attentionEntries.map((entry) => entry.orderId).filter((id): id is string => Boolean(id))), [attentionEntries]);
  const drawerOrder = drawer ? orders.find((order) => order.id === drawer.id) ?? (drawerFallback?.id === drawer.id ? drawerFallback : null) : null;
  const drawerEntry = drawer ? attentionEntries.find((entry) => entry.orderId === drawer.id) : undefined;

  if (authChecking) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-kraveo-night" role="status" aria-live="polite">
        <div className="animate-scale-in"><LogoMark size={64} /></div>
        <p className="flex items-center gap-2 text-sm font-semibold text-kraveo-ink2"><RefreshCw className="h-4 w-4 animate-spin text-kraveo-g400" aria-hidden="true" />{sessionUnreachable ? 'Cannot reach the server, retrying…' : 'Verifying admin session…'}</p>
        {sessionUnreachable && (
          <button type="button" className="k-btn-ghost !min-h-[36px] text-xs" onClick={() => { clearAuthToken(); setSessionUnreachable(false); setAuthChecking(false); }}>Sign in again instead</button>
        )}
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
        badges={{ orders: activeOrderCount, attention: attentionEntries.length + locationGaps.length, applications: pendingApplications }}
        alertBadges={{ attention: true }}
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
            {activeTab === 'map' && <LiveCommandCenter drivers={drivers} orders={orders} driverPartners={driverPartners} vendors={vendors} onReassignDriver={handleReassignDriver} onOpenOrder={openOrder} loading={isLoading} query={searchQuery} />}
            {activeTab === 'orders' && <OrdersTable orders={orders} attentionIds={attentionIds} onAdvance={handleStatusChange} onOpenOrder={openOrder} loading={isLoading} query={searchQuery} onClearQuery={clearQuery} now={now} hasMore={hasMoreOrders} loadingOlder={loadingOlder} onLoadOlder={handleLoadOlder} />}
            {activeTab === 'attention' && (
              <NeedsAttentionPanel
                entries={attentionEntries}
                locationGaps={locationGaps}
                onOpenVendors={() => handleSelectTab('vendors')}
                serverAvailable={attention.available}
                loading={attention.loading}
                error={attention.error}
                checkedAt={attention.checkedAt}
                onRefresh={loadAttention}
                onOpenOrder={openOrder}
                onResetOtpLock={handleResetOtpLock}
                onRetryRefund={handleRetryRefund}
                query={searchQuery}
                onClearQuery={clearQuery}
              />
            )}
            {activeTab === 'applications' && <ApplicationsPanel refreshKey={applicationsKey} query={searchQuery} onChanged={fetchBackendData} onAuthError={handleSessionError} onLocationSaved={handleVendorLocationSaved} />}
            {activeTab === 'vendors' && <VendorManager vendors={vendors} orders={orders} busyVendorIds={busyVendorIds} onToggleVendor={handleToggleVendor} onLocationSaved={handleVendorLocationSaved} onCreated={fetchBackendData} loading={isLoading} query={searchQuery} onClearQuery={clearQuery} />}
            {activeTab === 'drivers' && <DriverManager drivers={driverPartners} orders={orders} now={now} onCreated={fetchBackendData} loading={isLoading} query={searchQuery} onClearQuery={clearQuery} />}
            {activeTab === 'customers' && <CustomersPanel query={searchQuery} onClearQuery={clearQuery} onAuthError={handleSessionError} />}
            {activeTab === 'analytics' && <AnalyticsPanel />}
          </div>
        </main>
      </div>
      <OrderDrawer
        order={drawerOrder}
        loading={Boolean(drawer) && !drawerOrder && drawerLoad.loading}
        loadError={drawer && !drawerOrder ? drawerLoad.error : ''}
        mode={drawer?.mode ?? 'view'}
        onModeChange={setDrawerMode}
        onClose={closeDrawer}
        riders={driverPartners}
        problems={drawerEntry?.problems ?? []}
        hint={drawerEntry?.hint}
        onAdvance={handleStatusChange}
        onReassign={handleReassignDriver}
        onCancel={handleCancelOrder}
        onResetOtpLock={handleResetOtpLock}
        onRetryRefund={handleRetryRefund}
      />
      {confirmDialog}
    </div>
  );
};
