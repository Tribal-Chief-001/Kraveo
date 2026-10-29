import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bike, Check, ClipboardCheck, KeyRound, Loader2, MapPin, Phone, RefreshCw, Store, X } from 'lucide-react';
import { Application, ApplicationCounts, ApprovalStatus, PartnerKind } from '../types';
import type { SavedPin } from '../lib/vendorLocation';
import { VendorLocationEditor } from './VendorLocationEditor';
import { ApiError, apiService } from '../services/api';
import { generatePassword } from '../lib/credentials';
import { Outcome, blockFromError, outcomeNeedsNotice } from '../lib/accountParse';
import { decisionToast } from '../lib/adminMessages';
import { timeAgo } from '../lib/tokens';
import { vendorHasRealPin } from '../lib/campus';
import { ReasonDialog } from './ReasonDialog';
import { CredentialDialog, Credentials } from './CredentialDialog';
import { OutcomeDialog } from './OutcomeDialog';
import { ApprovalPill } from './ui/ApprovalPill';
import { Avatar } from './ui/Avatar';
import { Drawer } from './ui/Drawer';
import { EmptyState } from './ui/EmptyState';
import { Field } from './ui/Field';
import { SkeletonCard } from './ui/Skeleton';
import { useToast } from './ui/Toast';

interface Props {
  /** Bumped by the app when a new application arrives over the socket, so the list reloads. */
  refreshKey: number;
  query?: string;
  /** Called after any decision so counts and the vendor/driver lists can refresh. */
  onChanged: () => void;
  onAuthError: (error: unknown) => void;
  /** Called after an admin typed a pin for a restaurant here, so the Vendors tab and the live map use it too. */
  onLocationSaved?: (vendorId: string, saved: SavedPin) => void;
}

type StatusFilter = ApprovalStatus | 'ALL';
type KindFilter = PartnerKind | 'ALL';

const STATUS_TABS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'PENDING', label: 'Pending' },
  { id: 'APPROVED', label: 'Approved' },
  { id: 'REJECTED', label: 'Rejected' },
  { id: 'SUSPENDED', label: 'Suspended' },
  { id: 'ALL', label: 'All' },
];

const REJECT_REASONS = ['Phone not reachable', 'Details incomplete', 'Outside our delivery area', 'Could not verify the licence', 'Not needed right now'];
const SUSPEND_REASONS = ['Customer complaints', 'No-shows on orders', 'Documents expired', 'Temporarily closed'];

const dash = (v?: string | null) => (v && v.trim() ? v : '—');

const Detail: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="k-inset px-3 py-2.5">
    <p className="k-label !text-[10px]">{label}</p>
    <p className="mt-0.5 break-words text-sm font-bold text-kraveo-ink">{children}</p>
  </div>
);

type Dialog =
  | { type: 'reason'; app: Application; status: 'REJECTED' | 'SUSPENDED' }
  | { type: 'password'; app: Application }
  | null;

export const ApplicationsPanel: React.FC<Props> = ({ refreshKey, query = '', onChanged, onAuthError, onLocationSaved }) => {
  const toast = useToast();
  const [status, setStatus] = useState<StatusFilter>('PENDING');
  const [kind, setKind] = useState<KindFilter>('ALL');
  const [items, setItems] = useState<Application[]>([]);
  const [counts, setCounts] = useState<ApplicationCounts>({ PENDING: 0, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  // Shown once after a password reset, then dropped.
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [notice, setNotice] = useState<{ title: string; headline: string; outcome: Outcome; again?: () => Promise<Outcome> } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await apiService.fetchApplications(status, kind === 'ALL' ? undefined : kind);
      setItems(result.data);
      setCounts(result.counts);
    } catch (e) {
      onAuthError(e);
      setError(e instanceof Error ? e.message : 'Applications could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [status, kind, onAuthError]);

  useEffect(() => { setLoading(true); load(); }, [load, refreshKey]);

  /** Sends the decision. Throws when the server refuses, so a dialog can show why; the caller handles the toast on failure. */
  const runDecision = async (app: Application, next: ApprovalStatus, reason?: string, extra: { openOrders?: 'CANCEL'; handover?: 'RELEASE' } = {}) => {
    const { outcome } = await apiService.decidePartner(app.kind, app.id, next, reason, extra);
    const who = app.kind === 'VENDOR' ? app.vendor?.name ?? app.name : app.name;
    const [toastTitle, toastText] = decisionToast(app, next, who);
    toast.success(toastTitle, toastText);
    // A restaurant suspended with "cancel the orders" cancels at most 25 per request: Continue repeats the same call for the next batch.
    const again = extra.openOrders ? async () => (await apiService.decidePartner(app.kind, app.id, next, reason, extra)).outcome : undefined;
    if (outcomeNeedsNotice(outcome)) setNotice({ title: 'What happened to the orders', headline: `${who} is suspended.`, outcome, again });
    void load();
    onChanged();
  };

  const decide = async (app: Application, next: ApprovalStatus, reason?: string) => {
    setBusyId(app.id);
    try {
      await runDecision(app, next, reason);
    } catch (e) {
      onAuthError(e);
      toast.error('Could not update', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const pinSaved = (id: string, saved: SavedPin) => {
    setItems((current) => current.map((a) => (a.kind === 'VENDOR' && a.id === id && a.vendor ? { ...a, vendor: { ...a.vendor, ...saved } } : a)));
    onLocationSaved?.(id, saved);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((a) => [a.name, a.phone ?? '', a.vendor?.name ?? '', a.vendor?.address ?? '', a.driver?.runnerCode ?? '', a.driver?.vehicleRegNo ?? ''].some((v) => v.toLowerCase().includes(q)));
  }, [items, query]);

  const total = counts.PENDING + counts.APPROVED + counts.REJECTED + counts.SUSPENDED;
  const countFor = (id: StatusFilter) => (id === 'ALL' ? total : counts[id]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0" role="group" aria-label="Filter by decision">
          {STATUS_TABS.map((t) => (
            <button key={t.id} className="k-chip" aria-pressed={status === t.id} onClick={() => setStatus(t.id)}>
              {t.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums ${status === t.id ? 'bg-kraveo-g400/25' : t.id === 'PENDING' && counts.PENDING > 0 ? 'bg-kraveo-status-placed/30 text-kraveo-status-placed' : 'bg-kraveo-line/70'}`}>{countFor(t.id)}</span>
            </button>
          ))}
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-none sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0" role="group" aria-label="Filter by type">
          {([['ALL', 'Everyone'], ['VENDOR', 'Restaurants'], ['DRIVER', 'Riders']] as const).map(([id, label]) => (
            <button key={id} className="k-chip" aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>
          ))}
        </div>
      </div>

      {error && <div role="alert" className="rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">{error}</div>}

      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        {loading && items.length === 0 && Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} lines={3} />)}
        {!loading && visible.length === 0 && (
          <div className="k-card lg:col-span-2 2xl:col-span-3">
            <EmptyState
              icon={ClipboardCheck}
              title={status === 'PENDING' ? 'No applications waiting' : 'Nothing here'}
              description={status === 'PENDING' ? 'When a restaurant or rider creates an account in their app, it shows up here for your approval.' : 'No partners match this filter.'}
            />
          </div>
        )}
        {visible.map((a, index) => {
          const isVendor = a.kind === 'VENDOR';
          const busy = busyId === a.id;
          return (
            <article key={`${a.kind}-${a.id}`} className="k-card k-reveal flex flex-col p-5" style={{ ['--i' as string]: Math.min(index, 10) }}>
              <div className="flex items-start gap-3.5">
                <Avatar name={isVendor ? a.vendor?.name ?? a.name : a.name} size="lg" className={isVendor ? '!rounded-k-md' : ''} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-kraveo-surface2 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-kraveo-ink2">
                      {isVendor ? <Store className="h-3 w-3" aria-hidden="true" /> : <Bike className="h-3 w-3" aria-hidden="true" />}{isVendor ? 'Restaurant' : 'Rider'}
                    </span>
                    <ApprovalPill status={a.status} showApproved />
                  </div>
                  <h3 className="mt-1.5 truncate font-display text-lg font-bold leading-tight text-kraveo-ink">{isVendor ? a.vendor?.name : a.name}</h3>
                  {isVendor && <p className="truncate text-xs text-kraveo-ink3">Owner: {a.name}</p>}
                  <p className="mt-1 text-xs text-kraveo-ink3">{a.selfSignup ? `Applied ${timeAgo(a.appliedAt)}` : `Added by admin ${timeAgo(a.createdAt)}`}</p>
                </div>
              </div>

              {a.phone ? (
                <a href={`tel:${a.phone}`} className="mt-4 inline-flex items-center gap-2 self-start rounded-k-sm bg-kraveo-g400/10 px-3 py-2 text-sm font-bold text-kraveo-g300 hover:bg-kraveo-g400/20">
                  <Phone className="h-4 w-4" aria-hidden="true" />{a.phone}
                  <span className="text-[11px] font-semibold text-kraveo-ink3">tap to call</span>
                </a>
              ) : null}

              <div className="mt-3 grid grid-cols-2 gap-2">
                {isVendor ? (
                  <>
                    <Detail label="Cuisine">{dash(a.vendor?.category)}</Detail>
                    <Detail label="FSSAI">{dash(a.vendor?.fssaiNumber)}</Detail>
                    <div className="col-span-2"><Detail label="Address"><span className="inline-flex items-start gap-1"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-kraveo-ink3" aria-hidden="true" />{dash(a.vendor?.address)}</span></Detail></div>
                  </>
                ) : (
                  <>
                    <Detail label="Vehicle">{dash(a.driver?.vehicleType)}</Detail>
                    <Detail label="Number plate">{dash(a.driver?.vehicleRegNo)}</Detail>
                    <Detail label="Emergency contact">{dash(a.driver?.emergencyPhone)}</Detail>
                    <Detail label="Payout UPI">{dash(a.driver?.upiId)}</Detail>
                  </>
                )}
              </div>

              {isVendor && a.vendor && (
                <>
                  <VendorLocationEditor id={a.id} name={a.vendor.name} pin={a.vendor} onSaved={pinSaved} heading="Map pin" notSetLabel="Not provided" />
                  {a.status === 'PENDING' && !vendorHasRealPin(a.vendor) && (
                    <p className="mt-2 text-xs text-kraveo-ink3">The restaurant did not send a location. Type one above before approving, or approve now and set it later (riders cannot navigate to it until then).</p>
                  )}
                </>
              )}

              {(a.status === 'REJECTED' || a.status === 'SUSPENDED') && a.rejectionReason && (
                <p className="mt-3 rounded-k-sm bg-kraveo-surface2 px-3 py-2 text-xs text-kraveo-ink2"><span className="font-bold text-kraveo-ink">Reason shown to them:</span> {a.rejectionReason}</p>
              )}

              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                {a.status === 'PENDING' && (
                  <>
                    <button className="k-btn-primary flex-1" disabled={busy} onClick={() => decide(a, 'APPROVED')} aria-busy={busy}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}Approve
                    </button>
                    <button className="k-btn-danger flex-1" disabled={busy} onClick={() => setDialog({ type: 'reason', app: a, status: 'REJECTED' })}><X className="h-4 w-4" aria-hidden="true" />Reject</button>
                  </>
                )}
                {(a.accountStatus === 'REMOVED' || a.removedAt) && (
                  <p className="w-full rounded-k-sm bg-kraveo-surface2 px-3 py-2 text-xs text-kraveo-ink2">This {isVendor ? 'restaurant' : 'rider'} was removed by an admin. Restore it from the {isVendor ? 'Vendors' : 'Drivers'} tab first.</p>
                )}
                {a.status === 'REJECTED' && !(a.accountStatus === 'REMOVED' || a.removedAt) && (
                  <button className="k-btn-primary flex-1" disabled={busy} onClick={() => decide(a, 'APPROVED')}><Check className="h-4 w-4" aria-hidden="true" />Approve anyway</button>
                )}
                {a.status === 'SUSPENDED' && !(a.accountStatus === 'REMOVED' || a.removedAt) && (
                  <button className="k-btn-primary flex-1" disabled={busy} onClick={() => decide(a, 'APPROVED')}><RefreshCw className="h-4 w-4" aria-hidden="true" />Reactivate</button>
                )}
                {a.status === 'APPROVED' && (
                  <button className="k-btn-danger flex-1" disabled={busy} onClick={() => setDialog({ type: 'reason', app: a, status: 'SUSPENDED' })}>Suspend</button>
                )}
                {a.userId && a.status !== 'PENDING' && a.accountStatus !== 'REMOVED' && (
                  <button className="k-btn-ghost" onClick={() => setDialog({ type: 'password', app: a })}><KeyRound className="h-4 w-4" aria-hidden="true" />Reset password</button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {dialog?.type === 'reason' && (() => {
        const d = dialog;
        const isReject = d.status === 'REJECTED';
        const isVendor = d.app.kind === 'VENDOR';
        const who = isVendor ? d.app.vendor?.name ?? d.app.name : d.app.name;
        return (
          <ReasonDialog
            title={isReject ? 'Reject application' : `Suspend ${who}?`}
            subtitle={isReject ? who : undefined}
            intro={<p>{isReject ? 'They will see this in the app and can fix their details and apply again.' : isVendor ? 'The restaurant is hidden from customers and closed, and its owner is signed out. Orders in progress are never cancelled unless you choose that on the next screen.' : 'They will see this in the app. They are signed out and go offline at once. Deliveries in hand are never dropped unless you choose that on the next screen.'}</p>}
            quickReasons={isReject ? REJECT_REASONS : SUSPEND_REASONS}
            confirmLabel={isReject ? 'Reject' : 'Suspend'}
            danger
            toBlock={isReject ? undefined : (e) => blockFromError(e, isVendor ? 'vendor' : 'rider', 'suspend')}
            onClose={() => setDialog(null)}
            onAuthError={onAuthError}
            onSubmit={async (v) => {
              await runDecision(d.app, d.status, v.reason, v.resolve ? (isVendor ? { openOrders: 'CANCEL' } : { handover: 'RELEASE' }) : {});
              setDialog(null);
            }}
          />
        );
      })()}
      <PasswordDrawer
        app={dialog?.type === 'password' ? dialog.app : null}
        onClose={() => setDialog(null)}
        onAuthError={onAuthError}
        onSaved={(app, password) => {
          setDialog(null);
          setCredentials({
            heading: `Kraveo ${app.kind === 'VENDOR' ? 'Restaurant Partner' : 'Delivery Partner'} login`,
            who: `${app.name}${app.phone ? ` · ${app.phone}` : ''}`,
            phone: app.phone,
            password,
            note: 'The new password is active now. They are signed out everywhere and any lockout on this number is cleared.',
          });
        }}
      />
      <CredentialDialog credentials={credentials} onDone={() => setCredentials(null)} />
      {notice && <OutcomeDialog title={notice.title} headline={notice.headline} outcome={notice.outcome} onClose={() => setNotice(null)} onContinue={notice.again} onAuthError={onAuthError} />}
    </div>
  );
};

// ─────────────────────────── Reset password ───────────────────────────
const PasswordDrawer: React.FC<{ app: Application | null; onClose: () => void; onAuthError: (e: unknown) => void; onSaved: (app: Application, password: string) => void }> = ({ app, onClose, onAuthError, onSaved }) => {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (app) { setPassword(generatePassword()); setSaving(false); setError(''); } else setPassword(''); }, [app]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!app?.userId || saving) return;
    if (password.length < 8) { setError('At least 8 characters.'); return; }
    setSaving(true); setError('');
    try {
      await apiService.resetPartnerPassword(app.userId, password);
      toast.success('Password changed', 'Any lockout on this number is cleared too.');
      // The password moves to the "show once" dialog and is dropped from this form.
      onSaved(app, password);
      setPassword('');
    } catch (err) {
      onAuthError(err);
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not reset the password.');
    } finally { setSaving(false); }
  };

  return (
    <Drawer
      open={Boolean(app)}
      onClose={() => { if (!saving) onClose(); }}
      title="Reset password"
      subtitle={app ? `${app.name} · ${app.phone ?? ''}` : ''}
      icon={KeyRound}
      footer={(
        <div className="flex gap-3">
          <button type="button" className="k-btn-ghost flex-1" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="reset-form" className="k-btn-primary flex-1" disabled={saving} aria-busy={saving}>{saving ? 'Saving…' : 'Set new password'}</button>
        </div>
      )}
    >
      <form id="reset-form" noValidate onSubmit={save} className="space-y-4">
        {error && <div role="alert" className="rounded-k-md border border-kraveo-danger/30 bg-kraveo-danger/10 px-4 py-3 text-sm text-kraveo-ink">{error}</div>}
        <p className="text-sm text-kraveo-ink2">There is no “forgot password” by SMS, so a partner who forgets theirs asks you for a new one.</p>
        <Field label="New password" htmlFor="new-pass" required>
          <div className="flex gap-2">
            <input id="new-pass" className="k-input font-mono" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            <button type="button" className="k-btn-ghost shrink-0" onClick={() => setPassword(generatePassword())}><RefreshCw className="h-4 w-4" aria-hidden="true" />Generate</button>
          </div>
        </Field>
      </form>
    </Drawer>
  );
};
