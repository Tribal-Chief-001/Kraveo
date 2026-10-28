# Admin management (remove users, owner logins, audit viewer): scope and owner decisions (29 Oct 2026)

The SPEC is Docs/27_admin_gaps_audit.md (sections B0-B5 and B6 item 2, plus the stage-2 items below). This file only fixes the SCOPE, the owner's answers to the open questions (Docs/27 section D) and the overrides where the owner decided differently from the audit's recommendation. Where Docs/27 and this file differ, THIS FILE wins. The owner was asleep and told us: "decide everything yourself, my answer is yes; production hardened, zero regression".

## Stage 1 (must ship together): B0 foundations, B4 owner login, B5 audit viewer, B1 customers, B2 riders, B3 restaurants + owners, B6-2 ownerless guard
## Stage 2 (after stage 1 is verified and deployed): B6-3 server-side order search + date filter + CSV export (orders, customers), B6-7 system health (admin/system + header dot), B6-9 operations settings group (auto-cancel windows / SLA minutes read each tick), B6-11 refunds/payment-issue tab (list, reconcile button, acknowledge), B6-16 lastLoginAt (fold into B0)

## Owner decisions (answers to Docs/27 section D)
1. **Ownerless restaurants** (created by the admin without an owner login, e.g. the six imported restaurants): they stay VISIBLE to customers (menu, photos, prices) but are always shown as closed; `placeOrder` and the group-order path refuse them with a plain message ("This restaurant is not taking orders right now") whatever `isAcceptingOrders` says; the admin/owner open-close toggle REFUSES to open a restaurant without an owner (409 `NO_OWNER`, message "Add an owner login first"). The audit's recommendation to hide them from the customer list is NOT adopted. Admin list shows an amber "No owner" chip.
2. **Customer remove**: `scrub` off by default (keep email/Google id of a removed person so the block holds); a removed customer cannot sign in again or re-register with the same Google account unless an admin restores the account.
3. **One restaurant per owner login** stays the rule (B4 enforces it).
4. **Admin passcode** stays the only admin login for now (individual admin accounts + 2FA = B6-1 is a LATER project; do not build it now, but do add the audit ACTOR to every audit row as spec'd in B0 using whatever identity the request has).
5. **Suspended customer**: signed out everywhere (tokens revoked, sockets disconnected, push tokens disabled), cannot see past orders until restored.
6. Removal never deletes accounting data: orders, payments, refunds, settlements, payout ledger and audit rows stay; payouts to a removed rider or owner still work for the last amount (fix the lookups as in Docs/27 finding 7).
7. The apps keep working: a blocked user gets a plain 403 with `code` and `message` on sign-in and on token use; no app crash (apps just show the server message; do not change the apps in stage 1).

## Rules
- Backend first (one agent, one migration, new route files; shared files edited only as in Docs/27 section C), dashboard second, review third. Each backend step: `tsc` + the full jest once; each dashboard step: `tsc` + vitest + build. All 1163+ backend, 1006 dashboard tests stay green.
- Every removal/suspension action: admin only, audited with actor, confirmation text in the UI naming the person and the consequences, idempotent, refuses (409 with the exact blocking items) when the user has open orders / active deliveries / pending refunds unless the spec says how to resolve them; sessions killed everywhere; open orders of a removed restaurant are cancelled with full refunds only through the existing cancel code path.
- Tests: real Postgres for every endpoint, every guard, race cases (removal vs a concurrent order/payment), login attempts of removed/suspended users (Google, partner login, token reuse, socket connect), payout of a removed user, visibility (customer/owner/rider cannot call admin routes), migration safe on live rows.
