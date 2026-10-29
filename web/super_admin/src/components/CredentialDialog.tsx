import React, { useEffect, useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { copyText } from '../lib/credentials';
import { istDateTime } from '../lib/auditParse';
import { Modal } from './ui/Modal';

/** What the dialog shows once. The caller keeps it only until `onDone`, then drops it. */
export interface Credentials {
  /** "Kraveo Restaurant Partner login" / "Kraveo Delivery Partner login": the first line of the copied text. */
  heading: string;
  /** Who it is for, shown under the title. */
  who: string;
  phone: string | null;
  password: string;
  /** When the server made it (reset answers). Shown so two passwords can be told apart. */
  issuedAt?: string | null;
  /** Shown in the explanation, e.g. "The old password stopped working and they were signed out everywhere." */
  note?: string;
}

const last10 = (phone: string | null): string => (phone ?? '').replace(/\D/g, '').slice(-10);

/**
 * The "show once" panel for a password (new owner login, reset password). The password lives in the caller's state while this is
 * open and is rendered as text only; it never goes into a URL, storage or the log. The dialog cannot be closed (Esc, backdrop,
 * X) until the admin ticked "I have copied it" or used the copy button, so a password is never lost by a stray click.
 */
export const CredentialDialog: React.FC<{ credentials: Credentials | null; onDone: () => void }> = ({ credentials, onDone }) => {
  const [copied, setCopied] = useState(false);
  const [ack, setAck] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // A new secret starts un-acknowledged.
  useEffect(() => { setCopied(false); setAck(false); setCopyFailed(false); }, [credentials?.password]);
  if (!credentials) return null;

  const done = ack || copied;
  const text = `${credentials.heading}\n${credentials.phone ? `Phone: ${last10(credentials.phone)}\n` : ''}Password: ${credentials.password}`;
  const copy = async () => {
    const ok = await copyText(text);
    setCopied(ok);
    setCopyFailed(!ok);
  };

  return (
    <Modal
      title="Share this login"
      subtitle={credentials.who}
      locked={!done}
      role="alertdialog"
      onClose={() => { if (done) onDone(); }}
      footer={<div className="pb-3"><button type="button" className="k-btn-primary w-full" disabled={!done} onClick={onDone}>Done</button></div>}
    >
      <div className="space-y-4">
        <p role="note" className="rounded-k-md border border-kraveo-status-placed/40 bg-kraveo-status-placed/10 p-3 text-sm font-semibold text-kraveo-ink">
          This password is shown only once. Kraveo cannot show it again; you can reset it any time.
        </p>
        {credentials.note && <p className="text-sm text-kraveo-ink2">{credentials.note}</p>}
        {credentials.issuedAt && istDateTime(credentials.issuedAt) !== '-' && <p className="text-xs text-kraveo-ink3">Generated at {istDateTime(credentials.issuedAt)} (India time)</p>}
        <dl className="k-inset space-y-3 p-4">
          {credentials.phone && <div><dt className="k-label">Phone (login)</dt><dd className="mt-0.5 font-mono text-base font-bold text-kraveo-ink">{credentials.phone}</dd></div>}
          <div><dt className="k-label">Password</dt><dd data-testid="shown-password" className="mt-0.5 select-all break-all font-mono text-lg font-bold tracking-wide text-kraveo-ink">{credentials.password}</dd></div>
        </dl>
        <button type="button" className="k-btn-accent w-full" onClick={() => void copy()}>
          {copied ? <><Check className="h-4 w-4" aria-hidden="true" />Copied</> : <><Copy className="h-4 w-4" aria-hidden="true" />Copy login details</>}
        </button>
        {copyFailed && <p role="alert" className="text-xs font-semibold text-kraveo-danger">The browser did not allow copying. Select the password above and copy it by hand.</p>}
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-kraveo-ink">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ack || copied} onChange={(e) => setAck(e.target.checked)} disabled={copied} />
          <span className="font-semibold">I have copied it</span>
        </label>
        <p className="flex items-center gap-1.5 text-xs text-kraveo-ink3"><KeyRound className="h-3.5 w-3.5" aria-hidden="true" />Do not paste it into a chat that other people can read.</p>
      </div>
    </Modal>
  );
};
