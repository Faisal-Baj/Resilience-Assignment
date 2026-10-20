# Secure Remediation Workspace

Small multi-organization app: managers create and assign remediation items, members work on them,
and a different manager approves the result. This is a take-home assignment where the **server-side
security rules are what gets graded**.

**Scope rule (user decision): build only what the assignment explicitly requires.** No extra columns,
features, logging, or polish. When in doubt, leave it out and ask.

## Stack

- Node.js 22 + Express 5, ES modules, **plain JavaScript** (no TypeScript in our code)
- PostgreSQL 17 (local Windows service `postgresql-x64-17`) + **Prisma 7.10.1**
  - Prisma 7 generates its client as TypeScript into `generated/prisma/` (gitignored), so the server and
    seed run with **`tsx`** instead of `node`. Config is `prisma.config.js` (not .ts).
  - npm's `latest` tag for `prisma` points at an 8.0 RC — keep `prisma` and `@prisma/client` on 7.x and matching.
  - Prisma 7 `migrate dev` does not run `generate` or `seed`; run them explicitly.
- Frontend: plain HTML pages + vanilla JS modules + Tailwind CSS v4 (CLI build), served by Express from `public/`.

## Commands

```bash
npm run setup      # prisma migrate deploy + prisma generate + seed (first run)
npm run dev        # build CSS once, then server with tsx watch on http://localhost:3000
npm run db:seed    # wipe and re-create demo data
npm run css        # rebuild public/app.css after changing Tailwind classes
npx prisma migrate dev --name <name> && npx prisma generate   # after changing schema.prisma
```

`.env` (gitignored) holds `DATABASE_URL`, `JWT_SECRET`, `SEED_PASSWORD`; see `.env.example`.

## Structure

```
src/server.js       helmet, static files, Origin check (CSRF), routers, error handler
src/config.js       reads/validates .env
src/db.js           Prisma client (@prisma/adapter-pg)
src/errors.js       HttpError + JSON error handler (no stack traces to clients)
src/auth.js         argon2 login, jose JWT (15 min), Session rows, requireAuth, logout, login rate limit
src/permissions.js  ALL access rules: visibleItemsFilter, ACTIONS table, assertCan, allowedActions, requireManager
src/items.js        item + assignee routes, version-guarded saves, audit events
public/             login / index (inbox) / item / item-form .html + js/ (common.js + one file per page)
```

## Security rules — do not break these

- **Identity comes only from `requireAuth`** (token → Session row exists → `req.user` from DB).
  Never read user id, organization id or role from the request.
- **Session = a row in `Session`.** Logout deletes the row; that is what revokes old tokens.
- **Every item query starts from `visibleItemsFilter(req.user)`** — list, count, detail and mutations.
  Not visible → 404. Visible but not allowed → 403. Wrong status or stale version → 409.
- **Workflow/permission rules live only in `src/permissions.js`**; the frontend just shows `allowedActions`.
- **Every item mutation**: inside `prisma.$transaction`, `assertSameVersion`, `saveItem` (updateMany
  where `{id, version}`), and `recordAudit` in the same transaction.
- Request bodies use **`z.strictObject`**; writable fields are listed explicitly.
- No request logging; never log bodies, cookies or tokens. Frontend: API data only via `textContent`.
- Due dates are **calendar dates** (`DATE`); overdue = today in `APP_TIMEZONE` > dueDate and not CLOSED,
  computed only on the server.

## Verifying changes

There are no automated tests (user decision, 2026-10-20). Behaviour was verified with a throwaway Node script
that makes real HTTP requests against the running server (75 checks: token tampering/alg/iss/aud/expiry,
logout, cross-org isolation, reassignment, self-review, workflow, stale/competing edits,
audit trail, paging, rate limit). Re-run equivalent checks after touching auth, permissions or items.
Note: exhausting the login rate limit blocks your IP for 15 minutes until the server restarts.

## Working preferences

- The user is a fresh grad: keep code simple, readable, and in few files; explain decisions plainly.
- Use Context7 for library docs/setup before writing library-specific code.
- Do not commit or push — the user pushes when satisfied.
- At the end of each session, update this file using the `claude-md-improver` skill.
