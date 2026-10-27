# Kraveo: poora progress report (27 Oct 2026)

Ye report aaj (27 Oct 2026) ke asli check par bani hai: git, production server, database, Razorpay (test mode) aur purane chats/docs ka record. Jo cheez maine khud nahi dekhi, usko "unverified" likha hai.

---

## 0. Ek nazar mein

**Product:** VIT Bhopal ke liye campus food delivery. 3 Android apps (Customer, Restaurant Partner, Delivery Partner), React admin dashboard, landing site, aur Node/Postgres backend (AWS EC2).

**Halat:** Software lagbhag poora hai aur production par live hai. Par **abhi tak koi asli customer nahi hai, aur asli paisa kabhi chala nahi** (Razorpay test mode). Aakhri order 15 Oct ko tha (aapka test). 12 din se koi activity nahi.

**Sabse badi 5 baatein jo aaj mili:**
1. **Group order ka refund fail hua** (15 Oct, test): ₹1365 customer se liya, order cancel hua, refund 3 baar "invalid request" se fail hua. Paisa abhi bhi Razorpay mein pada hai. Ye hamaare naye code ka asli bug ya Razorpay ki test-mode limit ho sakta hai. **Turant debug karna hai.**
2. **Razorpay webhook server tak pahunch hi nahi raha** (15–27 Oct ke logs mein 0 hit). Server bacha hua hai kyunki hamaara "reconcile" job payment dhoondh leta hai, par live mein ye theek karna zaroori hai.
3. **2 paid orders 15 din se READY_FOR_PICKUP par atke hain** (koi rider ne accept nahi kiya). Aisi stuck order ke liye automatic alert ya cancel nahi hai.
4. **Phone par poora test ab bhi baaki hai:** kuch test hue (DB mein dikhte hain), par koi poora clean order-to-delivery run nahi mila.
5. **Live jaane ke liye aapke kaam bache hain:** Razorpay live KYC, CA (GST/FSSAI/TDS), release signing key, Play Store/APK distribution, purani keys rotate karna.

---

## 1. Production snapshot (27 Oct 2026, maine abhi dekha)

| Cheez | Halat |
|---|---|
| API (`api.kraveo.site`) | Online, health OK, 14 din se bina restart |
| Dashboard (`admin.kraveo.site`) | 200 OK |
| Landing (`kraveo.site`) | 200 OK. Pages: `/privacy`, `/terms`, `/refunds`, `/contact` |
| Server | AWS `t3.micro` (2 CPU, 911 MB RAM), 14 GB disk free, load ~0 |
| Server code version | `01fdb54` (wahi jo GitHub par, yaani latest) |
| Database migrations | Sab lagi hain (aakhri: `20261012_categories`) |
| Backup | Roz raat 21:30 UTC, DB + photos, 26 Oct tak bante rahe |
| SSL cert | Valid, 29 Dec 2026 tak (63 din) |
| Reboot pending | **Haan** (kernel update). Server 11 hafte se bina reboot |
| Error log | Refund ke 3 errors (15 Oct), baaki saaf |
| Bot traffic | 1694 alag IP, hazaaron 404 (scanners). Sirf 4 chhote 5xx, sab bots se |
| fail2ban / firewall (ufw) | Dono band (AWS security group ports band rakhta hai) |

**Database:**

| Cheez | Ginti |
|---|---|
| Orders (kul) | 11 (sab test) |
| Pichle 14 din ke orders | 3 |
| Users | 7 students, 8 vendors, 5 drivers, 1 admin |
| Restaurants approved | 8 (6 demo + "Dhaba 1" + 1) |
| Riders | 3 approved, 1 suspended |
| Live dishes | 34, pending 0 |
| Categories | 25 |
| Settlements | 1 pending (₹180) |
| Group orders | 1 (cancelled, refund failed) |
| Push devices registered | 6 |

---

## 2. Aaj ke recon se naye findings

### F1. Group order ka refund fail (P0, paise ka maamla)
- **Kya hua:** 15 Oct 15:09 ko 3 restaurants ka group order bana (₹1365, UPI). 15:11 par payment mila (webhook nahi aaya, reconcile ne pakda). Restaurants ne 10 minute mein accept nahi kiya, to 15:22 par poora group cancel hua. Refund 3 baar try hua (15:22, 15:23, 15:24) aur teeno baar Razorpay ne "invalid request" bola.
- **Razorpay ka sach:** payment `pay_ToEDFgfHGSbDry` **captured** hai, ₹1365, refund 0. Paisa wapas nahi gaya.
- **Ab:** order `c5f32ac1...` "CANCELLED, PAID, refund FAILED". Sibling 2 orders bhi CANCELLED/PAID (jab tak primary ka refund nahi hota wo aise hi rahenge, ye design hai).
- **Jo ham jaante hain:** 4 pehle ke refund (single orders, UPI, ₹110 se ₹220) sab theek hue. Sirf ye group wala (₹1365) fail hua. Dono UPI hain.
- **Do sambhaavit wajah:** (a) humare group-refund code mein koi galat parameter, (b) Razorpay test-mode UPI refund ki koi limit ya rule bade amount par. **Maine abhi pata nahi lagaya.**
- **Agla kadam:** asli error text nikaalna. Iske liye test-mode mein wahi refund call chalani padegi. Wo test paisa hai, par aapka "haan" chahiye. Fix hone tak group orders par bharosa mat karo.

### F2. Razorpay webhook server tak nahi pahunch raha (P0 live se pehle)
- 15–27 Oct ke nginx logs mein `/api/payments/webhook` par **0 hit**. 15 Oct ke payment par audit mein likha hai "webhook never arrived".
- Abhi kaam isliye chal raha hai: customer ka app payment verify karwata hai, aur backend har kuch minute mein Razorpay se khud poochta hai (reconcile).
- **Karna:** Razorpay dashboard mein webhook set karna: URL `https://api.kraveo.site/api/payments/webhook`, events `payment.captured`, `order.paid`, `refund.processed`, `refund.failed`. Live mode ke liye alag se phir.

### F3. Atke hue orders, aur "rider nahi mila" ka koi SLA nahi (P1)
- 12 Oct se 2 orders (Sharma Highway Dhaba, ₹205 ke) READY_FOR_PICKUP par atke hain. Koi rider nahi mila, aur system na alert deta hai na cancel karta hai.
- Asli customer ke saath ye bahut bura hoga (khaana ready, customer intezaar mein, paisa le liya).
- **Fix:** "10–15 minute mein rider nahi mila" par admin ko alert aur (optional) auto-cancel+refund. Ye mai bana sakta hoon.

### F4. Server hardening ke chhote gaps (P1/P2)
- Kernel reboot pending. Reboot par backend khud uthega, par ye boot-service aaj tak asli reboot par chali nahi (unit teen hafte pehle bani, server 11 hafte se chal raha hai).
- fail2ban nahi hai (SSH par bots ki koshish rok-tok nahi).
- 1 server = 1 point of failure.

### F5. Dobara dekha, theek hai
- Landing ke sab policy pages live hain.
- Dashboard ka naya code (Categories, Edit restaurant, import) live hai.
- Backup roz ban rahe hain, aur ab photos ka bhi.
- Settlement job chal rahi hai (ek asli ₹180 ka settlement bana).
- Production mein koi 5xx ya crash nahi (bots ke 4 chhote ko chhodkar).

---

## 3. Kya kya ho chuka hai

### Timeline (136 commits, 6 Aug se 12 Oct 2026)
- **Aug:** monorepo, 3 apps ka base, backend, Firebase/FCM ka shuruaati setup, dashboard. (Us waqt ke "100% ready" claims galat the, wo records mein sudhaare gaye.)
- **Sep:** Postgres par asli shift, domain `kraveo.site`, Razorpay jodna, naya design system (`kraveo_ui`), Google Sign-In (students) aur phone+password (partners), landing site.
- **1–2 Oct:** partner sign-up + admin approval, **asli order flow** (server-authoritative, payment, refund, rider pool, gate OTP, realtime), security hardening, payment reliability (reconcile, refund retry), legal pages, launch roadmap.
- **5 Oct:** push notifications (FCM) end to end, campus drop points (BH1–BH8, GH1, GH2), live map, rider tracking, restaurant location (GPS).
- **6 Oct:** 8 reviewers ka pre-demo bug-hunt aur sab fix, demo catalog (6 restaurants, 34 dishes, photos).
- **7 Oct:**
  - Pricing: restaurant ka apna daam, commission (percent/flat), admin approval, ek ₹25 fee.
  - Settlements: roz raat 10 baje restaurant ka settlement, encrypted payout details, finance analytics, rider ledger.
  - Multi-restaurant orders (₹15 per extra restaurant), do independent reviews ke baad.
- **12 Oct:** managed categories, multi-category restaurants, Edit restaurant, dish bulk actions, CSV menu import, photo upload, migration pehle live data ki copy par test hui.

### Kaun sa hissa kya halat mein hai

| Hissa | Version | Halat |
|---|---|---|
| Backend | live (`01fdb54`) | Feature-complete, 1039 tests, 35 suites |
| Dashboard | live | Orders, Live map, Needs attention, Applications, Vendors, Catalog, Categories, Finance, Drivers, Customers, Analytics, Settings. 790 tests |
| Customer app | 1.9.0+15 | APK ready (`build/apks/`), 433 tests. **Phone par asli full test baaki** |
| Restaurant app | 1.9.0+15 | APK ready, 514 tests |
| Rider app | 1.8.0+14 | APK ready, 394 tests |
| Landing site | live | Privacy, terms, refunds, contact |
| Push notifications | live backend | 6 devices registered. Asli phone par full test unverified |

### Jo features ab maujood hain
- Order flow: payment, accept/reject, rider claim, pickup, gate OTP, cancel, refund, auto-expiry, reconcile.
- Multi-restaurant (3 tak, admin se badal sakte ho), ek payment, ek rider, ek OTP.
- Pricing: vendor price + commission + rounding + approval + fee settings.
- Roz settlement + payout accounts (encrypted) + finance reports + CSV.
- Admin: restaurant edit, categories, dish bulk/import/duplicate, photo upload.
- Maps, drop points, live rider tracking, push alarms for restaurant.
- Security: rate limits, token revoke, OTP lock, role checks, audit log, uploads ki jaanch.

---

## 4. Kya bacha hai, priority ke saath

### P0: asli customers aur asli paise se pehle
| # | Kaam | Kaun |
|---|---|---|
| 1 | Group refund ka bug/limit nikaalna aur theek karna | **Claude** (aapka "haan" test refund ke liye) |
| 2 | Razorpay webhook configure karna (test aur live) | **Aap** (dashboard) + Claude check |
| 3 | Phone par poora test: single order, group order, cancel, refund, push, rider flow | **Aap** (Claude test plan bana sakta hai) |
| 4 | Razorpay live KYC, live keys, pehla ₹1–10 ka asli payment + refund | **Aap** + Claude |
| 5 | Release signing key banana aur offline backup (khoya to Play update band) | Claude banaye, **aap** backup rakho |
| 6 | Google OAuth app "Production" mode par (warna sirf test users sign in kar paayenge) | **Aap** (Google Cloud) |
| 7 | CA: GST, FSSAI, TDS 194O, vendor agreements | **Aap** |
| 8 | Backup server ke bahar (S3) + ek baar restore test | Claude (AWS mein kharch, aapka "haan") |
| 9 | Uptime alert (free) + error alert | Claude/aap |
| 10 | Purani keys: Firebase old key, Maps old key, AWS root keys rotate | **Aap** |
| 11 | `PAYOUT_ENC_KEY.local.txt` ko safe jagah backup | **Aap** |
| 12 | 2 restaurants ke pins (Sharma Highway Dhaba, Campus Night Canteen) | **Aap** (dashboard) |
| 13 | Asli restaurants onboard karna (menu CSV import se) | Aap + Claude |

### P1: 1000 concurrent tak jaane ke liye
1. Load test (1000 users, 200 orders, 300 sockets): kabhi nahi hua.
2. Server `t3.micro` se bada (kam se kam 4 GB), DB alag (RDS).
3. Home ka data 30 sec cache, photos CDN par.
4. Rate limit IP se hata kar user se jodna (campus WiFi ek IP hai).
5. "Rider nahi mila" SLA (F3).
6. Admin login: abhi ek shared passcode. Alag accounts aur 2-factor.
7. Do server chalane ke liye Redis (socket + limiter).
8. fail2ban, reboot test (raat ko, backup ke baad).

### P2: sudhaar (zaroori nahi, par achcha)
- Rider app: group stop ka Navigate button turant nahi aata.
- Customer map par group ke sab restaurants ke pin nahi.
- "Thali" aur "Thalis" categories ka merge, Home chips ka order.
- Auto-payout (RazorpayX ka alag account).
- Uploaded photos ka cleanup, per-restaurant reviews, richer coupons.
- iPhone/iPad: abhi koi app nahi. Raasta: customer ka PWA (free) ya Apple account ($99/saal). Pehle Android.
- Wok & Roll mein sirf 4 dishes.

---

## 5. Purane roadmap (`Docs/17`) ka mapping

| Phase | Kaam | Halat |
|---|---|---|
| A: test mode | Policy pages, support email, support number | Done (support sirf email, phone nahi) |
| A | Phone par full order run | **Aadha** (kuch tests hue, clean full run nahi) |
| A | Purana Razorpay test secret regenerate | Unverified |
| B: legal | Entity, campus permission, FSSAI, GST, bank, agreements, DPDP | **Sab baaki (aapka)** |
| C: live paisa | Razorpay KYC, live keys, pehla live payment, fee decision | **Baaki** |
| C | Settlement/payout plan | **Done** (software). Auto-payout baaki |
| D: distribution | Release keystore, Play account, listings, APK pilot page | **Baaki** |
| E: product | Push, alarm, menu mgmt, support flow, rider earnings, ETA/fee | **Done** (zyadatar) |
| E | iOS | Nahi (Docs/17 mein bhi skip) |
| F: ops | Backups, alerts, sizing, secrets, single-instance limit, runbook, domain lock, staging | **Backups done**, baaki zyadatar baaki |

Council audit (2 Oct): uske kaafi P0/P1 items backend hardening (2 aur 6 Oct) mein fix hue. Mai ne uski poori list ka line-by-line dobara check aaj nahi kiya.

---

## 6. Quality ke numbers

| Cheez | Ginti |
|---|---|
| Commits | 136 (6 Aug se 12 Oct) |
| Tracked files / source lines | 1013 files, ~67,500 lines (tests ke bina) |
| Backend tests | 1039 pass |
| Dashboard tests | 790 pass |
| Customer / Restaurant / Rider tests | 433 / 514 / 394 pass |
| Independent reviews | 8 pre-demo reviewers, settlements, groups, categories (koi blocker nahi mila) |
| Production par asli orders | 0 (sirf test) |

---

## 7. Jo ab tak sabit nahi hua (honest list)
- Kisi phone par poora end-to-end run (customer, restaurant, rider ek saath).
- Asli push notification (app band, screen lock) ka natija.
- Asli paise ka payment aur refund.
- Group order ka refund (aaj fail dikha).
- Dashboard ke naye screens ka browser mein asli upyog (photo upload, CSV import).
- 1000 log ka load.
- Server reboot ke baad ka behaviour.
- Legal/tax ka koi bhi hissa.

---

## 8. Agle 7 din ka suggested plan
1. **Aaj/kal:** F1 (group refund) debug aur fix (Claude). F2 webhook set (aap).
2. **2–3 din:** teeno APK install karke phone test. Claude test script de sakta hai aur nateeje padh kar fix karega.
3. **Saath mein:** "rider nahi mila" SLA (F3), uptime alert, S3 backup.
4. **Phir:** load test, server upgrade ka faisla (aapka kharch).
5. **Parallel (hafton ka kaam):** Razorpay KYC, CA, Google OAuth production, release key.

---

*Report ka stored record: `Docs/24_progress_report_2026-10-27.md`. Memory mein bhi update save hai.*
