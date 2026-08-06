import React, { useState } from 'react';
import { Vendor } from '../types';
import { Store, Star, ToggleLeft, ToggleRight, MapPin, Plus, X } from 'lucide-react';

interface VendorManagerProps {
  vendors: Vendor[];
  onToggleVendor: (vendorId: string) => void;
}

export const VendorManager: React.FC<VendorManagerProps> = ({ vendors, onToggleVendor }) => {
  const [showModal, setShowModal] = useState(false);
  const [dhabaName, setDhabaName] = useState('');
  const [category, setCategory] = useState('North Indian • Parathas');
  const [address, setAddress] = useState('Ashta Highway, km 2.0');
  const [dhabaList, setDhabaList] = useState<Vendor[]>(vendors);

  const handleCreateDhaba = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dhabaName.trim()) return;

    const newVendor: Vendor = {
      id: `ven-${Date.now()}`,
      name: dhabaName,
      category,
      rating: 4.8,
      isAcceptingOrders: true,
      activeOrdersCount: 0,
      address,
    };

    setDhabaList([newVendor, ...dhabaList]);
    setShowModal(false);
    setDhabaName('');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Store className="w-5 h-5 text-[#fdd400]" /> Dhaba & Vendor Network Manager
          </h2>
          <p className="text-xs text-gray-400">Manage highway dhabas, menu listings, and operational status</p>
        </div>
        <button 
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-[#00450d] hover:bg-[#1b5e20] text-white rounded-xl font-bold text-xs flex items-center gap-1.5 border border-[#91d78a]/30 shadow-lg transition-all"
        >
          <Plus className="w-4 h-4 text-[#fdd400]" /> Onboard New Dhaba
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {dhabaList.map((v) => (
          <div key={v.id} className="stitch-card rounded-2xl p-5 border border-[#242f46] space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-extrabold text-white text-base">{v.name}</h3>
                <p className="text-xs text-[#fdd400] font-medium">{v.category}</p>
              </div>
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#fdd400]/10 text-[#fdd400] text-xs font-bold border border-[#fdd400]/30">
                <Star className="w-3.5 h-3.5 fill-[#fdd400]" /> {v.rating}
              </span>
            </div>

            <div className="text-xs text-gray-400 flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5 text-gray-500" /> {v.address}
            </div>

            <div className="pt-3 border-t border-[#242f46] flex items-center justify-between">
              <div>
                <div className="text-[10px] text-gray-400 uppercase font-bold">Accepting Orders</div>
                <div className={`text-xs font-bold ${v.isAcceptingOrders ? 'text-[#91d78a]' : 'text-red-400'}`}>
                  {v.isAcceptingOrders ? 'OPEN FOR ORDERS' : 'CLOSED'}
                </div>
              </div>

              <button
                onClick={() => onToggleVendor(v.id)}
                className="flex items-center gap-1 text-gray-300 hover:text-white font-bold text-xs bg-[#1b1c1c] px-3 py-1.5 rounded-xl border border-[#242f46]"
              >
                {v.isAcceptingOrders ? (
                  <ToggleRight className="w-6 h-6 text-[#91d78a]" />
                ) : (
                  <ToggleLeft className="w-6 h-6 text-red-500" />
                )}
                <span>Toggle Status</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Modal Drawer for Onboarding New Dhaba */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="stitch-card bg-[#151c2c] border border-[#242f46] rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#242f46] pb-3">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Store className="w-5 h-5 text-[#fdd400]" /> Onboard New Highway Dhaba
              </h3>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateDhaba} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-gray-300 block mb-1">Dhaba / Mess Name</label>
                <input 
                  type="text" 
                  value={dhabaName}
                  onChange={(e) => setDhabaName(e.target.value)}
                  placeholder="e.g. Rajputana Highway Dhaba"
                  required
                  className="w-full bg-[#1b1c1c] border border-[#242f46] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-[#fdd400]"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-gray-300 block mb-1">Cuisine / Category</label>
                <input 
                  type="text" 
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-[#1b1c1c] border border-[#242f46] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-[#fdd400]"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-gray-300 block mb-1">Location / Address</label>
                <input 
                  type="text" 
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full bg-[#1b1c1c] border border-[#242f46] rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-[#fdd400]"
                />
              </div>

              <div className="pt-3 flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="w-1/2 py-2.5 bg-[#1b1c1c] text-gray-300 font-bold rounded-xl text-xs hover:bg-[#242f46]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="w-1/2 py-2.5 bg-[#00450d] text-white font-bold rounded-xl text-xs hover:bg-[#1b5e20] border border-[#91d78a]/30"
                >
                  Onboard Dhaba
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
