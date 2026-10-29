import React, { useRef, useState } from 'react';
import { KeyRound, Loader2, UserCog } from 'lucide-react';
import { Vendor } from '../types';
import { ApiError, apiService } from '../services/api';
import { Outcome, OwnerInfo, OwnerResult, blockFromError, isOlderIssue, outcomeNeedsNotice, vendorKnownBlock } from '../lib/accountParse';
import { adminErrorText, fieldOf } from '../lib/errors';
import { LOGIN_ID_RE, OwnerFormErrors, collapseName, newOwnerBody, phoneDigits, validateName, validateOwnerForm, validatePhone } from '../lib/ownerInput';
import { timeAgo } from '../lib/tokens';
import { ActionConfirm } from './ActionConfirm';
import { CredentialDialog, Credentials } from './CredentialDialog';
import { OutcomeDialog } from './OutcomeDialog';
import { ImpactSummary, useVendorImpact } from './VendorActions';
import { ReasonDialog } from './ReasonDialog';
import { Field } from './ui/Field';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

type Dialog = 'create' | 'edit' | 'reset' | 'disable' | 'enable' | 'detach' | 'remove' | null;

export interface OwnerPatch { owner?: OwnerInfo | null; isAcceptingOrders?: boolean }

interface Props {
  vendor: Vendor;
  /** The owner or the open flag changed on the server: update the card. */
  onChanged: (patch: OwnerPatch) => void;
  onAuthError?: (error: unknown) => void;
  onOpenOrder?: (orderId: string) => void;
}

const DISABLE_REASONS = ['Owner asked to pause', 'Account shared with others', 'Not paying dues'];
const DETACH_REASONS = ['Owner changed', 'Wrong person was added', 'Restaurant is changing hands'];

export const OwnerStatusChip: React.FC<{ owner: OwnerInfo }> = ({ owner }) => {
  const meta = owner.accountStatus === 'ACTIVE' ? { label: 'Login active', cls: 'bg-kraveo-g400/15 text-kraveo-g300' }
    : owner.accountStatus === 'SUSPENDED' ? { label: 'Login disabled', cls: 'bg-kraveo-status-placed/20 text-kraveo-status-placed' }
      : { label: 'Login removed', cls: 'bg-kraveo-danger/15 text-kraveo-danger' };
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.cls}`}>{meta.label}</span>;
};

/** The amber "No owner" chip; the title carries the short reason. */
export const NoOwnerChip: React.FC = () => (
  <span
    className="inline-flex items-center whitespace-nowrap rounded-full bg-kraveo-status-placed/20 px-2.5 py-1 text-[11px] font-bold text-kraveo-status-placed"
    title="Customers can see this restaurant but cannot order until an owner login exists."
  >No owner</span>
);

export const NO_OWNER_EXPLAIN = 'Customers can see this restaurant but cannot order until an owner login exists.';

/** Owner login of one restaurant: who it is, and every admin action on it. Each action is its own dialog and acts at once (no Save needed). */
export const OwnerLoginSection: React.FC<Props> = ({ vendor, onChanged, onAuthError, onOpenOrder }) => {
  const toast = useToast();
  const [owner, setOwner] = useState<OwnerInfo | null>(vendor.owner ?? null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  // The login that was just detached from this restaurant (kept for this session only, so it can be attached again or its payout details moved).
  const [detached, setDetached] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<{ headline: string; outcome: Outcome } | null>(null);
  // The newest password time shown so far: an answer that was issued earlier (it arrived out of order) must never replace it.
  const latestIssue = useRef<string | null>(null);
  const impact = useVendorImpact(vendor.id, dialog === 'disable' || dialog === 'detach' || dialog === 'remove');
  const auth = (e: unknown) => onAuthError?.(e);
  const closeDialog = () => setDialog(null);
  const openOrder = onOpenOrder ? (id: string) => { closeDialog(); onOpenOrder(id); } : undefined;

  const apply = (patch: OwnerPatch) => {
    if (patch.owner !== undefined) setOwner(patch.owner);
    onChanged(patch);
  };

  const showSecret = (r: OwnerResult, o: OwnerInfo | null, heading: string, note: string): boolean => {
    if (!r.generatedPassword) return false;
    if (r.issuedAt && (!latestIssue.current || Date.parse(r.issuedAt) > Date.parse(latestIssue.current))) latestIssue.current = r.issuedAt;
    setCredentials({ heading, who: `${o?.name ?? 'Owner'} · ${vendor.name}`, phone: o?.phone ?? null, password: r.generatedPassword, issuedAt: r.issuedAt, note });
    return true;
  };

  if (vendor.owner === undefined) return null;

  return (
    <section aria-label="Owner login" className="space-y-3 rounded-k-md border border-kraveo-line p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 font-display text-base font-bold text-kraveo-ink"><UserCog className="h-4 w-4 text-kraveo-g400" aria-hidden="true" />Owner login</h3>
        {owner ? <OwnerStatusChip owner={owner} /> : <NoOwnerChip />}
      </div>

      {!owner ? (
        <>
          <p className="text-sm text-kraveo-ink2">{NO_OWNER_EXPLAIN} It stays closed until you add one.</p>
          {detached && <p role="status" className="text-xs text-kraveo-ink2">{detached.name}'s login was detached a moment ago and can be attached again.</p>}
          <button type="button" className="k-btn-primary w-full sm:w-auto" onClick={() => setDialog('create')}>Create or attach an owner login</button>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="k-inset px-3 py-2.5"><dt className="k-label !text-[10px]">Name</dt><dd className="mt-0.5 break-words text-sm font-bold text-kraveo-ink">{owner.name}</dd></div>
            <div className="k-inset px-3 py-2.5"><dt className="k-label !text-[10px]">Phone (login)</dt><dd className="mt-0.5 break-all text-sm font-bold text-kraveo-ink">{owner.phone ?? '—'}</dd></div>
            <div className="k-inset px-3 py-2.5 sm:col-span-2"><dt className="k-label !text-[10px]">Last sign-in</dt><dd className="mt-0.5 text-sm font-bold text-kraveo-ink">{owner.lastLoginAt ? timeAgo(owner.lastLoginAt) : 'Has not signed in yet'}</dd></div>
          </dl>
          {owner.accountStatus === 'SUSPENDED' && <p role="status" className="break-words rounded-k-sm bg-kraveo-status-placed/10 px-3 py-2 text-xs text-kraveo-ink2">The login is disabled{owner.statusReason ? `: ${owner.statusReason}` : ''}. The owner cannot sign in.</p>}
          {owner.accountStatus === 'REMOVED' && <p role="status" className="rounded-k-sm bg-kraveo-danger/10 px-3 py-2 text-xs text-kraveo-ink2">This login was removed. Detach it to add a new owner.</p>}
          <div className="flex flex-wrap gap-2">
            {owner.accountStatus !== 'REMOVED' && <button type="button" className="k-btn-ghost !min-h-[40px] flex-1 text-xs" onClick={() => setDialog('edit')}>Change phone or name</button>}
            {owner.accountStatus !== 'REMOVED' && <button type="button" className="k-btn-ghost !min-h-[40px] flex-1 text-xs" onClick={() => setDialog('reset')}><KeyRound className="h-3.5 w-3.5" aria-hidden="true" />Reset password</button>}
            {owner.accountStatus === 'ACTIVE' && <button type="button" className="k-btn-ghost !min-h-[40px] flex-1 text-xs" onClick={() => setDialog('disable')}>Disable login</button>}
            {owner.accountStatus === 'SUSPENDED' && <button type="button" className="k-btn-ghost !min-h-[40px] flex-1 text-xs" onClick={() => setDialog('enable')}>Enable login</button>}
            <button type="button" className="k-btn-danger !min-h-[40px] flex-1 text-xs" onClick={() => setDialog('detach')}>Detach from restaurant</button>
            {owner.accountStatus !== 'REMOVED' && <button type="button" className="k-btn-danger !min-h-[40px] flex-1 text-xs" onClick={() => setDialog('remove')}>Remove login</button>}
          </div>
        </>
      )}

      {dialog === 'create' && (
        <CreateOwnerDialog
          vendor={vendor}
          detached={detached}
          onClose={closeDialog}
          onAuthError={auth}
          onSynced={(o) => apply({ owner: o })}
          onCreated={(r) => {
            closeDialog();
            setDetached(null);
            apply({ owner: r.owner, isAcceptingOrders: false });
            const shown = showSecret(r, r.owner, 'Kraveo Restaurant Partner login', `${vendor.name} stays closed until ${r.owner?.name ?? 'the owner'} signs in and opens it.`);
            toast.success('Owner login ready', shown ? `${r.owner?.name ?? 'The owner'} can sign in now.` : `${r.owner?.name ?? 'The owner'} can sign in with the password you set. ${vendor.name} stays closed until they open it.`);
          }}
        />
      )}
      {dialog === 'edit' && owner && (
        <EditOwnerDialog
          owner={owner}
          onClose={closeDialog}
          onAuthError={auth}
          onSaved={(r) => {
            closeDialog();
            apply({ owner: r.owner ?? owner });
            toast.success(r.changed ? 'Owner updated' : 'Nothing to change', r.changed ? 'If the phone changed, the owner signs in again with the new number and the same password.' : 'The server already had these values.');
          }}
          vendorId={vendor.id}
        />
      )}
      {dialog === 'reset' && owner && (
        <ActionConfirm
          title={`Reset the password for ${owner.name}?`}
          confirmLabel="Reset and show new password"
          onClose={closeDialog}
          onAuthError={auth}
          onConfirm={async () => {
            const r = await apiService.resetOwnerPassword(vendor.id);
            if (isOlderIssue(r.issuedAt, latestIssue.current)) throw new Error('A newer password was issued a moment ago, so this older one was not shown. Reset again to get a fresh one.');
            if (!showSecret(r, owner, 'Kraveo Restaurant Partner login', 'The new password is active now. They are signed out everywhere and the old password stopped working.')) {
              throw new ApiError(502, 'The server did not send a new password. Nothing was shown; try again.', 'UNEXPECTED_RESPONSE');
            }
            closeDialog();
            toast.success('Password reset', 'Share the new password with the owner.');
          }}
        >
          <p>They are signed out everywhere and the old password stops working now. A new password is made for you and shown once.</p>
        </ActionConfirm>
      )}
      {dialog === 'disable' && owner && (
        <ReasonDialog
          title={`Disable ${owner.name}'s login?`}
          intro={<p>They are signed out and cannot sign in until you enable it again.</p>}
          quickReasons={DISABLE_REASONS}
          flags={[{ key: 'close', label: `Also close ${vendor.name} for new orders`, hint: 'Leave this on unless an admin will run the restaurant: otherwise orders arrive that only an admin can accept.', defaultChecked: true }]}
          confirmDisabled={impact.status === 'loading'}
          confirmLabel="Disable login"
          danger
          onClose={closeDialog}
          onAuthError={auth}
          onSubmit={async (v) => {
            const r = await apiService.disableOwner(vendor.id, { reason: v.reason, closeRestaurant: v.flags.close === true });
            closeDialog();
            apply({ owner: r.owner ?? { ...owner, accountStatus: 'SUSPENDED', statusReason: v.reason }, ...(v.flags.close === true ? { isAcceptingOrders: false } : {}) });
            toast.success(r.changed ? 'Login disabled' : 'Already disabled', r.warning ?? (r.openOrders > 0 ? `${r.openOrders} order${r.openOrders === 1 ? ' is' : 's are'} still in progress. Handle ${r.openOrders === 1 ? 'it' : 'them'} in Orders.` : `${owner.name} is signed out.`));
          }}
        >
          <ImpactSummary status={impact.status} impact={impact.impact} />
          {impact.impact && impact.impact.openOrders.length > 0 && <p className="text-xs text-kraveo-ink2">These orders are not cancelled. You can handle them in the Orders tab.</p>}
        </ReasonDialog>
      )}
      {dialog === 'enable' && owner && (
        <ActionConfirm
          title={`Enable ${owner.name}'s login?`}
          confirmLabel="Enable login"
          onClose={closeDialog}
          onAuthError={auth}
          onConfirm={async () => {
            const r = await apiService.enableOwner(vendor.id);
            closeDialog();
            apply({ owner: r.owner ?? { ...owner, accountStatus: 'ACTIVE', statusReason: null } });
            toast.success(r.changed ? 'Login enabled' : 'Already enabled', `${owner.name} can sign in again. ${vendor.name} stays closed until they open it.`);
          }}
        >
          <p>They can sign in again with their old password. The restaurant stays closed: they open it from the app.</p>
        </ActionConfirm>
      )}
      {(dialog === 'detach' || dialog === 'remove') && owner && (
        <ReasonDialog
          title={dialog === 'detach' ? `Remove the owner login from ${vendor.name}?` : `Remove ${owner.name}'s login for good?`}
          intro={dialog === 'detach'
            ? <p>The restaurant stays, but nobody can run it until you add a new owner. The login is paused and can be attached to another restaurant later. Unpaid settlements stay.</p>
            : <p>The login is removed and cannot sign in again. The restaurant stays but nobody can run it until you add a new owner. Payout records and unpaid settlements stay.</p>}
          quickReasons={DETACH_REASONS}
          confirmName={dialog === 'remove' ? { label: "Type the owner's name to confirm", expected: owner.name } : undefined}
          flags={[{ key: 'close', label: 'Close the restaurant now', hint: 'Customers cannot order while nobody can accept the orders.', defaultChecked: true }]}
          block={impact.impact ? vendorKnownBlock(impact.impact, dialog === 'detach' ? 'detach' : 'remove') : null}
          toBlock={(e) => blockFromError(e, 'vendor', dialog === 'detach' ? 'detach' : 'remove')}
          confirmDisabled={impact.status === 'loading'}
          confirmLabel={dialog === 'detach' ? 'Detach login' : 'Remove login'}
          danger
          onClose={closeDialog}
          onAuthError={auth}
          onOpenOrder={openOrder}
          onSubmit={async (v) => {
            const r = await apiService.detachOwner(vendor.id, dialog === 'detach' ? 'detach' : 'remove', { reason: v.reason, closeRestaurant: v.flags.close === true, confirmName: v.confirmName, ...(v.resolve ? { openOrders: 'CANCEL' as const } : {}) });
            closeDialog();
            if (dialog === 'detach' && r.detachedUser) setDetached(r.detachedUser);
            apply({ owner: null, ...(v.flags.close === true ? { isAcceptingOrders: false } : {}) });
            const failed = r.outcome.failed.length;
            if (outcomeNeedsNotice(r.outcome)) setNotice({ headline: `${vendor.name} has no owner login now.`, outcome: r.outcome });
            toast.success(dialog === 'detach' ? 'Owner detached' : 'Login removed', failed > 0 ? `${vendor.name} has no owner now, but ${failed} order${failed === 1 ? '' : 's'} could not be cancelled. Check Orders.` : `${vendor.name} has no owner login now.`);
          }}
        >
          <ImpactSummary status={impact.status} impact={impact.impact} />
        </ReasonDialog>
      )}
      <CredentialDialog credentials={credentials} onDone={() => setCredentials(null)} />
      {notice && (
        <OutcomeDialog
          title="What happened to the orders"
          headline={notice.headline}
          outcome={notice.outcome}
          onClose={() => setNotice(null)}
          onOpenOrder={onOpenOrder}
          remainingHelp="The owner login is already detached, so this cannot be repeated here. To cancel the rest, suspend the restaurant and choose to cancel its orders (Suspend on the restaurant card), or cancel them one by one in the Orders tab."
        />
      )}
    </section>
  );
};

// ─────────────────────────── create / attach ───────────────────────────
const CreateOwnerDialog: React.FC<{
  vendor: Vendor;
  detached: { id: string; name: string } | null;
  onClose: () => void;
  onAuthError: (e: unknown) => void;
  onCreated: (r: OwnerResult) => void;
  /** The restaurant already has an owner (somebody else was faster): show it. */
  onSynced: (o: OwnerInfo | null) => void;
}> = ({ vendor, detached, onClose, onAuthError, onCreated, onSynced }) => {
  const [mode, setMode] = useState<'new' | 'attach'>('new');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [generate, setGenerate] = useState(true);
  const [password, setPassword] = useState('');
  const [attachId, setAttachId] = useState(detached?.id ?? '');
  const [moveFrom, setMoveFrom] = useState(false);
  const [moveId, setMoveId] = useState(detached?.id ?? '');
  const [touched, setTouched] = useState(false);
  const [errors, setErrors] = useState<OwnerFormErrors & { existing?: string; move?: string }>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const form = { name, phone, generate, password };
  const local = mode === 'new' ? validateOwnerForm(form) : {};
  const attachProblem = mode === 'attach' && !LOGIN_ID_RE.test(attachId.trim()) ? 'Enter the id of a detached owner login.' : '';
  const moveProblem = moveFrom && !LOGIN_ID_RE.test(moveId.trim()) ? 'Enter the id of the detached login to take the payout details from.' : '';
  const shown = (field: 'name' | 'phone' | 'password'): string | undefined => errors[field] ?? (touched ? local[field] : undefined);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busyRef.current) return;
    setTouched(true);
    if (Object.keys(local).length > 0 || attachProblem || moveProblem) return;
    busyRef.current = true; setBusy(true); setErrors({}); setBanner('');
    try {
      const from = moveFrom ? moveId.trim() : undefined;
      const r = mode === 'new'
        ? await apiService.createOwner(vendor.id, newOwnerBody(form, from))
        : await apiService.createOwner(vendor.id, { existingUserId: attachId.trim(), ...(from ? { takePayoutAccountFrom: from } : {}) });
      onCreated(r);
    } catch (e) {
      onAuthError(e);
      const field = fieldOf(e, ['name', 'phone', 'password', 'existingUserId', 'takePayoutAccountFrom'] as const);
      const code = e instanceof ApiError ? e.code : undefined;
      if (code === 'PHONE_TAKEN') setErrors({ phone: 'This number already belongs to another account.' });
      else if (field === 'name' || field === 'phone' || field === 'password') setErrors({ [field]: adminErrorText(e) });
      else if (field === 'existingUserId') setErrors({ existing: adminErrorText(e) });
      else if (field === 'takePayoutAccountFrom') setErrors({ move: adminErrorText(e) });
      else {
        setBanner(adminErrorText(e));
        // Somebody else gave the restaurant an owner meanwhile: show who.
        if (code === 'OWNER_EXISTS') apiService.fetchOwner(vendor.id).then(onSynced).catch(() => { /* the banner already says it */ });
      }
    } finally { busyRef.current = false; setBusy(false); }
  };

  return (
    <Modal
      title={`Owner login for ${vendor.name}`}
      subtitle="The restaurant stays closed until the owner signs in and opens it."
      locked={busy}
      onClose={onClose}
      footer={(
        <div className="flex flex-col-reverse gap-2 pb-3 sm:flex-row sm:gap-3">
          <button type="button" className="k-btn-ghost flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="k-btn-primary flex-1" onClick={() => void submit()} disabled={busy} aria-busy={busy}>
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Working…</> : mode === 'new' ? 'Create login' : 'Attach login'}
          </button>
        </div>
      )}
    >
      <form noValidate className="space-y-4" onSubmit={submit}>
        <div className="flex gap-2" role="group" aria-label="New or existing login">
          <button type="button" className="k-chip" aria-pressed={mode === 'new'} disabled={busy} onClick={() => setMode('new')}>New login</button>
          <button type="button" className="k-chip" aria-pressed={mode === 'attach'} disabled={busy} onClick={() => setMode('attach')}>Attach a detached login</button>
        </div>
        {mode === 'new' ? (
          <>
            <Field label="Owner name" htmlFor="ow-name" required error={shown('name')}>
              <input id="ow-name" className="k-input" value={name} maxLength={80} autoComplete="off" disabled={busy} onChange={(e) => { setName(e.target.value); setErrors({}); }} aria-invalid={Boolean(shown('name'))} aria-describedby="ow-name-msg" />
            </Field>
            <Field label="Owner phone (10 digits)" htmlFor="ow-phone" required error={shown('phone')} hint="This is the number they sign in with.">
              <input id="ow-phone" className="k-input" inputMode="tel" value={phone} maxLength={20} autoComplete="off" disabled={busy} onChange={(e) => { setPhone(e.target.value); setErrors({}); }} aria-invalid={Boolean(shown('phone'))} aria-describedby="ow-phone-msg" />
            </Field>
            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-kraveo-ink">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={generate} disabled={busy} onChange={(e) => { setGenerate(e.target.checked); setPassword(''); setErrors({}); }} />
              <span><span className="font-semibold">Generate a password for me</span><span className="block text-xs text-kraveo-ink3">It is shown once after you create the login.</span></span>
            </label>
            {!generate && (
              <Field label="Password (at least 8 characters)" htmlFor="ow-pass" required error={shown('password')} hint="It is not shown again after you create the login.">
                <input id="ow-pass" className="k-input font-mono" type="password" value={password} autoComplete="new-password" disabled={busy} onChange={(e) => { setPassword(e.target.value); setErrors({}); }} aria-invalid={Boolean(shown('password'))} aria-describedby="ow-pass-msg" />
              </Field>
            )}
          </>
        ) : (
          <Field label="Id of the detached login" htmlFor="ow-attach" required error={errors.existing ?? (touched ? attachProblem : undefined)} hint={detached ? `${detached.name}'s login was just detached; its id is filled in.` : 'Only a login that no longer runs a restaurant can be attached. It keeps its old password.'}>
            <input id="ow-attach" className="k-input font-mono" value={attachId} autoComplete="off" disabled={busy} onChange={(e) => { setAttachId(e.target.value); setErrors({}); }} aria-invalid={Boolean(errors.existing ?? (touched && attachProblem))} aria-describedby="ow-attach-msg" />
          </Field>
        )}
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-kraveo-ink">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={moveFrom} disabled={busy} onChange={(e) => { setMoveFrom(e.target.checked); setErrors({}); }} />
          <span><span className="font-semibold">Move payout details from a detached login</span><span className="block text-xs text-kraveo-ink3">The new owner takes over the saved UPI or bank details. They must be verified again.</span></span>
        </label>
        {moveFrom && (
          <Field label="Id of the detached login to take them from" htmlFor="ow-move" required error={errors.move ?? (touched ? moveProblem : undefined)}>
            <input id="ow-move" className="k-input font-mono" value={moveId} autoComplete="off" disabled={busy} onChange={(e) => { setMoveId(e.target.value); setErrors({}); }} aria-invalid={Boolean(errors.move ?? (touched && moveProblem))} aria-describedby="ow-move-msg" />
          </Field>
        )}
        {banner && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{banner}</p>}
      </form>
    </Modal>
  );
};

// ─────────────────────────── change phone / name ───────────────────────────
const EditOwnerDialog: React.FC<{ vendorId: string; owner: OwnerInfo; onClose: () => void; onAuthError: (e: unknown) => void; onSaved: (r: OwnerResult) => void }> = ({ vendorId, owner, onClose, onAuthError, onSaved }) => {
  const [name, setName] = useState(owner.name);
  const [phone, setPhone] = useState(owner.phone ?? '');
  const [touched, setTouched] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const nameChanged = collapseName(name) !== owner.name;
  const phoneChanged = (phoneDigits(phone) ?? phone.trim()) !== (phoneDigits(owner.phone ?? '') ?? (owner.phone ?? '').trim());
  const local = { name: nameChanged ? validateName(name) : '', phone: phoneChanged ? validatePhone(phone) : '' };
  const shown = (f: 'name' | 'phone') => errors[f] ?? (touched && local[f] ? local[f] : undefined);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busyRef.current) return;
    setTouched(true);
    if (!nameChanged && !phoneChanged) { setBanner('Nothing was changed.'); return; }
    if (local.name || local.phone) return;
    busyRef.current = true; setBusy(true); setErrors({}); setBanner('');
    try {
      onSaved(await apiService.patchOwner(vendorId, { ...(nameChanged ? { name: collapseName(name) } : {}), ...(phoneChanged ? { phone: phoneDigits(phone) ?? phone.trim() } : {}) }));
    } catch (e) {
      onAuthError(e);
      const field = fieldOf(e, ['name', 'phone'] as const);
      if (e instanceof ApiError && e.code === 'PHONE_TAKEN') setErrors({ phone: 'This number already belongs to another account.' });
      else if (field) setErrors({ [field]: adminErrorText(e) });
      else setBanner(adminErrorText(e));
    } finally { busyRef.current = false; setBusy(false); }
  };

  return (
    <Modal
      title={`Change ${owner.name}'s details`}
      locked={busy}
      onClose={onClose}
      footer={(
        <div className="flex flex-col-reverse gap-2 pb-3 sm:flex-row sm:gap-3">
          <button type="button" className="k-btn-ghost flex-1" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="k-btn-primary flex-1" onClick={() => void submit()} disabled={busy} aria-busy={busy}>{busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Working…</> : 'Save'}</button>
        </div>
      )}
    >
      <form noValidate className="space-y-4" onSubmit={submit}>
        <Field label="Owner name" htmlFor="oe-name" error={shown('name')}>
          <input id="oe-name" className="k-input" value={name} maxLength={80} autoComplete="off" disabled={busy} onChange={(e) => { setName(e.target.value); setErrors({}); setBanner(''); }} aria-invalid={Boolean(shown('name'))} aria-describedby="oe-name-msg" />
        </Field>
        <Field label="Owner phone (10 digits)" htmlFor="oe-phone" error={shown('phone')}>
          <input id="oe-phone" className="k-input" inputMode="tel" value={phone} maxLength={20} autoComplete="off" disabled={busy} onChange={(e) => { setPhone(e.target.value); setErrors({}); setBanner(''); }} aria-invalid={Boolean(shown('phone'))} aria-describedby="oe-phone-msg" />
        </Field>
        {phoneChanged && <p role="note" className="rounded-k-sm bg-kraveo-status-placed/10 px-3 py-2 text-xs text-kraveo-ink">Changing the phone signs the owner out of every device. They sign in again with the new number and the same password.</p>}
        {banner && <p role="alert" className="break-words rounded-k-sm border border-kraveo-danger/30 bg-kraveo-danger/10 px-3 py-2 text-sm text-kraveo-ink">{banner}</p>}
      </form>
    </Modal>
  );
};
