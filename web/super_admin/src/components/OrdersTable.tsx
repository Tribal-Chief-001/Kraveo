import React, { useState } from 'react';
import { Order, OrderStatus } from '../types';
import { Search, Filter, Phone, CheckCircle, Clock, AlertTriangle, ShieldCheck } from 'lucide-react';

interface OrdersTableProps {
  orders: Order[];
  onStatusChange: (orderId: string, status: OrderStatus) => void;
}

export const OrdersTable: React.FC<OrdersTableProps> = ({ orders, onStatusChange }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const filteredOrders = orders.filter((o) => {
    const matchesSearch = 
      o.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      o.customerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      o.vendorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      o.dropoffHostel.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = statusFilter === 'ALL' || o.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case 'PLACED': return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
      case 'ACCEPTED': return 'bg-purple-500/10 text-purple-400 border-purple-500/30';
      case 'PREPARING': return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'PICKED_UP': return 'bg-orange-500/10 text-orange-400 border-orange-500/30';
      case 'ARRIVED_AT_GATE': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 animate-pulse';
      case 'DELIVERED': return 'bg-green-500/10 text-green-400 border-green-500/30';
      case 'CANCELLED': return 'bg-red-500/10 text-red-400 border-red-500/30';
      default: return 'bg-gray-500/10 text-gray-400 border-gray-500/30';
    }
  };

  return (
    <div className="glass-card rounded-2xl p-6 space-y-6 border border-[#242F46]">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-orange-500" /> Kraveo Order Command Matrix
          </h2>
          <p className="text-xs text-gray-400">Manage real-time order states, driver dispatches, and gate deliveries</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Search Input */}
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
            <input
              type="text"
              placeholder="Search ID, Student, Dhaba, Hostel..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="bg-[#0B0F19] border border-[#242F46] rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 w-64"
            />
          </div>

          {/* Status Filter */}
          <div className="flex items-center gap-2 bg-[#0B0F19] border border-[#242F46] rounded-xl px-3 py-2 text-xs text-gray-300">
            <Filter className="w-4 h-4 text-orange-500" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-transparent focus:outline-none text-white font-medium cursor-pointer"
            >
              <option value="ALL">All Statuses</option>
              <option value="PLACED">Placed</option>
              <option value="PREPARING">Preparing</option>
              <option value="PICKED_UP">Picked Up</option>
              <option value="ARRIVED_AT_GATE">Arrived at Gate</option>
              <option value="DELIVERED">Delivered</option>
            </select>
          </div>
        </div>
      </div>

      {/* Orders High-Density Matrix Table */}
      <div className="overflow-x-auto rounded-xl border border-[#242F46]">
        <table className="w-full text-left text-xs">
          <thead className="bg-[#0B0F19] text-gray-400 uppercase font-bold tracking-wider border-b border-[#242F46]">
            <tr>
              <th className="px-4 py-3">Order ID</th>
              <th className="px-4 py-3">Student & Hostel Dropoff</th>
              <th className="px-4 py-3">Highway Dhaba</th>
              <th className="px-4 py-3">Assigned Runner</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Quick Override</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#242F46]/60 text-gray-200 font-medium">
            {filteredOrders.map((ord) => (
              <tr key={ord.id} className="hover:bg-[#151C2C]/80 transition-colors">
                <td className="px-4 py-3.5 font-mono font-bold text-orange-400">{ord.id}</td>
                <td className="px-4 py-3.5">
                  <div className="font-bold text-white">{ord.customerName}</div>
                  <div className="text-[11px] text-emerald-400 flex items-center gap-1">
                    📍 {ord.dropoffHostel}
                  </div>
                </td>
                <td className="px-4 py-3.5 text-gray-300 font-semibold">{ord.vendorName}</td>
                <td className="px-4 py-3.5">
                  {ord.driverName ? (
                    <span className="text-amber-400 font-semibold flex items-center gap-1">
                      <Phone className="w-3 h-3 text-gray-400" /> {ord.driverName}
                    </span>
                  ) : (
                    <span className="text-gray-500 italic">Unassigned</span>
                  )}
                </td>
                <td className="px-4 py-3.5 font-bold text-white">₹{ord.totalAmount}</td>
                <td className="px-4 py-3.5">
                  <span className={`px-2.5 py-1 rounded-full border text-[11px] font-bold ${getStatusBadge(ord.status)}`}>
                    {ord.status}
                  </span>
                </td>
                <td className="px-4 py-3.5 text-right">
                  <select
                    value={ord.status}
                    onChange={(e) => onStatusChange(ord.id, e.target.value as OrderStatus)}
                    className="bg-[#0B0F19] text-gray-200 border border-[#242F46] rounded-lg px-2 py-1 text-[11px] font-bold focus:border-orange-500 cursor-pointer"
                  >
                    <option value="PLACED">Set PLACED</option>
                    <option value="PREPARING">Set PREPARING</option>
                    <option value="PICKED_UP">Set PICKED UP</option>
                    <option value="ARRIVED_AT_GATE">Set ARRIVED AT GATE</option>
                    <option value="DELIVERED">Set DELIVERED</option>
                    <option value="CANCELLED">Set CANCELLED</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
