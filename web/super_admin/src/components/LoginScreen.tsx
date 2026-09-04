import React, { useState } from 'react';
import { apiService } from '../services/api';
import { AdminProfile } from '../types';
import { Shield, KeyRound, Eye, EyeOff, Lock, ArrowRight, Sparkles, CheckCircle2 } from 'lucide-react';

interface LoginScreenProps {
  onLoginSuccess: (profile: AdminProfile) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [passcode, setPasscode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim()) {
      setErrorMessage('Please enter the admin passcode.');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      const response = await apiService.adminLogin(passcode.trim());
      setIsLoading(false);
      onLoginSuccess(response.admin);
    } catch (err: any) {
      setIsLoading(false);
      setErrorMessage(err.message || 'Access Denied. Invalid admin passcode.');
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0F19] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-[#00450D]/20 rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-[300px] h-[300px] bg-[#FDD400]/10 rounded-full blur-[100px] pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        {/* Branding Header with Real Official Logo */}
        <div className="text-center mb-6">
          <div className="flex justify-center mb-3">
            <img 
              src="/logo-bgremove.png" 
              alt="Kraveo Logo" 
              className="h-28 w-auto object-contain drop-shadow-[0_12px_24px_rgba(0,69,13,0.6)] hover:scale-105 transition-transform duration-300" 
            />
          </div>
          <p className="text-xs font-extrabold text-[#91D78A] tracking-wider uppercase">
            Campus Ops Command Center
          </p>
          <p className="text-xs text-gray-400 mt-1">
            VIT Bhopal Residential Network • Highway Dhaba Dispatch
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-[#151C2C]/90 backdrop-blur-xl border border-[#242F46] rounded-3xl p-8 shadow-2xl">
          <div className="flex items-center gap-2 mb-6 pb-4 border-b border-[#242F46]">
            <Lock className="w-4 h-4 text-[#FDD400]" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">
              Admin Authentication
            </h2>
          </div>

          {errorMessage && (
            <div className="mb-5 p-3.5 bg-red-950/50 border border-red-500/50 rounded-xl text-red-300 text-xs font-medium flex items-start gap-2.5 animate-in fade-in">
              <span className="text-red-400 text-base leading-none">⚠️</span>
              <div className="flex-1">{errorMessage}</div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-xs font-bold text-gray-300 uppercase tracking-wider mb-2">
                Ops Passcode
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-500">
                  <KeyRound className="w-4 h-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Enter admin passcode"
                  autoFocus
                  required
                  className="w-full pl-10 pr-11 py-3 bg-[#0B0F19] border border-[#242F46] rounded-xl text-white text-sm placeholder-gray-500 focus:outline-none focus:border-[#FDD400] focus:ring-1 focus:ring-[#FDD400] transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-white"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-gray-400 mt-2 flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-[#FDD400]" />
                <span>Use the administrator credential issued by your platform owner.</span>
              </p>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3.5 bg-gradient-to-r from-[#00450D] to-[#15803d] hover:from-[#15803d] hover:to-[#00450D] text-white font-extrabold text-xs uppercase tracking-wider rounded-xl border border-[#91D78A]/40 shadow-lg shadow-[#00450D]/50 flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <span>Authenticate & Enter Command Center</span>
                  <ArrowRight className="w-4 h-4 text-[#FDD400]" />
                </>
              )}
            </button>
          </form>

          {/* Security Features */}
          <div className="mt-6 pt-5 border-t border-[#242F46] grid grid-cols-2 gap-2 text-[11px] text-gray-400">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#91D78A]" />
              <span>30-Day Session</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#91D78A]" />
              <span>Multi-Admin Sync</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#91D78A]" />
              <span>Real-Time Sockets</span>
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#91D78A]" />
              <span>Stateless JWT</span>
            </div>
          </div>
        </div>

        {/* Footer info */}
        <div className="text-center mt-6 text-xs text-gray-400">
          Kraveo Campus Network • Built for VIT Bhopal
        </div>
      </div>
    </div>
  );
};
