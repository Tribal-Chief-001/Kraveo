import React, { useEffect, useState } from 'react';
import { Vendor } from '../types';
import { apiService } from '../services/api';
import { Outcome, VendorImpact, blockFromError, outcomeNeedsNotice, vendorKnownBlock } from '../lib/accountParse';
import { inr } from '../lib/tokens';
import { ActionConfirm } from './ActionConfirm';
import { OutcomeDialog } from './OutcomeDialog';
import { ReasonDialog } from './ReasonDialog';
import { useToast } from './ui/Toast';

export type VendorAction = 'suspend' | 'reinstate' | 'remove' | 'restore';

const SUSPEND_REASONS = ['Customer complaints', 'Documents expired', 'Temporarily closed'];
const REMOVE_REASONS = ['Closed for good', 'Left the campus', 'Duplicate listing'];

/** The numbers shown before confirming (open orders, unpaid settlements) from the impact endpoint. */
export const useVendorImpact = (vendorId: string, active: boolean) => {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'failed'; impact: VendorImpact | null }>({ status: 'idle', impact: null });
  useEffect(() => {
    if (!active) { setState({ status: 'idle', impact: null }); return undefined; }
    let live = true;
    setState({ status: 'loading', impact: null });
    apiService.fetchVendorImpact(vendorId)
      .then((impact) => { if (live) setState({ status: 'ready', impact }); })
      .catch(() => { if (live) setState({ status: 'failed', impact: null }); });
    return () => { live = false; };
  }, [vendorId, active]);
  return state;
};

export const ImpactSummary: React.FC<{ status: 'idle' | 'loading' | 'ready' | 'failed'; impact: VendorImpact | null; showSettlements?: boolean }> = ({ status, impact, showSettlements = false }) => {
  if (status === 'loading') return <p role="status" className="text-xs text-kraveo-ink3">Checking this restaurant's orders…</p>;
  if (status === 'failed') return <p className="text-xs text-kraveo-ink3">Could not check the restaurant's orders first. The server checks again when you confirm.</p>;
  if (!impact) return null;
  const n = impact.openOrders.length;
  return (
    <ul aria-label="What this affects" className="space-y-1 rounded-k-md bg-kraveo-night/50 p-3 text-xs text-kraveo-ink2">
      <li>{n === 0 ? 'No orders are in progress.' : `${n} order${n === 1 ? ' is' : 's are'} in progress.`}</li>
      {showSettlements && <li>{impact.unpaidSettlements.count === 0 ? 'No unpaid settlements.' : `${impact.unpaidSettlements.count} unpaid settlement${impact.unpaidSettlements.count === 1 ? '' : 's'} worth ${inr(impact.unpaidSettlements.amount)} stay in Finance.`}</li>}
      <li>{impact.hasOwner ? 'It has an owner login.' : 'It has no owner login.'}</li>
    </ul>
  );
};

interface Props {
  action: VendorAction | null;
  vendor: Vendor;
  onClose: () => void;
  /** The server accepted; `vendor` is the fresh admin view. The list should reload. */
  onDone: (vendor: Vendor) => void;
  onAuthError: (error: unknown) => void;
  onOpenOrder?: (orderId: string) => void;
}

/** Suspend / reinstate / remove / restore dialogs of one restaurant. */
export const VendorActionDialogs: React.FC<Props> = ({ action, vendor, onClose, onDone, onAuthError, onOpenOrder }) => {
  const toast = useToast();
  const [notice, setNotice] = useState<{ title: string; headline: string; outcome: Outcome; again?: () => Promise<Outcome> } | null>(null);
  const impact = useVendorImpact(vendor.id, action === 'suspend' || action === 'remove');
  const name = vendor.name;
  const openOrder = onOpenOrder ? (id: string) => { onClose(); onOpenOrder(id); } : undefined;
  const looking = impact.status === 'loading';

  /** `again` repeats the same cancelling action for the next batch (the server cancels at most 25 orders per request). */
  const finished = (title: string, headline: string, next: Vendor, outcome: Outcome, again?: () => Promise<Outcome>) => {
    toast.success(title, headline);
    if (outcomeNeedsNotice(outcome)) setNotice({ title: 'What happened to the orders', headline, outcome, again });
    onDone(next);
    onClose();
  };

  const repeat = async (kind: 'suspend' | 'remove', input: Parameters<typeof apiService.blockVendor>[2]): Promise<Outcome> => {
    const out = await apiService.blockVendor(vendor.id, kind, input);
    onDone(out.vendor);
    return out.outcome;
  };

  return (
    <>
      {action === 'suspend' && (
        <ReasonDialog
          title={`Suspend ${name}?`}
          intro={<p>Hide {name} from customers and close it for new orders. Its owner is signed out. Dishes, orders and settlements stay. You can reinstate it later.</p>}
          quickReasons={SUSPEND_REASONS}
          block={impact.impact ? vendorKnownBlock(impact.impact, 'suspend') : null}
          toBlock={(e) => blockFromError(e, 'vendor', 'suspend')}
          confirmDisabled={looking}
          confirmLabel="Suspend restaurant"
          danger
          onClose={onClose}
          onAuthError={onAuthError}
          onOpenOrder={openOrder}
          onSubmit={async (v) => {
            const input = { reason: v.reason, ...(v.resolve ? { openOrders: 'CANCEL' as const } : {}) };
            const out = await apiService.blockVendor(vendor.id, 'suspend', input);
            finished('Restaurant suspended', out.outcome.changed ? `${name} is suspended and closed.` : `${name} was already suspended.`, out.vendor, out.outcome, v.resolve ? async () => repeat('suspend', input) : undefined);
          }}
        ><ImpactSummary status={impact.status} impact={impact.impact} /></ReasonDialog>
      )}
      {action === 'remove' && (
        <ReasonDialog
          title={`Remove ${name}?`}
          intro={<p>Customers will no longer see it. Its dishes, orders and unpaid settlements stay for the books. You can restore it later.</p>}
          quickReasons={REMOVE_REASONS}
          confirmName={{ label: 'Type the restaurant name to confirm', expected: name }}
          flags={vendor.owner !== null ? [{ key: 'disableOwner', label: 'Also disable the owner login', hint: 'Signs the owner out and stops them signing in. Restoring the restaurant turns it back on.', defaultChecked: true }] : undefined}
          block={impact.impact ? vendorKnownBlock(impact.impact, 'remove') : null}
          toBlock={(e) => blockFromError(e, 'vendor', 'remove')}
          confirmDisabled={looking}
          confirmLabel="Remove restaurant"
          danger
          onClose={onClose}
          onAuthError={onAuthError}
          onOpenOrder={openOrder}
          onSubmit={async (v) => {
            const input = { reason: v.reason, confirmName: v.confirmName, disableOwner: vendor.owner === null ? true : v.flags.disableOwner === true, ...(v.resolve ? { openOrders: 'CANCEL' as const } : {}) };
            const out = await apiService.blockVendor(vendor.id, 'remove', input);
            finished('Restaurant removed', out.outcome.changed ? `${name} is removed.${out.ownerDisabled ? ' Its owner login is disabled.' : ''}` : `${name} was already removed.`, out.vendor, out.outcome, v.resolve ? async () => repeat('remove', input) : undefined);
          }}
        ><ImpactSummary status={impact.status} impact={impact.impact} showSettlements /></ReasonDialog>
      )}
      {action === 'reinstate' && (
        <ActionConfirm
          title={`Reinstate ${name}?`}
          confirmLabel="Reinstate"
          onClose={onClose}
          onAuthError={onAuthError}
          onConfirm={async () => {
            const out = await apiService.reviveVendor(vendor.id, 'reinstate');
            finished('Restaurant reinstated', `${name} is visible to customers again. It stays closed until the owner opens it.${out.outcome.warning ? ` ${out.outcome.warning}` : ''}`, out.vendor, out.outcome);
          }}
        >
          <p>Customers can see {name} again. It stays closed: the owner opens it from the app.</p>
        </ActionConfirm>
      )}
      {action === 'restore' && (
        <ActionConfirm
          title={`Restore ${name}?`}
          confirmLabel="Restore restaurant"
          onClose={onClose}
          onAuthError={onAuthError}
          onConfirm={async () => {
            const out = await apiService.reviveVendor(vendor.id, 'restore');
            finished('Restaurant restored', `${name} is back${out.ownerRestored ? ' and its owner login works again' : ''}. It is still suspended and closed: reinstate it when it may take orders.`, out.vendor, out.outcome);
          }}
        >
          <p>{name} comes back from removal. It stays suspended and closed until you reinstate it, and the owner opens it.</p>
        </ActionConfirm>
      )}
      {notice && <OutcomeDialog title={notice.title} headline={notice.headline} outcome={notice.outcome} onClose={() => setNotice(null)} onOpenOrder={onOpenOrder} onContinue={notice.again} onAuthError={onAuthError} />}
    </>
  );
};
