# Secure Remediation Workspace

A small app for several organizations. Managers create remediation items and assign them, members work on
them, and a different manager approves the result. It's a take-home assignment. The brief is
`D:\Random Faisal\Full_Stack_Candidate_Assessment.pdf` (read it with `pdftotext -layout`, the Read tool can't render
it here). It's graded on correctness, security, testing, maintainability, UX and system design, and **the
server-side security rules matter most**.

**Scope rule (user decision): only build what the assignment asks for.** No extra columns, features,
logging or polish. If you're not sure, leave it out and ask.

## Stack

- Node.js 22 + Express 5, ES modules, **plain JavaScript** (no TypeScript in our code)
- PostgreSQL 17 (local Windows service `postgresql-x64-17`) + **Prisma 7.10.1**
  - Prisma 7 generates its client as TypeScript in `generated/prisma/` (gitignored), so the server and the
    seed run with **`tsx`**, not `node`. The config file is `prisma.config.js` (not .ts).
  - npm's `latest` tag for `prisma` is an 8.0 release candidate. Keep `prisma` and `@prisma/client` on 7.x,
    both on the same version.
  - In Prisma 7, `migrate dev` doesn't run `generate` or the seed, and `migrate reset` doesn't seed.
    Run them yourself.
- Frontend: plain HTML pages, plain JS modules and Tailwind CSS v4 (CLI build). Express serves them from `public/`.
- The brief asks for TypeScript + React. The user chose to keep plain JS and explain it in the README (2026-10-20).
- Tests: Vitest + supertest (API) + jsdom (one frontend test).

## Commands

```bash
npm run setup      # first run: apply migrations (creates the database if missing), generate the Prisma client, seed
npm run dev        # build the CSS once, then run the server with tsx watch on http://localhost:3000
npm test           # run all tests against TEST_DATABASE_URL (wipes that database)
npm run db:seed    # delete all data and create the demo data again
npm run css        # rebuild public/app.css after changing Tailwind classes
npx prisma migrate dev --name <name> && npx prisma generate   # after changing schema.prisma
```

- `.env` (gitignored) holds `DATABASE_URL`, `TEST_DATABASE_URL`, `JWT_SECRET` and `SEED_PASSWORD`. See `.env.example`.
- Files in `public/` are read from disk on every request, so a browser refresh is enough. `npm run dev` only
  builds the CSS when it starts, so run `npm run css` after changing classes.
- `.claude/launch.json` has an `app` entry (`npm run dev`, port 3000) for the browser pane.

## Migrations

- Migrations so far: `init` and `add_user_disabled` (both 2026-10-20). Don't edit or delete one that exists: a
  schema change needs a new migration.
- Prisma refuses `migrate reset` when Claude runs it. Explain that it deletes all data, ask the user, then run
  it again with `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<the user's exact words>"`.

## Structure

```
src/app.js          builds the Express app: helmet, static files, Origin check (CSRF), routers, error handler
src/server.js       only starts app.js on a port (tests import app.js without listening)
src/config.js       reads and checks .env
src/db.js           Prisma client (@prisma/adapter-pg)
src/errors.js       HttpError + JSON error handler (no stack traces sent to the browser)
src/auth.js         argon2 login, jose JWT (15 min), Session rows, requireAuth, logout, /me, login rate limit
src/permissions.js  every access rule: visibleItemsFilter, ACTIONS table, assertCan, allowedActions, requireManager
src/items.js        item and assignee routes, version-checked saves, audit events
src/styles.css      Tailwind input: color theme and shared classes (.btn, .card, .input, .badge, .folder)
prisma/seed.js      demo data
public/             login / index (inbox) / item / item-form .html + js/ (common.js + one file per page)
tests/              helpers.js, global-setup.js, auth.test.js (cases 1-4), items.test.js (5-8), login-page.test.js (9)
README.md           submission doc, sections in the order of the brief's "Submission" list
ARCHITECTURE.md     architecture note, the brief's 7 points in order
```

## Security rules: don't break these

- **Who the user is comes only from `requireAuth`**: the token is checked, the Session row must exist, and
  `req.user` is loaded from the database. Never take a user id, organization id or role from the request.
- **A session is a row in `Session`.** Logout deletes the row, and that is what kills old tokens.
- A disabled user (`User.disabled`) is rejected in `findSession` on every request, and at login with the same
  generic "Invalid email or password." error. There's no admin UI: it's set in the database.
- **Every item query starts from `visibleItemsFilter(req.user)`**: list, count, detail and every change.
  Not visible: 404. Visible but not allowed: 403. Wrong status or old version: 409.
- **Workflow and permission rules live only in `src/permissions.js`.** The frontend just shows `allowedActions`.
- Managers can be assignees, but nobody can approve or request changes on an item assigned to them.
  A submitted item can't be edited or reassigned, so there's no way around this.
- **Every item change** runs inside `prisma.$transaction` and calls `assertSameVersion`, `saveItem`
  (updateMany where `{id, version}`) and `recordAudit` in that same transaction.
- Request bodies use **`z.strictObject`**, and the fields a client may write are listed one by one.
- No request logging. Never log bodies, cookies or tokens. On the frontend, API data goes on the page only
  with `textContent`.
- Due dates are **plain dates** (`DATE`). An item is overdue when today in `APP_TIMEZONE` is after its due date
  and it isn't CLOSED. Only the server works this out.
- Emails are stored in lower case, because login lower-cases what the user types. The seed does this too.
- `GET /api/auth/me` also returns `organizationName` for the header, looked up from `req.user.organizationId`.

## Demo data

`prisma/seed.js` creates two organizations, Org_A and Org_B. The assignment wants **2 managers and 2 members
in each**. Emails look like `User1A@orgA.test`, every account uses `SEED_PASSWORD`, and the README lists them all.

## UI

- Dark theme based on the Resilience website's colors. The colors are tokens in `src/styles.css` (`@theme`):
  `night`, `panel`, `line`, `brand`, `mist`, `royal`, `periwinkle`. Use them (for example `bg-panel`,
  `text-mist`) instead of light slate or indigo classes.
- No sharp corners: `rounded-xl` for buttons and inputs, `rounded-2xl` for cards.
- The header sticks to the top and shows "Remediation Workspace — <org name>". Inbox items are folders, 2 per row.
- A 401 when a page opens goes to `/login` with no message. A 401 on any later request goes to `/login?expired=1`.

## Checking changes

Run `npm test` after touching auth, permissions or items. There are 24 tests covering the brief's 9 required cases.

- The tests hit the real app (`src/app.js`) and a real test database. `vitest.config.js` refuses to run if
  `TEST_DATABASE_URL` is missing or equals `DATABASE_URL`. `tests/global-setup.js` runs `prisma migrate deploy` on it.
- Every test calls `createTestData()` (tests/helpers.js), which wipes the test database and creates Org A
  (managerA, managerA2, memberA, memberA2) and Org B (managerB, memberB). Test files run one at a time
  (`fileParallelism: false`) because they share that database.
- Use the helpers `signIn`, `get`, `post` and `patch`: they add the cookie and the `Origin` header.
- Requests sent "at the same time" never really overlap. The race test uses `lockItemRow` and
  `queriesWaitingForLock` to force a real collision. Without them it doesn't test the database version guard.
- When you add a test, break the rule it covers once and check that the test fails, then undo it.
- Each test file stays under 10 failed logins, because the rate limiter would block the rest.

For checking the running app by hand, use throwaway Node scripts that send real HTTP requests:

- Keep the scripts in the scratchpad and run them from the project folder with `node --env-file=.env <script>.mjs`.
  They read `SEED_PASSWORD` from the environment. Never print it.
- Every request except GET needs the header `Origin: http://localhost:3000`, or the CSRF check returns 403.
- To look at signed-in pages in the browser pane, sign in from a script and set the cookie in the page with
  `document.cookie = "access_token=<jwt>; path=/api"`.
- After 10 failed logins, your IP is blocked for 15 minutes (or until the server restarts).

## Docs (README.md and ARCHITECTURE.md)

- Written in the user's voice: first person, short plain sentences, modest (a fresh grad, mostly theory). No
  exaggeration, no em dashes, no bold. Use the humanizer skill when rewriting them.
- Keep both short. The user must be able to explain every line in the follow-up interview, so a technical term gets a
  few plain words saying what it means.
- When a dependency is added or removed, update the "Libraries used" table in the README.

## Working preferences

- The user is a fresh grad: keep code simple and readable, in few files, and explain decisions plainly.
- Code comments: short, plain, human-sounding sentences. For security rules, say why. The user sometimes
  edits or deletes comments; keep their changes.
- Use Context7 for library docs and setup before writing library-specific code.
- Don't commit or push. The user does that when they're happy.
- At the end of each session, update this file with the `claude-md-improver` skill.
