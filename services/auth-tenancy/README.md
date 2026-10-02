# Super Admin / Owner / Company module

Node 20+, Express 5, PostgreSQL (plain `pg`, no ORM). JWT bearer auth.

## Run
    cp .env.example .env      # fill SUPER_ADMIN_*, JWT_SECRET, DATABASE_URL
    npm install
    npm run migrate
    npm run dev
    node tests/e2e.mjs        # 65 checks; needs a fresh DB and the .env values the test file expects

## Owner approval
Self-registered Owners are created `PENDING` and get `403 PENDING_APPROVAL` on login until the Super Admin approves.
Rejected ones get `403 REGISTRATION_REJECTED`. Owners created by the Super Admin are approved from the start.

## Roles
| Role | Lives in | Can do |
|---|---|---|
| SUPER_ADMIN | `.env` only | create / list / suspend Owners, reset Owner passwords. No access to tenant data routes. |
| OWNER | `users` | create + edit own company (exactly one), manage all company users, every permission |
| ADMIN / MANAGER / STAFF / VIEWER | `users` | per `src/lib/permissions.js`; Owner can override per user |

## API
| Method | Path | Who |
|---|---|---|
| POST | /api/auth/super-admin/login | public |
| POST | /api/auth/register | public (Owner self-signup; account is PENDING, no token) |
| POST | /api/auth/login | Owner + company users |
| GET | /api/auth/me | any |
| POST | /api/auth/change-password | Owner + company users |
| GET, POST | /api/admin/owners | Super Admin (`?status=PENDING` = approval queue; response has `pendingCount`) |
| POST | /api/admin/owners/:id/approve | Super Admin |
| POST | /api/admin/owners/:id/reject | Super Admin (optional `reason`; only PENDING) |
| GET, PATCH | /api/admin/owners/:id | Super Admin (`isActive:false` = suspend whole company) |
| POST | /api/admin/owners/:id/reset-password | Super Admin |
| POST | /api/company | Owner (once) |
| GET, PATCH | /api/company | `company:read` / `company:update` |
| GET, POST | /api/users | `users:read` / `users:manage` |
| GET | /api/users/meta | roles + permission list for the UI |
| GET, PATCH, DELETE | /api/users/:id | DELETE = deactivate |
| POST | /api/users/:id/reset-password | `users:manage` |

## Adding a tenant module (voters, campaigns, ...)
1. Table gets `company_id uuid NOT NULL REFERENCES companies(id)` + an index on it.
2. Mount: `authenticate, requireTenantUser, requirePasswordChanged, requireCompany`.
3. Route: `requirePermission('voters:read')`.
4. Every query has `WHERE company_id = $n` with `req.auth.companyId`. Never read a company id from body, query or URL.

## Where this sits in the Urbayne repo
This module lives in `services/auth-tenancy`, deliberately outside the pnpm workspace (`apps/*`, `packages/*`). It is plain JS with its own `package-lock.json`, so use `npm` inside this folder; the root `pnpm install`, typecheck and tests do not touch it.

Give it its own database. `sql/001_init.sql` creates a `users` table, and `packages/db` already has a different `users` table (phone OTP login). Pointing both at the same database will break one of them.

It also defaults to port 4000, same as `apps/api`. Set `PORT` if you run both locally.
