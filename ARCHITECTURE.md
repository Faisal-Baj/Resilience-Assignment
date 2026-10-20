# Architecture note


## 1. Application structure and data model

One Express server serves the HTML pages and the JSON API from the same address. A request goes through:

1. `src/app.js`: security headers, and the `Origin` check for requests that change data.
2. `src/auth.js` (`requireAuth`): checks the token and the session, and loads the user from the database.
3. `src/items.js`: checks the input, finds the item through `visibleItemsFilter`, checks the permission, and saves.
4. `src/permissions.js`: every "who can see / do what" rule. `items.js` uses it.

The pages never decide permissions. They only show the buttons listed in `allowedActions`, and the server checks
every request again.

Tables:

- `Organization`: has users and items.
- `User`: belongs to one organization. Email (lower case), name, role (`MANAGER` or `MEMBER`), argon2id password
  hash, and `disabled`.
- `Session`: one row for each sign-in.
- `RemediationItem`: organization, title, description, assignee, due date, status, completion note, `version` and
  timestamps.
- `AuditEvent`: item, who did it, the action, what changed (JSON) and when. Rows are only ever added.

Due dates are `DATE` columns (no time). An item is overdue when today in `APP_TIMEZONE` is after its due date and it
isn't closed.

## 2. Authentication, token validation, session revocation and authorization boundaries

Login: passwords are hashed with argon2id. Login checks the password, creates a `Session` row, and returns a JWT
signed with HS256 (using the `jose` library) that lasts 15 minutes. The token holds the user id, the session id,
the issuer, the audience and the expiry time. A wrong email, a wrong password and a disabled account all get the same error, and failed logins are limited to
10 per 15 minutes per IP.

Token validation: `requireAuth` runs on every request and does three checks.

1. The signature, that the algorithm is HS256, the expiry, the issuer and the audience. If anything is wrong: `401`.
2. That the session row still exists.
3. That the user isn't disabled. The role and organization come from the database, never from the request.

Session revocation: logout deletes the session row, so even a copied token stops working (check 2). Disabling a user
blocks them on their next request (check 3). Otherwise a session ends when its token expires after 15 minutes.

The token is stored in a cookie, not in `localStorage`:

- `HttpOnly`: scripts on the page can't read it, so an XSS attack can't steal it. API data only goes on the page
  with `textContent`, and the Content Security Policy only allows our own scripts.
- `SameSite=Strict`: the browser doesn't send it with requests from other sites, which stops CSRF. Requests that
  change data also need an `Origin` header that matches the app.

Authorization:

- `visibleItemsFilter`: managers see their organization's items, and members only see the items assigned to them
  now. The list, the count, the detail page and every change use it, so reassigning an item removes the old
  member's access right away.
- The `ACTIONS` table: the assignee starts and submits. A manager who isn't the assignee approves or requests changes.
  Managers can edit and reassign only while an item is Open or In progress.
- Assignees must be in the manager's organization. Clients can only write the fields listed in the `z.strictObject`
  schemas.
- Not visible gives `404`, visible but not allowed gives `403`, and wrong status or an old version gives `409`.

Out of scope, and how I'd add them later:

- Registration: invite links with a token that works once and expires.
- Password reset: the same message for every email, a token that works once and expires, and all the user's sessions
  deleted after the reset.
- MFA: codes from an authenticator app (TOTP) or passkeys as a second login step.
- SSO: OpenID Connect for each organization, still creating our own session row so logout works the same.

## 3. Concurrency and audit consistency

Every item has a `version` number. The page sends the version it saw, and each change runs in one transaction:

1. Load the item and check the permission and status.
2. If the version is old, answer `409`.
3. Run `UPDATE ... WHERE id = ? AND version = ?` and add 1 to the version. If another request saved first, nothing
   matches, so the answer is `409` and the transaction is undone.
4. Add the audit event (who, when, what changed) in the same transaction.

So a change and its audit event are saved together or not at all. If two managers review the same item at the same
moment, only one wins. There's no route that edits audit events. One of the tests locks the item's row to force a
real race, and checks that only one request wins.

## 4. Important indexes and the queries they support

| Query | Index |
|---|---|
| Manager inbox: items of an organization, maybe filtered by status, sorted by due date | `RemediationItem(organizationId, status, dueDate)` |
| Member inbox: items assigned to one user, maybe filtered by status, sorted by due date | `RemediationItem(assigneeId, status, dueDate)` |
| Item history: newest events of one item | `AuditEvent(itemId, createdAt)` |
| Login: find a user by email | unique index on `User(email)` |

Queries are limited: 50 items per page at most, the latest 100 history events, and 200 users in the assignee list.

One weak spot: with no status filter, Postgres still has to sort the organization's items by due date. That's fine
at this size. With much more data I'd check it with `EXPLAIN` and add an index on `(organizationId, dueDate)`.

## 5. Evolving for 500 organizations, 5 million items and bursts of 100 updates per second

I haven't worked at this scale, so this is based on what I studied.

My assumptions: about 10,000 items per organization on average, but some organizations much bigger. People read much
more than they change things, and one update changes one item. 100 updates per second is about 100 small
transactions per second, and from what I understand one PostgreSQL server can handle that. So I'd measure before
adding any infrastructure.

What I'd measure:

- Response time and errors for each route, especially the inbox.
- Slow queries, with `pg_stat_statements` and `EXPLAIN ANALYZE` on the biggest organization's inbox.
- Database CPU, time waiting for connections and locks, and how often users get `409`.
- Table sizes, mostly `AuditEvent`, because it grows fastest.

What I'd change, only if the numbers show a problem:

1. Keyset pagination: continue after the last item seen instead of skipping rows with `OFFSET`, which gets slow on
   big lists. And no exact total count for very big organizations.
2. Better indexes, based on the real query plans.
3. Several copies of the app, with a connection pooler like PgBouncer (it shares a few database connections between
   many requests). The login limit would move from memory to the database or Redis.
4. Split `AuditEvent` by month, so old months can be archived.
5. A read replica (a read-only copy of the database) for the inbox.

## 6. Investigating failures without logging sensitive customer data

The app doesn't log requests today. I'd add:

- Logs with a fixed list of allowed fields: request id, route, status, time taken, user id, organization id and
  error type. Never request bodies, cookies, tokens, passwords or item text.
- The request id in error messages, so a user can report it without sharing their data.
- Alerts when errors, `401`, `409` or `429` suddenly go up.
- `pg_stat_statements` for slow queries (it doesn't keep the values), and the audit trail for "who changed what".

## 7. Introducing a database change safely

1. Change `prisma/schema.prisma`, run `npx prisma migrate dev --name <name>`, and read the SQL it creates. For
   example, `add_user_disabled` only adds one column with a default value.
2. Commit the migration with the code. The tests run every migration on a fresh database, so a broken one fails.
3. Run `prisma migrate deploy` before starting the new code. Never edit a migration that has already run.
4. For a change that breaks running code, like renaming a column: add the new column, write to both, copy the old
   data, switch reads to the new column, and remove the old one in a later release.
5. Take a backup first, and try it on a copy with realistic data to see how long it takes. Big indexes are created
   with `CREATE INDEX CONCURRENTLY` so the table isn't locked.
