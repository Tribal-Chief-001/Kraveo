/// <reference types="vite/client" />
import {
  AdminProfile,
  AnalyticsData,
  DriverPartner,
  DriverPin,
  Order,
  OrderStatus,
  Vendor,
  normalizeDriver,
  normalizeOrder,
  normalizeVendor,
} from '../types';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? window.location.origin : 'http://localhost:5000');
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || (import.meta.env.PROD ? window.location.origin : 'http://localhost:5000');

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export const getAuthToken = (): string => localStorage.getItem('kraveo_admin_token') || '';

export const setAuthToken = (token: string, adminProfile?: AdminProfile) => {
  localStorage.setItem('kraveo_admin_token', token.replace(/^Bearer\s+/i, ''));
  if (adminProfile) localStorage.setItem('kraveo_admin_profile', JSON.stringify(adminProfile));
};

export const clearAuthToken = () => {
  localStorage.removeItem('kraveo_admin_token');
  localStorage.removeItem('kraveo_admin_profile');
};

export const isAuthenticated = (): boolean => getAuthToken().trim().length > 10;

const getHeaders = (extraHeaders: Record<string, string> = {}) => {
  const token = getAuthToken().replace(/^Bearer\s+/i, '');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  };
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { ...getHeaders(), ...(init.headers || {}) },
    });
  } catch {
    throw new ApiError(0, 'The operations API is unreachable. Check the network connection and try again.');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, body?.message || `Request failed (${response.status}).`);
  }
  return body?.data ?? body;
}

export const apiService = {
  async adminLogin(passcode: string, username?: string): Promise<{ token: string; admin: AdminProfile }> {
    if (!passcode.trim()) throw new ApiError(400, 'Please enter the admin passcode.');
    const response = await request<{ token: string; admin: AdminProfile }>('/api/auth/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: passcode.trim(), username: username?.trim() || 'Campus Dispatch Admin' }),
    });
    if (!response?.token || response.admin?.role !== 'ADMIN') throw new ApiError(401, 'The server did not return a valid admin session.');
    setAuthToken(response.token, response.admin);
    return response;
  },

  async validateSession(): Promise<AdminProfile> {
    const profile = await request<any>('/api/auth/profile');
    const user = profile?.user || profile;
    if (user?.role !== 'ADMIN') throw new ApiError(403, 'This session is not authorized for the admin console.');
    return { id: user.id, name: user.name, phone: user.phone, role: 'ADMIN' };
  },

  async fetchOrders(): Promise<Order[]> {
    const data = await request<any[]>('/api/orders');
    return (Array.isArray(data) ? data : []).map(normalizeOrder);
  },

  async fetchVendors(): Promise<Vendor[]> {
    const data = await request<any[]>('/api/vendors');
    return (Array.isArray(data) ? data : []).map(normalizeVendor);
  },

  async fetchDrivers(): Promise<DriverPartner[]> {
    const data = await request<any[]>('/api/drivers');
    return (Array.isArray(data) ? data : []).map(normalizeDriver);
  },

  async fetchDriverLocations(): Promise<DriverPin[]> {
    const data = await request<any[]>('/api/drivers/locations');
    return (Array.isArray(data) ? data : []).map((location: any) => ({
      id: location.driverId,
      name: location.driverName || 'Runner',
      lat: Number(location.lat),
      lng: Number(location.lng),
      heading: Number(location.heading || 0),
      status: 'DELIVERING_GATE',
      lastUpdated: location.lastUpdated,
    }));
  },

  async fetchAnalytics(range: 'today' | '7d' | '30d' = '7d'): Promise<AnalyticsData> {
    return request<AnalyticsData>(`/api/analytics?range=${range}`);
  },

  async updateOrderStatus(orderId: string, status: OrderStatus, otpCode?: string): Promise<Order> {
    return normalizeOrder(await request<any>(`/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...(otpCode ? { otpCode } : {}) }),
    }));
  },

  async toggleVendorStatus(vendorId: string, isAcceptingOrders: boolean): Promise<Vendor> {
    return normalizeVendor(await request<any>(`/api/vendors/${encodeURIComponent(vendorId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ isAcceptingOrders }),
    }));
  },

  async createVendor(vendor: Pick<Vendor, 'name' | 'category' | 'address' | 'lat' | 'lng'>): Promise<Vendor> {
    return normalizeVendor(await request<any>('/api/vendors', {
      method: 'POST',
      body: JSON.stringify(vendor),
    }));
  },

  async reassignOrderDriver(orderId: string, driverId: string | null): Promise<Order> {
    return normalizeOrder(await request<any>(`/api/orders/${encodeURIComponent(orderId)}/reassign`, {
      method: 'PATCH',
      body: JSON.stringify({ driverId }),
    }));
  },
};
