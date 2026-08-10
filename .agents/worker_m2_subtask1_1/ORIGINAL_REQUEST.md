## 2026-08-10T01:54:53+05:30
You are Worker 1 for Subtask 1: Prisma Schema Expansion of Milestone 2 (Backend Prisma ORM & PostgreSQL Persistence).
Your working directory is: /home/lucifer/Documents/Projects/Kraveo/.agents/worker_m2_subtask1_1

Scope & Context:
- Scope document: /home/lucifer/Documents/Projects/Kraveo/.agents/sub_orch_m2_prisma/SCOPE.md
- Explorer Report: /home/lucifer/Documents/Projects/Kraveo/.agents/teamwork_preview_explorer_m2_subtask1_1/handoff.md
- Target File: backend/prisma/schema.prisma

Task:
Update backend/prisma/schema.prisma to include all missing models, enums, fields, and relational bindings as specified in the Explorer handoff report:
1. Enum: DutyStatus (ONLINE, OFFLINE, IN_TRANSIT).
2. Models: DriverPartner, ReviewRecord.
3. User: Add kraveoCoins Int @default(0), upiId String?, and back-relations (ordersPlaced, ordersDriven, driverProfile, vendorsOwned, reviewsGiven, reviewsReceived).
4. Vendor: Add userId String?, totalRatingsCount Int @default(50), lat Float @default(23.0768), lng Float @default(76.8524), rename bannerUrl to bannerImage String, and relations (user, menuItems, orders, reviews).
5. MenuItem: Add rating Float? @default(4.5), ratingCount Int? @default(0), orderItems OrderItem[].
6. Order: Add isReviewed Boolean @default(false), review ReviewRecord?.
7. OrderItem: Add menuItemId String?, menuItem MenuItem?.
8. Relation cascading rules and indexes.

Verification Requirement:
- Run `npx prisma generate` or `npm run build` in backend/ to generate the updated Prisma Client.
- Verify TypeScript compilation (`npx tsc --noEmit` or `npm run build` in backend/) passes with 0 errors.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Produce a detailed change report in handoff.md in your working directory (/home/lucifer/Documents/Projects/Kraveo/.agents/worker_m2_subtask1_1/handoff.md) including build command outputs.
Then send a message back to the sub-orchestrator.
