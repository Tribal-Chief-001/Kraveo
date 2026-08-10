## 2026-08-09T21:31:29Z
You are the Implementation Worker for Subtask 2 of Milestone 2 (Backend Prisma ORM & PostgreSQL Persistence Migration).

Working directory: `/home/lucifer/Documents/Projects/Kraveo/.agents/worker_m2_subtask2_1`

Scope Document: `/home/lucifer/Documents/Projects/Kraveo/.agents/sub_orch_m2_prisma_gen2/SCOPE.md`
Explorer Handoffs:
- `/home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m2_subtask2_1/handoff.md`
- `/home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m2_subtask2_2/handoff.md`
- `/home/lucifer/Documents/Projects/Kraveo/.agents/explorer_m2_subtask2_3/handoff.md`

Your Task:
Migrate all API routes, validation helpers, and database seeders from in-memory `store.ts` arrays to 100% live Prisma ORM database queries connected to PostgreSQL.

Specific Action Items:
1. `backend/src/utils/seedDb.ts`:
   - Expand database seeding to upsert all 9 users (`usr-1` to `usr-9`), 3 driver partners (`usr-4`, `usr-8`, `usr-9`), 3 vendors (`ven-1`, `ven-2`, `ven-3`), 7 menu items (`item-1` to `item-7`), initial orders (`ord-101`, `ord-102`), and driver locations (`usr-4`).
   - Use `prisma.user.upsert`, `prisma.driverPartner.upsert`, `prisma.vendor.upsert`, `prisma.menuItem.upsert`, `prisma.order.upsert`, `prisma.driverLocation.upsert` so seeding is idempotent.

2. `backend/src/utils/validation.ts`:
   - Remove `import { menuItems } from '../store';`. Import `prisma` from `../db`.
   - Convert `validateAndCalculateOrder` to an `async` function.
   - Query menu items from PostgreSQL via `await prisma.menuItem.findMany({ where: { id: { in: itemIds }, vendorId } })`. Check availability (`isAvailable`), calculate subtotal, delivery fee, tax, and coupons.

3. `backend/src/routes/api.ts`:
   - Remove `import ... from '../store';` entirely! Zero references to `store.ts` must remain in `api.ts`.
   - Convert all synchronous Express route handlers to `async (req: Request, res: Response, next: NextFunction) => { ... }`.
   - Replace all 28 API routes relying on `store.ts` with direct Prisma ORM database queries (`prisma.user`, `prisma.vendor`, `prisma.menuItem`, `prisma.order`, `prisma.orderItem`, `prisma.driverPartner`, `prisma.reviewRecord`, `prisma.driverLocation`, `prisma.payment`).
   - Remove all `try/catch` fallbacks to `store.ts`. Ensure queries return proper DB results or error HTTP codes (404/500).
   - In `POST /orders`, `await validateAndCalculateOrder(...)` and create order with nested order items using Prisma `order.create({ data: { ..., items: { create: ... } }, include: { items: true, vendor: true, customer: true } })`.
   - In `POST /reviews`, wrap updates across `User` (coins +10), `Order` (isReviewed=true), `MenuItem` (ratings), `Vendor` (Bayesian rating formula), `DriverPartner` (rating), and `ReviewRecord` (creation) in `prisma.$transaction`.
   - In driver lookups (`/drivers/:id`, `/reviews`), search `DriverPartner` by `OR: [{ id: driverId }, { userId: driverId }]`.

4. Verification & Testing:
   - Run `npx prisma generate` and `npm run build` in `backend/` and verify **0 compilation / TypeScript errors**.
   - Verify `grep -rn "store" backend/src/routes/api.ts backend/src/utils/validation.ts` returns 0 matches for `store.ts` imports.

5. Deliverable:
   - Create `handoff.md` in your working directory `/home/lucifer/Documents/Projects/Kraveo/.agents/worker_m2_subtask2_1/handoff.md` with:
     1. Observation (files changed, build results).
     2. Logic Chain (implementation details, transaction handling, fallback elimination).
     3. Caveats (database environment requirements, type casts).
     4. Conclusion (summary of zero-error compilation and zero fallback references).
     5. Verification Method (commands to verify build and zero fallback references).
   - Send a message to caller with path to your `handoff.md`.

MANDATORY INTEGRITY WARNING — include this verbatim in your execution:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
