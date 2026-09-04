# Database migration runbook

The repository now contains a complete initial Prisma migration in `migrations/20260904_make_order_otp_nullable` plus a follow-up legacy-OTP cleanup migration.

- For a new database, set `DATABASE_URL` and run `npx prisma migrate deploy`.
- For an existing database created before migrations were tracked, take a backup, verify the live schema matches `schema.prisma`, then baseline the initial migration once with `npx prisma migrate resolve --applied 20260904_make_order_otp_nullable`. After baselining, run `npx prisma migrate deploy` so the follow-up cleanup migration removes legacy OTP values. Do not run the full initial migration against an already-populated schema.
- After baselining or applying the migration, deploy the backend with `JWT_SECRET`, `ADMIN_PASSCODE`, Razorpay credentials, and the configured client/admin origins.

The migrations remove the legacy `1234` OTP default, clear existing rows that still contain that legacy value, and allow OTP storage to remain empty until an order reaches `ARRIVED_AT_GATE`.
