# Kraveo launch roadmap (written 2 Oct 2026)

Status legend: DONE = built and verified in code/tests/prod; USER = needs the owner (documents, money, phones); CLAUDE = I can do it; UNVERIFIED = believed true, not checked.

External facts below come from web searches on 2 Oct 2026 (third-party summaries, not official pages unless stated). Re-check anything with money or law attached before acting.

## 0. Where we are (verified)

DONE: order flow v1 (7 statuses, paid invariant, rider pool, gate OTP), payments (verify, webhook, reconciliation, refunds with retry), 382 backend tests, partner sign-up + admin approval, dashboard (orders, refunds, needs-attention, customers, applications), landing site + privacy/terms, domains + HTTPS, port 5000 closed, APKs 1.4.0+7, webhook secret rotated and verified, Razorpay CLI (test keys only).
NOT DONE: real-phone end-to-end run by a human, refund exercised on a real captured test payment, live payments, Play Store, push notifications, legal/tax setup, backups/monitoring verification.

## 1. Phase A - this week, test mode, free

| # | Task | Who | How / done when |
|---|------|-----|-----------------|
| A1 | Cancel the 3 old paid test orders from the dashboard | USER | Dashboard > order > Cancel with reason. Then CLAUDE runs `razorpay refunds list` and confirms 3 refunds exist and order refundStatus=DONE. |
| A2 | Install APKs 1.4.0+7 on 3 phones, run a full order | USER | Place -> pay (Razorpay test UPI/card) -> vendor accepts -> preparing -> ready -> rider accepts -> picked up -> arrived at gate -> OTP -> delivered. Write down every glitch. Also test: customer cancel while PLACED, vendor reject, rider release, app killed mid-order, airplane mode. |
| A3 | Policy pages live (refunds, contact) | CLAUDE after USER answers | Pages are built in web/landing; need real contact email/phone and a "push" go-ahead (push auto-deploys kraveo.site). |
| A4 | Real support number in driver app | USER gives number, CLAUDE edits apps/driver_app/lib/config/support_config.dart (placeholder +91 98765 43214) | Rebuild driver APK. |
| A5 | Support mailbox: kraveo.contact@gmail.com (created 2 Oct 2026, used everywhere; enable 2FA) | USER | Razorpay, Play and customers write there. A domain mailbox is optional later. UNVERIFIED that it exists today. |
| A6 | Regenerate the old Razorpay test secret that was pasted in the Codex chat | USER (Razorpay dashboard > API keys) then CLAUDE updates server .env + pm2 restart --update-env + local CLI config | Remember PM2 env overrides dotenv. |
| A7 | Fix whatever A2 finds | CLAUDE | One commit per fix, tests first. |

## 2. Phase B - legal/business basics (start now, runs in parallel, slow)

These are the long poles. Nothing technical fixes them.

| # | Task | Notes |
|---|------|-------|
| B1 | Decide the legal entity: individual/proprietorship vs registered company/LLP | Affects Razorpay KYC, Play account type, GST, liability. A proprietorship via Udyam (free, online) is the cheapest start. Talk to a CA once (a few thousand rupees) - this is the best money spent in this plan. |
| B2 | Campus permission | Written OK from VIT Bhopal (gate access for riders, kitchen/food-court owners, any exclusivity). UNVERIFIED who owns the kitchens. Without it, a launch can be shut down on day 3. |
| B3 | FSSAI | Searches say e-commerce food operators/aggregators need FSSAI registration; Basic registration (under Rs 12 lakh turnover) is about Rs 100/year, State licence above that. Also each restaurant partner needs its own FSSAI - collect and store the number in the partner application. CLAUDE can add an FSSAI field to partner signup + dashboard. Confirm with CA whether Kraveo (marketplace, no kitchen) needs its own. |
| B4 | GST | Searches say restaurant services sold through an e-commerce operator attract 5% GST that the platform (Kraveo) collects and pays under section 9(5) of the CGST Act. If Kraveo is the operator, this likely means GST registration and invoices/tax lines. Our orders already have `taxAndPackaging`; whether it is modelled as GST is UNVERIFIED. Ask the CA before real money flows. |
| B5 | Current account/bank | Needed by Razorpay settlements (cancelled cheque). |
| B6 | Vendor agreements | One-page agreement per restaurant: commission %, payout cycle, who pays refunds for kitchen-fault orders, FSSAI proof, prices. |
| B7 | Rider terms | Riders are local, not students: ID proof, safety rules, payout method, who is liable for cash/accidents. Collect ID (Aadhaar/DL) offline or via a form; do not store ID images casually. |
| B8 | DPDP Act (India data law) | Searches say principal obligations for data fiduciaries start 13 May 2027 (notice, consent, security, breach report in 72 h, retention/erasure). We have a privacy page and in-app account deletion; a proper consent notice and retention policy still needed before then. |

## 3. Phase C - going live with money

| # | Task | Who | Notes |
|---|------|-----|-------|
| C1 | Razorpay live verification | USER + CLAUDE (pages) | Needs PAN, Aadhaar eKYC (proprietorship), business proof (Udyam/GST), bank proof, website URL. The form asked for a Play Store link; try giving kraveo.site (with refund/contact/terms/privacy pages) and the APK page. UNVERIFIED that the reviewer accepts that. Do not submit a form with placeholder "??" values. |
| C2 | Live keys | CLAUDE + USER | Generate live keys in dashboard (never paste in chat), put in server .env, new live webhook (same 4 events) with a new secret, `pm2 restart --update-env`, `pm2 save`. Keep a one-click rollback to test keys. CLI stays on test keys. |
| C3 | First live payment: Rs 1-10 real order by the owner, then refund it | USER | Verify settlement, fee deducted, refund lands (5-7 working days). |
| C4 | Fee decision | USER | Standard plan per third-party pages: 2% + 18% GST, UPI also 2% (zero-MDR does not mean free via Razorpay), no refund fee, new merchants sometimes 0% for 90 days. Recover it via vendor commission or a Rs 3-5 convenience fee. Ask Razorpay for a lower rate at 300-500 orders/day; compare Cashfree then. |
| C5 | Settlement/payout plan | USER + CLAUDE | Customer money lands in Kraveo's account; vendor and rider payouts are manual today. Define weekly payout, add a dashboard report (per vendor/rider: orders, gross, commission, payable). Razorpay Route can automate splits later (needs separate approval). |
| C6 | Chargeback/dispute handling | USER | Respond in Razorpay dashboard within the window; the refund policy page is the evidence. |

## 4. Phase D - distribution

| # | Task | Notes |
|---|------|-------|
| D1 | APK pilot (free) | download page on kraveo.site + WhatsApp group, 5-20 users, test mode first, then tiny real orders. Users must allow unknown sources. CLAUDE can build the download page once an APK URL exists (host on GitHub Releases or the server). |
| D2 | Release keystore for each app | CLAUDE generates, USER stores backup safely offline. Losing it means you cannot update the Play listing. UNVERIFIED current signing state. |
| D3 | Play Console account | One-time USD 25. Personal accounts created after 13 Nov 2023 must run a closed test with at least 12 testers opted in for 14 continuous days before applying for production (official Play Help page). Organization accounts are exempt but need a D-U-N-S number and a website. Budget about 3 weeks for first release. 3 apps = 3 listings. Start the 14-day clock as soon as the account exists. |
| D4 | Play listings | Per app: name, icon, screenshots, short/long description, privacy policy URL (have), Data safety form, content rating, target audience, app access instructions for reviewers (a demo login, no real data), account-deletion URL/in-app path (Play requires it when sign-up exists - from memory, UNVERIFIED current wording), target API level meets current requirement (check at submission). Vendor and driver apps are restricted-audience: describe them honestly. |
| D5 | Versioning | pubspec 1.4.0+7 now; each upload needs a higher build number. |

## 5. Phase E - product gaps before real users

| # | Task | Why | Effort guess (not measured) |
|---|------|-----|------|
| E1 | Push notifications (FCM) | Vendor must be alerted to new orders when the app is closed; riders for new pool orders; customers for status. Today realtime works only while the app is open (socket + polling). Needs Firebase project, google-services in 3 apps, server sends high-priority messages, Android 13 notification permission, notification channels, foreground/background handlers, token refresh, logout cleanup. Existing note: Firebase service-account env mismatch to fix. | Medium |
| E2 | Vendor alarm sound | Loud repeating alert for new order until accepted. Bundle sound asset, set channel sound. | Small |
| E3 | Order ETA/preparation time and delivery fee logic | Confirm fee model is what you want before launch. | Small-medium |
| E4 | Menu/stock management for vendors | Sold-out toggle so vendors do not reject orders. UNVERIFIED how far vendor app supports it. | Check first |
| E5 | Customer support flow | In-app "Help with this order" -> phone/email, order id prefilled. | Small |
| E6 | Rider payouts + earnings screen accuracy | Riders will ask "how much did I earn". | Medium |
| E7 | Ratings/reviews, coupons campaign tooling | Nice to have; coupons exist, single-use enforced. | Later |
| E8 | iOS | Not in plan; needs Apple developer account (USD 99/yr) and Mac. Skip until Android works. | Later |
| E9 | Hindi/English copy pass, accessibility | Later. | Small |

## 6. Phase F - operations and reliability (UNVERIFIED unless noted)

| # | Task | Notes |
|---|------|-------|
| F1 | Postgres backups | Verify automated daily dump or RDS snapshots exist AND a restore has been tested. Not checked in this session. Highest-priority ops item once real money flows. |
| F2 | Uptime + error alerts | Free uptime monitor on https://api.kraveo.site health; alert to phone. Add error tracking (Sentry free tier) to backend and apps. |
| F3 | EC2 sizing | t3.micro (1 GB RAM) is thin for Node + Postgres if the DB is on the same box; check memory/swap, set PM2 max-memory restart, log rotation. Move to a managed DB when orders grow. |
| F4 | Secrets hygiene | .env permissions, no secrets in git (checked), rotate keys leaked in chats, SSH key stored only on the owner's machine. |
| F5 | Single-instance limits | Rate limiters and socket rooms are in memory (documented). Fine for one server; needs Redis before running two. |
| F6 | Runbook | One page: "payment stuck", "refund failed" (needs-attention view), "OTP locked", "vendor offline", "rotate webhook secret", "restore DB". backend/ORDER_FLOW_NOTES.md is the start. |
| F7 | GoDaddy domain auto-renew + registrar lock | Losing kraveo.site would kill the API, dashboard and email together. |
| F8 | Staging environment | Currently tests run against a local Docker Postgres and prod is test-mode Razorpay. Consider a second tiny server or at least a staging DB before live keys. |
| F9 | Code review/security pass again before live keys | Run /code-review on the diff since the last audit; re-run adversarial payment tests against live-like config (not live keys). |

## 7. Suggested order (calendar)

Week 1: A1-A7, B1-B3 started, A5 mailbox, F1 backup check, F7.
Week 2: A2 bugs fixed, new APKs, D1 pilot with test-mode (friends), C1 submitted, D3 account created + closed test started if personal, E1 push.
Week 3: C2-C3 live keys + Rs 1 real payment, pilot with tiny real orders, F2 monitoring, F6 runbook.
Week 4+: D4 listings, production release when closed-testing is done, payouts report (C5), E-items by pilot feedback.

## 8. What would change the plan

- If Razorpay rejects the website-only verification: pay the USD 25 and do D3 first.
- If the CA says GST registration is needed before the first live rupee: B4 moves ahead of C1.
- If campus permission (B2) is refused or limited: change launch scope before spending on Play.
