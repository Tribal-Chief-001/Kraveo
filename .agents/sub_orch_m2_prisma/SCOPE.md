# Scope: Milestone 2 — Backend Prisma ORM & PostgreSQL Persistence

## Scope Description
Transform `backend/prisma/schema.prisma` to include all missing models (`DriverPartner`, `ReviewRecord`) and fields (`User`, `Vendor`, `MenuItem`, `Order`), then replace `backend/src/store.ts` across all 25 API endpoints and `validation.ts` with 100% database persistence via Prisma ORM queries.

## Architecture & Code Locations
- Schema file: `backend/prisma/schema.prisma`
- Route files: `backend/src/routes/api.ts`, `backend/src/index.ts`
- Utility files: `backend/src/utils/validation.ts`, `backend/src/types.ts`
- Build verification: `npm run build` in `backend/` must pass with 0 errors (`prisma generate && tsc`).

## Interface Contracts
- All 25 API routes previously using `store.ts` must query Prisma PostgreSQL.
- Database records must persist cleanly across restarts.

## Subtasks
| # | Task | Scope | Status |
|---|------|-------|--------|
| 1 | Prisma Schema Expansion | Update `schema.prisma` with `DriverPartner`, `ReviewRecord`, and missing fields | PLANNED |
| 2 | Route Migration (25 routes + validation.ts) | Replace `store.ts` in `api.ts` & `validation.ts` with Prisma queries | PLANNED |
| 3 | Build & Verification | Ensure `npm run build` passes with 0 errors | PLANNED |
