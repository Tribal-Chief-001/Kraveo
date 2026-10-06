import React, { useId, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { DriverPartner, Order, OrderStatus } from '../types';
import { ORDER_STATUS_LABEL } from '../lib/tokens';
import { assignableRiders, nextStep, orderCode, reassignBlockedReason, riderForOrder } from '../lib/orders';

/** '#' + last 6 of the id, uppercased (same code the apps show). */
export const shortId = orderCode;

export type AdvanceHandler = (orderId: string, status: OrderStatus, otpCode?: string) => Promise<boolean> | void;
export type ReassignHandler = (orderId: string, driverId: string | null) => Promise<boolean> | void;

/**
 * The one next status an admin may move the order to (the server refuses skipped states).
 * Blocked steps stay visible but disabled, with the reason next to them.
 */
export const NextStepControl: React.FC<{ order: Order; onAdvance: AdvanceHandler; stacked?: boolean }> = ({ order, onAdvance, stacked = false }) => {
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const step = nextStep(order, otp);
  if (!step) return null;
  const needsOtp = step.status === 'DELIVERED';
  const target = ORDER_STATUS_LABEL[step.status] ?? step.status;
  const label = needsOtp ? (stacked ? 'Mark delivered' : 'Delivered') : stacked ? `Move to ${target}` : target;
  const submit = async () => {
    if (step.blockedReason || busy) return;
    setBusy(true);
    try {
      const ok = await onAdvance(order.id, step.status, needsOtp ? otp : undefined);
      if (ok !== false && needsOtp) setOtp('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`flex gap-2 ${stacked ? 'flex-col' : 'flex-col items-end'}`} data-no-row-click>
      <div className={`flex gap-2 ${stacked ? 'flex-col sm:flex-row' : 'items-center'}`}>
        {needsOtp && !order.otpLocked && (
          <input
            aria-label={`Gate OTP for order ${shortId(order.id)}`}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="OTP"
            inputMode="numeric"
            autoComplete="off"
            className={`k-input !min-h-[40px] text-center font-mono tracking-[0.4em] ${stacked ? 'sm:w-32' : 'w-24'}`}
          />
        )}
        <button
          type="button"
          className={`k-btn-ghost !min-h-[40px] whitespace-nowrap !px-3 text-xs ${stacked ? 'w-full sm:w-auto' : ''}`}
          disabled={Boolean(step.blockedReason) || busy}
          aria-busy={busy}
          aria-describedby={step.blockedReason ? hintId : undefined}
          aria-label={`Move order ${shortId(order.id)} to ${target}`}
          title={`Move to ${target}`}
          onClick={submit}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
          {label}
        </button>
      </div>
      {step.blockedReason && <p id={hintId} className={`text-[11px] font-semibold text-kraveo-ink3 ${stacked ? '' : 'max-w-[10rem] text-right'}`}>{step.blockedReason}</p>}
    </div>
  );
};

const UNASSIGN = '__unassign__';

/** Assign or change the rider. Only approved riders are offered; unpaid or finished orders cannot be assigned. */
export const RiderAssignSelect: React.FC<{ order: Order; riders: DriverPartner[]; onReassign: ReassignHandler; className?: string; id?: string }> = ({ order, riders, onReassign, className = '', id }) => {
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const blocked = reassignBlockedReason(order);
  const options = assignableRiders(riders);
  const current = riderForOrder(riders, order);
  const change = async (value: string) => {
    if (!value) return;
    setBusy(true);
    try { await onReassign(order.id, value === UNASSIGN ? null : value); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-1" data-no-row-click>
      <select
        id={id}
        aria-label={`${order.driverId ? 'Change' : 'Assign'} rider for order ${shortId(order.id)}`}
        aria-describedby={blocked ? hintId : undefined}
        value=""
        disabled={Boolean(blocked) || busy}
        aria-busy={busy}
        onChange={(event) => change(event.target.value)}
        className={`k-select !min-h-[38px] text-xs font-bold ${className}`}
      >
        <option value="">{busy ? 'Saving…' : order.driverId ? 'Change rider' : 'Assign rider'}</option>
        {options.length === 0 && <option value="" disabled>No approved riders</option>}
        {options.map((rider) => {
          const isCurrent = current?.id === rider.id;
          return (
            // A rider already on a delivery cannot take a second order (the server refuses it), so it is not selectable.
            // An offline rider can be chosen: the admin is asked "Assign anyway?" first.
            <option key={rider.id} value={rider.id} disabled={isCurrent || rider.dutyStatus === 'IN_TRANSIT'}>
              {rider.name}{rider.dutyStatus === 'OFFLINE' ? ' (offline)' : rider.dutyStatus === 'IN_TRANSIT' ? ' (on a delivery)' : ''}{isCurrent ? ' (current)' : ''}
            </option>
          );
        })}
        {order.driverId && <option value={UNASSIGN}>Unassign rider</option>}
      </select>
      {blocked && <p id={hintId} className="text-[11px] font-semibold text-kraveo-ink3">{blocked}</p>}
    </div>
  );
};
