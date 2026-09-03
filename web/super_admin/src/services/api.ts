/// <reference types="vite/client" />
import { Order, Vendor, DriverPartner, OrderStatus } from '../types';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? 'http://3.110.189.80' : 'http://localhost:5000');
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || API_BASE_URL;

export const getAuthToken = (): string => {
  return localStorage.getItem('kraveo_admin_token') || '';
};

export const setAuthToken = (token: string, adminProfile?: any) => {
  localStorage.setItem('kraveo_admin_token', token);
  if (adminProfile) {
    localStorage.setItem('kraveo_admin_profile', JSON.stringify(adminProfile));
  }
};

export const clearAuthToken = () => {
  localStorage.removeItem('kraveo_admin_token');
  localStorage.removeItem('kraveo_admin_profile');
};

export const isAuthenticated = (): boolean => {
  const token = localStorage.getItem('kraveo_admin_token');
  return Boolean(token && token.trim().length > 10);
};

const getHeaders = (extraHeaders: Record<string, string> = {}) => {
  const token = getAuthToken();
  const authHeader = token ? (token.startsWith('Bearer ') ? token : `Bearer ${token}`) : '';
  return {
    'Content-Type': 'application/json',
    ...(authHeader ? { 'Authorization': authHeader } : {}),
    ...extraHeaders,
  };
};

export const apiService = {
  async adminLogin(passcode: string, username?: string): Promise<{ token: string; admin: any }> {
    const res = await fetch(`${API_BASE_URL}/api/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode, username: username || 'Campus Dispatch Admin' }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error(json.message || 'Invalid admin passcode.');
    }
    setAuthToken(json.token, json.admin);
    return json;
  },
  async fetchOrders(): Promise<Order[]> {
    const res = await fetch(`${API_BASE_URL}/api/orders`, {
      headers: getHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to fetch orders: ${res.statusText}`);
    const json = await res.json();
    return json.data || json;
  },

  async fetchVendors(): Promise<Vendor[]> {
    const res = await fetch(`${API_BASE_URL}/api/vendors`, {
      headers: getHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to fetch vendors: ${res.statusText}`);
    const json = await res.json();
    return json.data || json;
  },

  async fetchDrivers(): Promise<DriverPartner[]> {
    const res = await fetch(`${API_BASE_URL}/api/drivers`, {
      headers: getHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to fetch drivers: ${res.statusText}`);
    const json = await res.json();
    return json.data || json;
  },

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`Failed to update order status: ${res.statusText}`);
  },

  async toggleVendorStatus(vendorId: string, isAcceptingOrders: boolean): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/api/vendors/${vendorId}/status`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ isAcceptingOrders }),
    });
    if (!res.ok) throw new Error(`Failed to toggle vendor status: ${res.statusText}`);
  },

  async createVendor(vendor: Omit<Vendor, 'id'>): Promise<Vendor> {
    const res = await fetch(`${API_BASE_URL}/api/vendors`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(vendor),
    });
    if (!res.ok) throw new Error(`Failed to onboard vendor: ${res.statusText}`);
    const json = await res.json();
    return json.data || json;
  },

  async reassignOrderDriver(orderId: string, driverId?: string): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/api/orders/${orderId}/reassign`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ driverId }),
    });
    if (!res.ok) throw new Error(`Failed to reassign driver: ${res.statusText}`);
  }
};
