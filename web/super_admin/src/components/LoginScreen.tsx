import React, { useState } from 'react';
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, TriangleAlert } from 'lucide-react';
import { apiService } from '../services/api';
import { AdminProfile } from '../types';
import { LogoBadge } from './ui/Logo';
import { PIPELINE_ORDER, STATUS_META } from '../lib/tokens';

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
      setErrorMessage(err.message || 'Access denied. Invalid admin passcode.');
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-kraveo-night lg:grid lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <section className="relative hidden overflow-hidden bg-gradient-to-br from-kraveo-g800 via-kraveo-g900 to-kraveo-g950 lg:flex lg:flex-col lg:justify-between lg:p-14" aria-hidden="true">
        <div className="pointer-events-none absolute -left-32 -top-32 h-[520px] w-[520px] rounded-full bg-kraveo-g400/25 blur-[120px]" />
        <div className="pointer-events-none absolute -bottom-40 right-0 h-[420px] w-[420px] rounded-full bg-kraveo-yellow/10 blur-[120px]" />
        <div className="k-map-grid pointer-events-none absolute inset-0 opacity-30 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />

        <div className="relative animate-fade-up">
          <LogoBadge imgClassName="h-14" />
        </div>

        <div className="relative max-w-xl">
          <h2 className="k-reveal font-display text-5xl font-extrabold leading-[1.05] tracking-tight text-kraveo-ink xl:text-6xl" style={{ ['--i' as string]: 1 }}>
            Every order.<br />Every runner.<br /><span className="text-kraveo-g300">One calm screen.</span>
          </h2>
          <p className="k-reveal mt-6 max-w-md text-base text-kraveo-g100/80" style={{ ['--i' as string]: 2 }}>
            The dispatch console for Kraveo campus deliveries at VIT Bhopal.
          </p>
          <div className="k-reveal mt-10 flex flex-wrap gap-2" style={{ ['--i' as string]: 3 }}>
            {[...PIPELINE_ORDER, 'delivered' as const].map((key) => {
              const meta = STATUS_META[key];
              return (
                <span key={key} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold backdrop-blur ${meta.bg} ${meta.text}`}>
                  <span className={`k-dot ${meta.dot}`} />{meta.label}
                </span>
              );
            })}
          </div>
        </div>

        <p className="relative text-xs text-kraveo-g200/70">Kraveo campus network · Built for VIT Bhopal</p>
      </section>

      {/* Form panel */}
      <main className="relative flex min-h-screen items-center justify-center px-5 py-10 sm:px-10">
        <div className="pointer-events-none absolute left-1/2 top-0 h-[360px] w-[360px] -translate-x-1/2 rounded-full bg-kraveo-g400/10 blur-[110px] lg:hidden" />
        <div className="relative w-full max-w-md">
          <div className="mb-8 flex justify-center lg:hidden animate-fade-up">
            <LogoBadge imgClassName="h-14" />
          </div>

          <div className="k-card animate-scale-in p-6 sm:p-8">
            <h1 className="font-display text-3xl font-extrabold tracking-tight text-kraveo-ink">Welcome back</h1>
            <p className="mt-1 text-sm text-kraveo-ink2">Sign in to open the command center.</p>

            {errorMessage && (
              <div id="login-error" role="alert" className="mt-6 flex items-start gap-3 rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 p-3.5 text-sm text-kraveo-ink animate-fade-in">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-kraveo-danger" aria-hidden="true" />
                <span className="flex-1">{errorMessage}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
              <div className="space-y-1.5">
                <label htmlFor="admin-passcode" className="k-label">Admin passcode</label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-kraveo-ink3" aria-hidden="true" />
                  <input
                    id="admin-passcode"
                    type={showPassword ? 'text' : 'password'}
                    value={passcode}
                    onChange={(e) => { setPasscode(e.target.value); if (errorMessage) setErrorMessage(''); }}
                    placeholder="Enter your passcode"
                    autoFocus
                    autoComplete="current-password"
                    aria-invalid={Boolean(errorMessage)}
                    aria-describedby={errorMessage ? 'login-error' : undefined}
                    disabled={isLoading}
                    className="k-input !min-h-[52px] pl-10 pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((current) => !current)}
                    aria-label={showPassword ? 'Hide passcode' : 'Show passcode'}
                    aria-pressed={showPassword}
                    className="absolute right-1.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-k-sm text-kraveo-ink3 transition-colors hover:text-kraveo-ink"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>

              <button type="submit" disabled={isLoading} className="k-btn-accent !min-h-[52px] w-full text-base" aria-busy={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                    <span>Signing in…</span>
                  </>
                ) : (
                  <>
                    <span>Enter command center</span>
                    <ArrowRight className="h-5 w-5" aria-hidden="true" />
                  </>
                )}
              </button>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-kraveo-ink3 lg:hidden">Kraveo campus network · Built for VIT Bhopal</p>
        </div>
      </main>
    </div>
  );
};
