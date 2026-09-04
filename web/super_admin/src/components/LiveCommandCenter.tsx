import React from 'react';
import { DriverPartner, DriverPin, Order } from '../types';
import { Navigation, Bike, ShieldAlert, Clock, MapPinned } from 'lucide-react';

interface LiveCommandCenterProps {
  drivers: DriverPin[];
  orders: Order[];
  driverPartners: DriverPartner[];
  onReassignDriver: (orderId: string, driverId: string | null) => void;
}

const projectCoordinate = (lat: number, lng: number) => ({
  top: `${Math.max(8, Math.min(88, 50 - (lat - 23.0768) * 900))}%`,
  left: `${Math.max(6, Math.min(94, 50 + (lng - 76.8524) * 650))}%`,
});

export const LiveCommandCenter: React.FC<LiveCommandCenterProps> = ({ drivers, orders, driverPartners, onReassignDriver }) => {
  const activeOrders = orders.filter((order) => !['DELIVERED', 'CANCELLED'].includes(order.status));
  const gateWaiting = orders.filter((order) => order.status === 'ARRIVED_AT_GATE').length;
  const unassigned = activeOrders.filter((order) => !order.driverId).length;
  const cards = [
    { label: 'Active deliveries', value: activeOrders.length, note: 'Current non-terminal orders', Icon: Bike, color: 'text-[#fdd400]' },
    { label: 'Tracked runners', value: drivers.length, note: drivers.length ? 'Latest persisted GPS locations' : 'No location feed received', Icon: Navigation, color: 'text-[#91d78a]' },
    { label: 'Unassigned orders', value: unassigned, note: unassigned ? 'Needs dispatch attention' : 'All active orders assigned', Icon: MapPinned, color: unassigned ? 'text-amber-400' : 'text-[#91d78a]' },
    { label: 'Awaiting gate handoff', value: gateWaiting, note: gateWaiting ? 'OTP verification required' : 'No gate handoffs pending', Icon: ShieldAlert, color: gateWaiting ? 'text-[#fdd400]' : 'text-gray-500' },
  ];

  return <div className="space-y-6">
    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
      {cards.map(({ label, value, note, Icon, color }) => <div key={label} className="stitch-card rounded-2xl border border-[#242f46] p-4 space-y-1"><div className="text-xs font-bold uppercase tracking-wider text-gray-400">{label}</div><div className="flex items-center justify-between text-2xl font-black text-white"><span>{value}</span><Icon className={`h-6 w-6 ${color}`} /></div><p className="text-[11px] text-gray-400">{note}</p></div>)}
    </div>

    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="stitch-card relative flex h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl border border-[#242f46] p-4 lg:col-span-2">
        <div className="z-10 flex items-center justify-between rounded-xl border border-[#242f46] bg-[#1b1c1c]/90 p-3 backdrop-blur-md"><div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[#91d78a]"/><span className="text-sm font-bold text-white">Live coordinate view</span></div><span className="text-xs text-gray-400">VIT Bhopal region</span></div>
        <div className="absolute inset-0 bg-[#1b1c1c] pt-16"><div className="absolute inset-0 opacity-40 [background-image:linear-gradient(#242f46_1px,transparent_1px),linear-gradient(90deg,#242f46_1px,transparent_1px)] [background-size:48px_48px]"/><div className="absolute inset-x-8 top-1/2 border-t border-dashed border-[#fdd400]/30"/><div className="absolute inset-y-16 left-1/2 border-l border-dashed border-[#fdd400]/30"/>
          {drivers.map((driver) => <div key={driver.id} style={projectCoordinate(driver.lat, driver.lng)} className="absolute -translate-x-1/2 -translate-y-1/2" title={`${driver.name} · ${driver.lat.toFixed(5)}, ${driver.lng.toFixed(5)}`}><div className="flex items-center gap-1 rounded-full border border-[#91d78a]/40 bg-[#00450d] px-2 py-1 text-[10px] font-bold text-white shadow-xl"><Bike className="h-3.5 w-3.5 text-[#fdd400]"/>{driver.name}</div><div className="mx-auto mt-1 h-2 w-2 rounded-full bg-[#91d78a] shadow-[0_0_12px_#91d78a]"/></div>)}
          {drivers.length === 0 && <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-gray-500">No driver coordinates are currently available. The map will populate when the authenticated location feed reports a position.</div>}
        </div>
        <div className="z-10 mt-auto flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#242f46] bg-[#1b1c1c]/90 p-3 text-xs text-gray-400 backdrop-blur-md"><span>Markers use the latest stored latitude/longitude.</span><span className="text-[#91d78a]">{drivers.length} location{drivers.length === 1 ? '' : 's'} received</span></div>
      </div>

      <div className="stitch-card flex h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl border border-[#242f46] p-4"><div className="mb-3 flex items-center justify-between border-b border-[#242f46] pb-3"><h3 className="flex items-center gap-2 text-sm font-bold text-white"><Clock className="h-4 w-4 text-[#fdd400]"/> Live delivery pipeline ({activeOrders.length})</h3><span className="rounded-full border border-[#91d78a]/30 bg-[#00450d] px-2.5 py-0.5 text-[10px] font-bold text-[#91d78a]">API feed</span></div>
        <div className="space-y-3 overflow-y-auto pr-1">{activeOrders.length === 0 && <div className="py-12 text-center text-sm text-gray-500">No active deliveries.</div>}{activeOrders.map((order) => <div key={order.id} className="space-y-2 rounded-xl border border-[#242f46] bg-[#1b1c1c] p-3"><div className="flex items-center justify-between"><span className="font-mono text-xs font-bold text-[#fdd400]">{order.id}</span><span className="rounded-full border border-[#fdd400]/30 bg-[#fdd400]/10 px-2 py-0.5 text-[10px] font-bold text-[#fdd400]">{order.status}</span></div><div className="text-xs font-bold text-gray-200">{order.vendorName}</div><div className="flex items-center justify-between text-[11px] text-gray-400"><span>📍 {order.dropoffHostel}</span><span className="font-bold text-white">₹{order.totalAmount.toLocaleString('en-IN')}</span></div><div className="flex items-center justify-between border-t border-[#242f46] pt-2 text-[11px]"><span className="text-gray-400">Runner: <strong className="text-white">{order.driverName || 'Unassigned'}</strong></span><select aria-label={`Assign runner for ${order.id}`} value="" onChange={(event) => onReassignDriver(order.id, event.target.value || null)} className="max-w-[9rem] rounded-lg border border-[#242f46] bg-[#0B0F19] px-2 py-1 text-[10px] font-bold text-gray-200"><option value="">{order.driverName ? 'Change runner' : 'Assign runner'}</option>{driverPartners.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}</select></div></div>)}</div>
      </div>
    </div>
  </div>;
};
