import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { DriverPartner } from '../types';
import { apiService } from '../services/api';
import { Outcome, RiderImpact, blockFromError, outcomeNeedsNotice, riderKnownBlock } from '../lib/accountParse';
import { generatePassword } from '../lib/credentials';
import { adminErrorText } from '../lib/errors';
import { ReasonDialog } from './ReasonDialog';
import { OutcomeDialog } from './OutcomeDialog';
import { CredentialDialog, Credentials } from './CredentialDialog';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

export type RiderAction = 'suspend' | 'remove' | 'restore' | 'reset';

const SUSPEND_REASONS = ['Customer complaints', 'No-shows on orders', 'Documents expired'];
const REMOVE_REASONS = ['Left the company', 'Repeated complaints', 'Fraud'];

interface Props {
  action: RiderAction | null;
  rider: DriverPartner;
  onClose: () => void;
  /** The server accepted; the rider list should reload. */
  onDone: () => void;
  onAuthError: (error: unknown) => void;
  onOpenOrder?: (orderId: string) => void;
}

/** Looks up the rider's deliveries while a suspend / remove dialog is open (the confirm button waits for it; a failed look-up does not block, the server checks again). */
const useImpact = (riderId: string, active: boolean) => {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'failed'; impact: RiderImpact | null }>({ status: 'idle', impact: null });
  useEffect(() => {
    if (!active) { setState({ status: 'idle', impact: null }); return undefined; }
    let live = true;
    setState({ status: 'loading', impact: null });
    apiService.fetchRiderImpact(riderId)
      .then((impact) => { if (live) setState({ status: 'ready', impact }); })
      .catch(() => { if (live) setState({ status: 'failed', impact: null }); });
    return () => { live = false; };
  }, [riderId, active]);
  return state;
};

/** Suspend / remove / restore / reset-password dialogs of one rider. Mounted by the rider drawer. */
export const RiderActionDialogs: React.FC<Props> = ({ action, rider, onClose, onDone, onAuthError, onOpenOrder }) => {
  const toast = useToast();
  const [notice, setNotice] = useState<{ title: string; headline: string; outcome: Outcome } | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const impact = useImpact(rider.id, action === 'suspend' || action === 'remove');
  const name = rider.name;
  const openOrder = onOpenOrder ? (id: string) => { onClose(); onOpenOrder(id); } : undefined;
  const looking = impact.status === 'loading';
  const note = impact.status === 'failed' ? <p className="text-xs text-kraveo-ink3">Could not check the rider's deliveries first. The server checks again when you confirm.</p> : looking ? <p role="status" className="text-xs text-kraveo-ink3">Checking the rider's deliveries…</p> : null;

  const finished = (title: string, headline: string, outcome: Outcome) => {
    toast.success(title, headline);
    if (outcomeNeedsNotice(outcome)) setNotice({ title: 'What happened to the deliveries', headline, outcome });
    onDone();
    onClose();
  };

  return (
    <>
      {action === 'suspend' && (
        <ReasonDialog
          title={`Suspend ${name}?`}
          intro={<p>They see the reason in the app, are signed out and go offline at once. Deliveries in hand are never dropped unless you choose that below.</p>}
          quickReasons={SUSPEND_REASONS}
          block={impact.impact ? riderKnownBlock(impact.impact, 'suspend') : null}
          toBlock={(e) => blockFromError(e, 'rider', 'suspend')}
          confirmDisabled={looking}
          confirmLabel="Suspend"
          danger
          onClose={onClose}
          onAuthError={onAuthError}
          onOpenOrder={openOrder}
          onSubmit={async (v) => {
            const { outcome } = await apiService.decidePartner('DRIVER', rider.id, 'SUSPENDED', v.reason, v.resolve ? { handover: 'RELEASE' } : {});
            finished('Rider suspended', `${name} is suspended.`, outcome);
          }}
        >{note}</ReasonDialog>
      )}
      {action === 'remove' && (
        <ReasonDialog
          title={`Remove ${name} as a rider?`}
          intro={<>
            <p>They are signed out and cannot work again unless you restore them. Past deliveries and payout records stay. Their phone number stays reserved.</p>
            <p className="font-semibold text-kraveo-ink">Record any payout you owe {name} first (Finance, Riders).</p>
          </>}
          quickReasons={REMOVE_REASONS}
          confirmName={{ label: "Type the rider's name to confirm", expected: name }}
          block={impact.impact ? riderKnownBlock(impact.impact, 'remove') : null}
          toBlock={(e) => blockFromError(e, 'rider', 'remove')}
          confirmDisabled={looking}
          confirmLabel="Remove rider"
          danger
          onClose={onClose}
          onAuthError={onAuthError}
          onOpenOrder={openOrder}
          onSubmit={async (v) => {
            const { outcome } = await apiService.removeRider(rider.id, { reason: v.reason, confirmName: v.confirmName, ...(v.resolve ? { handover: 'RELEASE' as const } : {}) });
            finished('Rider removed', outcome.changed ? `${name} is removed.` : `${name} was already removed.`, outcome);
          }}
        >{note}</ReasonDialog>
      )}
      {action === 'restore' && (
        <ReasonDialog
          title={`Restore ${name}?`}
          intro={<p>Their login works again. They stay suspended until you press Reactivate, and they go on duty from the app. Sessions that were ended stay ended.</p>}
          reasonLabel="Note (optional)"
          reasonOptional
          confirmLabel="Restore rider"
          onClose={onClose}
          onAuthError={onAuthError}
          onSubmit={async (v) => {
            const { outcome } = await apiService.restoreRider(rider.id, v.reason || undefined);
            finished('Rider restored', outcome.changed ? `${name} is restored and still suspended. Reactivate them when they may work.` : `${name} was already restored.`, outcome);
          }}
        />
      )}
      {action === 'reset' && (
        <ResetPasswordDialog
          rider={rider}
          onClose={onClose}
          onAuthError={onAuthError}
          onReset={(password) => {
            onClose();
            setCredentials({
              heading: 'Kraveo Delivery Partner login',
              who: `${name}${rider.phone ? ` · ${rider.phone}` : ''}`,
              phone: rider.phone || null,
              password,
              note: 'The new password is active now. They are signed out everywhere and any lockout on this number is cleared.',
            });
          }}
        />
      )}
      <CredentialDialog credentials={credentials} onDone={() => setCredentials(null)} />
      {notice && <OutcomeDialog title={notice.title} headline={notice.headline} outcome={notice.outcome} onClose={() => setNotice(null)} onOpenOrder={onOpenOrder} />}
    </>
  );
};

const ResetPasswordDialog: React.FC<{ rider: DriverPartner; onClose: () => void; onAuthError: (e: unknown) => void; onReset: (password: string) => void }> = ({ rider, onClose, onAuthError, onReset }) => {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const run = async () => {
    if (busyRef.current) return;
    if (!rider.userId) { setError('This rider has no login account to reset.'); return; }
    busyRef.current = true; setBusy(true); setError('');
    const password = generatePassword(12);
    try {
      await apiService.resetPartnerPassword(rider.userId, password);
      toast.success('Password changed', 'Any lockout on this number is cleared too.');
      onReset(password);
    } catch (e) {
      onAuthError(e);
      setError(adminErrorText(e, 'Could not reset the password.'));
    } finally { busyRef.current = false; setBusy(false); }
  };
  return (
    <Modal
      title={`Reset the password for ${rider.name}?`}
      locked={busy}
      onClose={onClose}
      footer={(
        <div className="flex flex-col-reverse gap-2 pb-3 sm:flex-row sm:gap-3">
          <button type="button" className="k-btn-ghost flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="k-btn-primary flex-1" onClick={() => void run()} disabled={busy} aria-busy={busy}>{busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Working…</> : 'Reset and show new password'}</button>
        </div>
      )}
    >
      <div className="space-y-3 text-sm text-kraveo-ink2">
        <p>They are signed out everywhere and the old password stops working now. A new password is made for you and shown once.</p>
        {error && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-kraveo-ink">{error}</p>}
      </div>
    </Modal>
  );
};
