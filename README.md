# Secure Remediation Workspace

My submission for the Full Stack Engineering Assessment. It's a small web app where managers create remediation
items and assign them, members work on them, and a different manager approves the result.

Stack: Node.js 22, Express 5, PostgreSQL 17, Prisma 7, plain HTML and JavaScript, Tailwind CSS and Vitest. It's not
TypeScript and React. I explain why under [Completed scope](#completed-scope).

What's in the repo:

- `src/` is the API, `public/` the pages, and `tests/` the tests.
- `package-lock.json` is the lockfile.
- `prisma/` has the database schema, the migrations and the seed data.
- `.env.example` has the settings, with no real secrets.
- `ARCHITECTURE.md` is the architecture note.

## Libraries used

| Library | What it does |
|---|---|
| `express` | The web server: the API routes and serving the pages |
| `prisma`, `@prisma/client`, `@prisma/adapter-pg` | Talks to PostgreSQL, and runs the migrations and the seed |
| `zod` | Validates inputs |
| `argon2` | Hashes passwords |
| `jose` | Creates and checks the login tokens (JWT) |
| `cookie-parser` | Reads the token cookie from requests |
| `helmet` | Adds security headers to every response |
| `express-rate-limit` | Limits failed logins |
| `dotenv` | Loads the settings from `.env` |
| `tsx` | Runs the server (Prisma 7 generates its client in TypeScript) |
| `tailwindcss`, `@tailwindcss/cli` | Styles the pages and builds the CSS file |
| `vitest` | Runs the tests |
| `supertest` | Sends requests to the app inside the tests |
| `jsdom` | A fake browser page for the frontend test |

## Setup instructions

You need Node.js 22.12 or newer and PostgreSQL running on your machine.

```bash
npm install
cp .env.example .env      # then fill in the values
npm run setup             # creates the database, the tables and the demo data
npm run dev               # http://localhost:3000
```


## Demo accounts

All accounts use the password in `SEED_PASSWORD`. Emails aren't case sensitive.

| Org_A | Org_B |
|---|---|
| User1A@orgA.test (manager) | User1B@orgB.test (manager) |
| User4A@orgA.test (manager) | User3B@orgB.test (manager) |
| User2A@orgA.test (member) | User2B@orgB.test (member) |
| User3A@orgA.test (member) | User4B@orgB.test (member) |

Some items are assigned to User1A, so User4A has to review those.

## Test commands

```bash
npm test
```

The tests use a real PostgreSQL database (`TEST_DATABASE_URL`), not mocks. Before each test, that database is
emptied and filled with the same small data set, so the tests don't affect each other. They refuse to run if
`TEST_DATABASE_URL` is missing or is the same as `DATABASE_URL`.

| Test from the brief | File |
|---|---|
| 1. Login and an authenticated request | `tests/auth.test.js` |
| 2. Invalid credentials, and malformed, tampered, expired, wrong issuer and wrong audience tokens | `tests/auth.test.js` |
| 3. Logout | `tests/auth.test.js` |
| 4. Disabled user | `tests/auth.test.js` |
| 5. Another organization's data (reads and changes) | `tests/items.test.js` |
| 6. Not allowed inside the same organization | `tests/items.test.js` |
| 7. Valid workflow and invalid transition | `tests/items.test.js` |
| 8. Stale edit and two reviews at the same moment | `tests/items.test.js` |
| 9. Frontend: failed sign-in and double click | `tests/login-page.test.js` |

The test groups inside the files start with the same numbers.

## Time spent

About 8 hours. Around 1 hour to plan, around 5 hours building the app, and around 1:30 hour adding the tests and the disabled user rule and finishing the
docs.

## Completed scope

Done:

- Two organizations with 2 managers and 2 members each. Login and logout.
- The access rules, checked on the server. Organizations are separated, members only see their own items, nobody
  reviews their own item, and reassigning an item removes the old member's access right away.
- Signed tokens that last 15 minutes, with a session row checked on every request. Logout stops old tokens, disabled
  users are locked out, and failed logins are limited.
- Strict input checks, an audit event for every change, and a version number on each item so stale or competing
  changes are rejected.
- The workflow: start, submit, approve and request changes.
- An inbox with pagination and filters, a form for managers, and an item page with the allowed actions and the
  history. It has loading, empty, error and "session expired" states, and it keeps your input if something fails.
- Tests for all 9 cases in the brief.

Not done: TypeScript and React. I used plain JavaScript and plain HTML pages. Most of what I know is from university,
and I wanted to understand and explain every line I submit. With four simple pages, a framework would add more to
learn without changing the security, which is all on the server. I know it's not what was asked, so it's my first
priority below.

## Assumptions

- Users come from the seed, since registration is out of scope. To disable a user, you set `disabled = true` in the
  database.
- Managers can be assignees too. Their submitted items are reviewed by another manager.
- The "request changes" reason is saved in the item's history, not on the item.
- Due dates are calendar dates in one timezone (`APP_TIMEZONE`). An item due today isn't overdue yet.
- An item you can't see gives `404`, so you can't tell it exists. An action you're not allowed to do gives `403`.

## Known limitations

I haven't load tested it, it hasn't had a security audit, and it isn't deployed, so it isn't production ready.

- Plain JavaScript and HTML instead of TypeScript and React.
- Only the login page has a frontend test. I checked the other pages by hand.
- The failed login limit is kept in memory. It resets on restart and wouldn't work across several servers.
- No refresh tokens, so users sign in again every 15 minutes.
- No admin page for users, and a disabled user can still be picked as an assignee.
- Old session rows are never deleted.
- The audit log can't be edited through the app, but someone with direct database access could change it.
- One timezone for all organizations, and HTTPS isn't set up.
- `npm audit` flags a package that's only used during development (Tailwind's file watcher).
  `npm audit --omit=dev` shows 0 issues.

## Next three priorities

1. Move to TypeScript and React. The API stays the same, so the tests would catch mistakes.
2. Add frontend tests for the item page and the form, and run `npm test` automatically on every push.
3. Add an admin action to disable users and end their sessions, and clean up old sessions.

## Architecture note

See [ARCHITECTURE.md](ARCHITECTURE.md). It follows the 7 points in the brief.

## Handoff for the next engineer

- Start with `src/permissions.js`. Every access rule is in that one file. Then read `ARCHITECTURE.md`.
- Please keep these rules: who the user is only comes from `requireAuth`, every item query starts from
  `visibleItemsFilter(req.user)`, and every item change runs in one transaction with a version check and an audit
  event. Run `npm test` after any change.
- After changing `prisma/schema.prisma`, run `npx prisma migrate dev --name <name>` and then `npx prisma generate`.
- Run `npm run css` after changing Tailwind classes.
- Scripts that send POST or PATCH requests need the header `Origin: http://localhost:3000`, or they get `403`.
- 10 failed logins block your IP for 15 minutes. Restarting the server clears it.

## AI usage note

I used Claude Code (Anthropic's coding agent) in the Claude desktop app to plan and to write the code, the tests and
these docs. I used Context7 to look up current library docs. I chose what to build and the main design. The agent
wrote most of the code, and I went through every file until I understood it. This was my first time writing
automated tests.

How we checked the work:

- We broke the code on purpose. We removed five rules one at a time, like the disabled user check and the version
  check, and made sure the right test failed each time.
- Before the tests existed, I checked the rules with small scripts that sent real requests to the running server.
- We copied only the repo files to a new folder with empty databases, and ran the setup, the tests and the server
  there.
- The agent's knowledge of Prisma 7 was out of date, so we checked the setup against the current docs.

Two things the agent got wrong at first:

- Its tampered token test changed the user id inside the token. It would have passed even without signature checks,
  because the session belongs to another user. Now it changes the expiry instead, which only the signature check can
  catch.
- Its race test sent two reviews at once, but they never really overlapped: removing the version check didn't make
  it fail. Now the test locks the item's row so the two requests really collide.
