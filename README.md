# Secure Remediation Workspace

A small web app where organizations assign remediation work, track progress and approve completion.

- **Managers** see every item in their organization, create / edit / reassign items, and review submitted work.
- **Members** see only the items currently assigned to them, start work and submit it for review.

**Stack:** Node.js 22 · Express 5 · PostgreSQL 17 · Prisma 7 · plain HTML + JavaScript · Tailwind CSS v4

## Running it locally

Requirements: Node.js 22+ and a running PostgreSQL server.

```bash
npm install
cp .env.example .env      # then fill in the values (see below)
npm run setup             # create the database tables, generate the Prisma client, load demo data
npm run dev               # http://localhost:3000
```

| `.env` variable | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Random secret (≥ 32 characters) used to sign access tokens |
| `SEED_PASSWORD` | Password given to every demo account (≥ 12 characters) |
| `APP_ORIGIN` | The URL you open in the browser (default `http://localhost:3000`) |
| `COOKIE_SECURE` | `true` when the app is served over HTTPS |
| `APP_TIMEZONE` | Timezone that decides what "today" is for overdue items |

`npm run db:seed` resets the demo data.

### Demo accounts (password = `SEED_PASSWORD`)

| Email | Role | Organization | Notes |
|---|---|---|---|
| User1A@orgA.test | Manager | Org_A | Has items assigned to himself, so User4A must review them |
| User2A@orgA.test | Member | Org_A | |
| User3A@orgA.test | Member | Org_A | |
| User4A@orgA.test | Manager | Org_A | |
| User1B@orgB.test | Manager | Org_B | Second organization, to show data isolation |
| User2B@orgB.test | Member | Org_B | |
| User3B@orgB.test | Manager | Org_B | |
| User4B@orgB.test | Member | Org_B | |

Emails are not case-sensitive at sign-in.

## Project structure

```
src/server.js         Express setup: security headers, static pages, Origin check, routes
src/config.js         Reads and validates .env
src/db.js             Prisma client
src/errors.js         HttpError + JSON error handler
src/auth.js           Login, logout, sessions, access tokens, requireAuth, login rate limit
src/permissions.js    Every "who can see / do what" rule, in one place
src/items.js          Item routes: list, detail, create, edit/reassign, workflow actions, audit log
prisma/schema.prisma  Database tables and indexes
prisma/seed.js        Demo data
public/               HTML pages + one small JS file per page (common.js holds shared helpers)
```

## Authentication and sessions

- **Passwords** are hashed with **argon2id** (`argon2` library).
- **Login** creates a `Session` row and issues a signed **access token** (JWT, HS256, `jose` library) that is
  valid for **15 minutes**. The token contains only the user id (`sub`) and the session id (`sid`).
- **Every request** goes through `requireAuth`, which:
  1. verifies the token's signature, allows **only HS256** (so `alg: none` and other algorithms are rejected),
     and checks **expiry, issuer and audience**. Malformed, tampered or expired tokens get `401`;
  2. checks in the database that the **session still exists**;
  3. takes the user's **role and organization from the database**. Nothing the client sends is used as proof of
     identity, role or organization.
- **Session lifecycle:** a session lasts until the token expires (15 minutes after sign-in) or until logout,
  whichever comes first. Then the user signs in again.
- **Logout** deletes the session row and the cookie. Every previously issued token for that session is rejected
  from then on, even a copy someone kept, because step 2 fails.
- **Login protection:** failed sign-ins are limited to 10 per 15 minutes per IP address. The error is always
  `Invalid email or password.`, whether the email does not exist or the password is wrong. For unknown emails the server still runs argon2 against a dummy hash, so the response time does not
  reveal whether an account exists.

### Where the token is stored, and why

The token is stored in a **cookie** with these flags:

- **`HttpOnly`, against XSS.** JavaScript on the page cannot read the cookie, so an injected script could not
  steal the token. To lower the XSS risk itself, API data is only written to the page with `textContent` (never
  `innerHTML`), and helmet's Content Security Policy only allows our own scripts.
- **`SameSite=Strict`, against CSRF.** The browser does not attach the cookie to requests that start on another
  website. As a second check, every `POST`/`PATCH` must carry an `Origin` header equal to `APP_ORIGIN`, otherwise
  `403`. Pages and API share one origin and CORS is not enabled, so other sites cannot read API responses.
- **`Path=/api`**, plus **`Secure`** when `COOKIE_SECURE=true`.

We do not keep the token in `localStorage`, because any script running on the page can read it.

### Secrets

`.env` (database password, signing key, seed password) is git-ignored; only `.env.example` with placeholders is
committed. The app does not log requests, so passwords and tokens never reach a log. Clients never see stack
traces: unexpected errors return a generic message and the details go to the server console.

## Authorization

All rules live in `src/permissions.js`.

- **What a user can see:** `visibleItemsFilter(user)`. Managers see items of their organization; members see
  items of their organization **that are currently assigned to them**. Every list, count, detail and change
  starts from this filter, so all of them follow the same rules.
- **Reassignment removes access immediately:** the previous member no longer matches the filter, so their next
  request for that item returns `404`.
- **Other organizations:** their items are never found (`404`, which also hides whether an id exists). Items
  can only be assigned to users of the manager's own organization.
- **Actions:** the `ACTIONS` table says who may do what, from which status. The detail endpoint returns
  `allowedActions` from the same table so the UI only shows permitted buttons, but **the server checks the rule
  again on every request**.

Status codes: `401` not signed in · `403` not allowed · `404` not visible · `409` wrong status or changed by
someone else · `400` invalid input · `429` too many failed logins.

## Workflow

| Current status | Action | Who | New status |
|---|---|---|---|
| Open | Start work | Current assignee | In progress |
| In progress | Submit (non-empty completion note) | Current assignee | Pending review |
| Pending review | Approve | A manager who is not the assignee | Closed |
| Pending review | Request changes (non-empty reason) | A manager who is not the assignee | In progress |

Managers can edit or reassign only while an item is Open or In progress. Reassignment keeps the status. Closed
items are read-only.

**Due dates** are **calendar dates** (`YYYY-MM-DD`, Postgres `DATE` column), not timestamps. An item is
**overdue** when today's date in `APP_TIMEZONE` is after its due date and it is not Closed. An item due today
is not overdue yet. Only the server decides this; the inbox filter and the `isOverdue` flag use the same rule.

## Data integrity

- **Writable fields are listed explicitly.** Request bodies are validated with strict Zod schemas. Unknown
  fields such as `organizationId`, `status` or `createdAt` are rejected with `400`.
- **Audit log:** creation, edits, reassignment and every status change write an `AuditEvent` with the actor,
  the time and what changed (e.g. `{ status: { from, to } }`). There is no API to change or delete audit events.
- **Consistency:** each change and its audit event are saved in **one database transaction**, so if anything
  fails, neither is saved.
- **Stale edits and races:** every item has a `version` number that goes up on each change. The client sends
  the version it saw, and the update runs as `UPDATE … WHERE id = ? AND version = ?`. An outdated or competing
  request (for example, approve and request changes at the same moment) gets `409`. Exactly one of them wins.
- **Bounded queries:** page size max 50 (default 10), page number max 1000, activity history shows the latest
  100 events, the assignee list returns at most 200 users. Indexes match the inbox queries
  (`organizationId, status, dueDate` for managers and `assigneeId, status, dueDate` for members) and the
  activity history (`itemId, createdAt`).

## Frontend

Plain HTML pages styled with Tailwind, with one small JavaScript module per page.

- The inbox has server-side pagination plus status and overdue filters.
- Pages show loading, empty and error states. Opening the app while signed out shows the login page; if the session expires while the user is working, the login page says so.
- Forms keep their input on errors. Typed text is also saved in `sessionStorage`, so it survives signing in again.
- Buttons are disabled while a request is running. On the server, the version check stops a repeated action
  from being applied twice.
- All controls are labeled native elements, so everything works with the keyboard. The layout works on phones.

## How this was checked

There are no automated tests in the repository. Every rule above was exercised by hand with real HTTP requests:

- token tampering, the wrong algorithm, issuer or audience, and expired tokens;
- logout;
- cross-organization access, reassignment and self-review;
- every workflow transition, stale and competing edits;
- the audit trail, pagination limits and the login rate limit.

## Known limitations

This is a take-home project. It has not been load-tested, security-audited or deployed, and it is **not
production-ready**.

- No automated tests in the repository.
- The login rate limit is kept in memory: it resets on restart and does not work across several server
  instances. Behind a reverse proxy, Express `trust proxy` must be set or all users share the proxy's IP.
- No refresh tokens: users sign in again every 15 minutes.
- `HttpOnly` prevents token theft, but a successful XSS could still send requests as the user while the page is
  open. CSP and `textContent` rendering are the defences against that.
- No user-administration screen: accounts come from the seed script, and users cannot be disabled.
- An item assigned to a manager needs a second manager to review it.
- The audit log is append-only at the application level only. Someone with direct database access could still
  change it.
- Session rows of expired tokens are not cleaned up.
- One timezone (`APP_TIMEZONE`) for all organizations.
- `npm audit` reports an issue in a **development-only** dependency (Tailwind CLI's file watcher). It is not part
  of the running app.
- HTTPS is not configured. In a real deployment, serve over HTTPS and set `COOKIE_SECURE=true`.
