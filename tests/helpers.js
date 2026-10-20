// Code shared by the API tests: fresh test data, signing in, and sending requests.
// The tests call the real app (routes, permissions, database). Nothing is mocked.
import request from 'supertest';
import argon2 from 'argon2';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';

export { app, prisma, config };

// Every test account uses this password. It only exists in the test database.
export const PASSWORD = 'test-password-123';

// Deletes all rows, then creates the same small data set, so every test starts from a clean state.
//   Org A: managerA, managerA2, memberA, memberA2      Org B: managerB, memberB
export async function createTestData() {
  // Child tables first, because of the foreign keys.
  await prisma.auditEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.remediationItem.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  const passwordHash = await argon2.hash(PASSWORD);
  const orgA = await prisma.organization.create({ data: { name: 'Org A' } });
  const orgB = await prisma.organization.create({ data: { name: 'Org B' } });

  const makeUser = (name, org, role) =>
    prisma.user.create({
      data: { name, role, email: `${name.toLowerCase()}@test.local`, organizationId: org.id, passwordHash },
    });

  const users = {
    managerA: await makeUser('managerA', orgA, 'MANAGER'),
    managerA2: await makeUser('managerA2', orgA, 'MANAGER'),
    memberA: await makeUser('memberA', orgA, 'MEMBER'),
    memberA2: await makeUser('memberA2', orgA, 'MEMBER'),
    managerB: await makeUser('managerB', orgB, 'MANAGER'),
    memberB: await makeUser('memberB', orgB, 'MEMBER'),
  };

  const makeItem = (title, org, assignee, status) =>
    prisma.remediationItem.create({
      data: {
        title,
        status,
        organizationId: org.id,
        assigneeId: assignee.id,
        dueDate: new Date('2030-01-01'),
        completionNote: status === 'PENDING_REVIEW' ? 'Fixed it.' : null,
      },
    });

  const items = {
    open: await makeItem('Open item of memberA', orgA, users.memberA, 'OPEN'),
    pending: await makeItem('Submitted item of memberA', orgA, users.memberA, 'PENDING_REVIEW'),
    managersOwn: await makeItem('Submitted item of managerA', orgA, users.managerA, 'PENDING_REVIEW'),
    otherMember: await makeItem('Open item of memberA2', orgA, users.memberA2, 'OPEN'),
    orgB: await makeItem('Open item in Org B', orgB, users.memberB, 'OPEN'),
  };

  return { users, items };
}

// Signs in through the real login route. Returns the cookie to send with the next requests.
export async function signIn(user) {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Origin', config.appOrigin)
    .send({ email: user.email, password: PASSWORD });
  if (res.status !== 204) throw new Error(`Sign-in failed with status ${res.status}`);
  return res.headers['set-cookie'][0].split(';')[0]; // "access_token=<the token>"
}

// Send a request as a signed-in user. POST and PATCH also need our Origin header,
// otherwise the CSRF check answers 403.
export const get = (cookie, url) => request(app).get(url).set('Cookie', cookie);
export const post = (cookie, url, body) =>
  request(app).post(url).set('Cookie', cookie).set('Origin', config.appOrigin).send(body);
export const patch = (cookie, url, body) =>
  request(app).patch(url).set('Cookie', cookie).set('Origin', config.appOrigin).send(body);

// The audit trail of an item as saved in the database, oldest first.
export function auditEvents(itemId) {
  return prisma.auditEvent.findMany({ where: { itemId }, orderBy: { createdAt: 'asc' } });
}

// Locks an item's row in the database until the returned unlock() is called.
// A request that tries to save the item waits inside the database until then.
// The race test uses this to make two requests really happen at the same moment.
export async function lockItemRow(itemId) {
  let lockTaken;
  let release;
  const taken = new Promise((resolve) => (lockTaken = resolve));
  const transaction = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RemediationItem" WHERE id = ${itemId} FOR UPDATE`;
      lockTaken();
      await new Promise((resolve) => (release = resolve));
    },
    { timeout: 10000 },
  );
  await taken;

  return async function unlock() {
    release();
    await transaction;
  };
}

// How many database queries are waiting for a lock right now.
export async function queriesWaitingForLock() {
  const [{ count }] = await prisma.$queryRaw`
    SELECT count(*)::int AS count FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND datname = current_database()`;
  return count;
}
