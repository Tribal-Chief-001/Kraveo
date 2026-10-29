import React, { useState } from 'react';
import { CustomerDetail } from '../types';
import { apiService } from '../services/api';
import { Outcome, blockFromError, knownBlock, outcomeNeedsNotice } from '../lib/accountParse';
import { inr } from '../lib/tokens';
import { ReasonDialog } from './ReasonDialog';
import { OutcomeDialog } from './OutcomeDialog';
import { useToast } from './ui/Toast';

export type CustomerAction = 'suspend' | 'restore' | 'remove';

const SUSPEND_REASONS = ['Abuse of coupons', 'Fake orders', 'Harassing riders'];
const REMOVE_REASONS = ['Repeated abuse', 'Fraud', 'Asked to be removed'];

interface Props {
  action: CustomerAction | null;
  detail: CustomerDetail;
  onClose: () => void;
  /** The server accepted: `detail` is the fresh customer. The list should reload. */
  onDone: (detail: CustomerDetail) => void;
  onAuthError: (error: unknown) => void;
  onOpenOrder?: (orderId: string) => void;
}

/** Suspend / restore / remove dialogs of one customer. Mounted by the customer drawer. */
export const CustomerActionDialogs: React.FC<Props> = ({ action, detail, onClose, onDone, onAuthError, onOpenOrder }) => {
  const toast = useToast();
  const [notice, setNotice] = useState<{ title: string; headline: string; outcome: Outcome; again?: () => Promise<Outcome> } | null>(null);
  const name = detail.name;
  const openOrder = onOpenOrder ? (id: string) => { onClose(); onOpenOrder(id); } : undefined;

  /** `again` repeats the same cancelling action for the next batch (the server cancels at most 25 orders per request). */
  const finished = (headline: string, title: string, next: CustomerDetail, outcome: Outcome, again?: () => Promise<Outcome>) => {
    toast.success(title, headline);
    if (outcomeNeedsNotice(outcome)) setNotice({ title: 'What happened to the orders', headline, outcome, again });
    onDone(next);
    onClose();
  };

  const repeat = async (kind: 'suspend' | 'remove', input: Parameters<typeof apiService.blockCustomer>[2]): Promise<Outcome> => {
    const out = await apiService.blockCustomer(detail.id, kind, input);
    onDone(out.detail);
    return out.outcome;
  };

  return (
    <>
      {action === 'suspend' && (
        <ReasonDialog
          title={`Suspend ${name}?`}
          intro={<p>They will be signed out on every device and cannot sign in or order until you restore them. Their past orders and payments stay.</p>}
          reasonLabel="Reason (shown to the customer, 3-200 characters)"
          reasonHint="They see this when they try to sign in."
          quickReasons={SUSPEND_REASONS}
          block={knownBlock(detail.openOrders, 'customer', 'suspend')}
          toBlock={(e) => blockFromError(e, 'customer', 'suspend')}
          confirmLabel="Suspend"
          danger
          onClose={onClose}
          onAuthError={onAuthError}
          onOpenOrder={openOrder}
          onSubmit={async (v) => {
            const input = { reason: v.reason, ...(v.resolve ? { openOrders: 'CANCEL' as const } : {}) };
            const out = await apiService.blockCustomer(detail.id, 'suspend', input);
            finished(out.outcome.changed ? `${name} is suspended.` : `${name} was already suspended.`, 'Customer suspended', out.detail, out.outcome, v.resolve ? async () => repeat('suspend', input) : undefined);
          }}
        />
      )}
      {action === 'remove' && (
        <ReasonDialog
          title={`Remove ${name}?`}
          intro={<p>This blocks the account for good: they cannot sign in again with the same Google account unless you restore them. Orders, payments and settlements stay for the books.</p>}
          reasonLabel="Reason (3-200 characters)"
          quickReasons={REMOVE_REASONS}
          confirmName={{ label: "Type the customer's name to confirm", expected: name }}
          flags={[{ key: 'scrub', label: 'Also erase their name, phone, hostel and coins (cannot be undone)', hint: 'Off by default. Their email and Google sign-in stay on record so the block holds. Their unspent Kraveo coins are lost. Not possible while a refund to them is still pending.' }]}
          block={knownBlock(detail.openOrders, 'customer', 'remove')}
          toBlock={(e) => blockFromError(e, 'customer', 'remove')}
          confirmLabel="Remove customer"
          danger
          onClose={onClose}
          onAuthError={onAuthError}
          onOpenOrder={openOrder}
          onSubmit={async (v) => {
            const input = { reason: v.reason, confirmName: v.confirmName, scrub: v.flags.scrub === true, ...(v.resolve ? { openOrders: 'CANCEL' as const } : {}) };
            const out = await apiService.blockCustomer(detail.id, 'remove', input);
            finished(out.outcome.changed ? `${name} is removed.` : `${name} was already removed.`, 'Customer removed', out.detail, out.outcome, v.resolve ? async () => repeat('remove', input) : undefined);
          }}
        >
          {detail.refundsOwed.length > 0 && (
            <p className="rounded-k-md border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 p-3 text-sm text-kraveo-ink">
              They are still owed {detail.refundsOwed.length} refund{detail.refundsOwed.length === 1 ? '' : 's'} ({inr(detail.refundsOwed.reduce((sum, r) => sum + r.amount, 0))}). A removal does not stop a refund, but erasing their details is refused until it has reached them.
            </p>
          )}
        </ReasonDialog>
      )}
      {action === 'restore' && (
        <ReasonDialog
          title={`Restore ${name}?`}
          intro={<>
            <p>They can sign in and order again. Sessions that were ended stay ended, so they sign in fresh. Orders that were cancelled stay cancelled.</p>
            {detail.name === 'Removed user' && <p>Their name, phone and hostel were erased when they were removed, so the app will ask them to fill the profile in again.</p>}
          </>}
          reasonLabel="Note (optional)"
          reasonOptional
          confirmLabel="Restore customer"
          onClose={onClose}
          onAuthError={onAuthError}
          onSubmit={async (v) => {
            const out = await apiService.restoreCustomer(detail.id, v.reason || undefined);
            finished(out.outcome.changed ? `${name} can use Kraveo again.` : `${name} was already active.`, 'Customer restored', out.detail, out.outcome);
          }}
        />
      )}
      {notice && <OutcomeDialog title={notice.title} headline={notice.headline} outcome={notice.outcome} onClose={() => setNotice(null)} onOpenOrder={onOpenOrder} onContinue={notice.again} onAuthError={onAuthError} />}
    </>
  );
};
