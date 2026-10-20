// Tests 5-8: organization isolation, permissions inside an organization, the workflow,
// and stale or competing changes.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  prisma, createTestData, signIn, get, post, patch, auditEvents, lockItemRow, queriesWaitingForLock,
} from './helpers.js';

let users;
let items;

beforeEach(async () => {
  ({ users, items } = await createTestData());
});

afterAll(async () => {
  await prisma.$disconnect();
});

const findItem = (id) => prisma.remediationItem.findUniqueOrThrow({ where: { id } });

describe('5. Another organization', () => {
  it("can't see our items in the list, the count or the detail view", async () => {
    const managerB = await signIn(users.managerB);

    const list = await get(managerB, '/api/items');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1); // only Org B's own item is counted
    expect(list.body.items.map((item) => item.id)).toEqual([items.orgB.id]);

    const detail = await get(managerB, `/api/items/${items.open.id}`);
    expect(detail.status).toBe(404); // 404, not 403, so it doesn't even learn the id exists
  });

  it("can't change our items, and nothing is saved", async () => {
    const managerB = await signIn(users.managerB);

    const edit = await patch(managerB, `/api/items/${items.open.id}`, { version: 1, title: 'Hacked' });
    const approve = await post(managerB, `/api/items/${items.pending.id}/approve`, { version: 1 });

    expect(edit.status).toBe(404);
    expect(approve.status).toBe(404);
    expect(await findItem(items.open.id)).toMatchObject({ title: 'Open item of memberA', version: 1 });
    expect(await findItem(items.pending.id)).toMatchObject({ status: 'PENDING_REVIEW', version: 1 });
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("a manager can't assign items to people in another organization", async () => {
    const managerA = await signIn(users.managerA);

    const create = await post(managerA, '/api/items', {
      title: 'New item',
      description: '',
      assigneeId: users.memberB.id, // Org B
      dueDate: '2030-01-01',
    });
    const reassign = await patch(managerA, `/api/items/${items.open.id}`, { version: 1, assigneeId: users.memberB.id });

    expect(create.status).toBe(400);
    expect(create.body.fields.assigneeId).toBeDefined();
    expect(reassign.status).toBe(400);
    expect(await prisma.remediationItem.count({ where: { assigneeId: users.memberB.id } })).toBe(1); // still only Org B's own item
  });
});

describe('6. Not allowed inside the same organization', () => {
  it("a member can't create, edit or approve items", async () => {
    const memberA = await signIn(users.memberA);

    const create = await post(memberA, '/api/items', {
      title: 'New item',
      description: '',
      assigneeId: users.memberA.id,
      dueDate: '2030-01-01',
    });
    const edit = await patch(memberA, `/api/items/${items.open.id}`, { version: 1, title: 'Changed' });
    const approve = await post(memberA, `/api/items/${items.pending.id}/approve`, { version: 1 });

    expect(create.status).toBe(403);
    expect(edit.status).toBe(403); // they can see the item (it's theirs), but they may not edit it
    expect(approve.status).toBe(403); // and they can't approve their own work
    expect(await findItem(items.pending.id)).toMatchObject({ status: 'PENDING_REVIEW', version: 1 });
  });

  it("a manager can't approve or request changes on an item assigned to themselves", async () => {
    const managerA = await signIn(users.managerA);
    const url = `/api/items/${items.managersOwn.id}`;

    const approve = await post(managerA, `${url}/approve`, { version: 1 });
    const requestChanges = await post(managerA, `${url}/request-changes`, { version: 1, reason: 'Redo it' });

    expect(approve.status).toBe(403);
    expect(requestChanges.status).toBe(403);
    expect(await findItem(items.managersOwn.id)).toMatchObject({ status: 'PENDING_REVIEW', version: 1 });

    // A different manager can review it.
    const managerA2 = await signIn(users.managerA2);
    expect((await post(managerA2, `${url}/approve`, { version: 1 })).status).toBe(200);
  });

  it("a member only sees their own items, and loses access as soon as the item is reassigned", async () => {
    const memberA = await signIn(users.memberA);
    const managerA = await signIn(users.managerA);

    expect((await get(memberA, `/api/items/${items.otherMember.id}`)).status).toBe(404);
    const list = await get(memberA, '/api/items');
    expect(list.body.items.map((item) => item.id).sort()).toEqual([items.open.id, items.pending.id].sort());

    // memberA can open their item, then the manager gives it to memberA2.
    expect((await get(memberA, `/api/items/${items.open.id}`)).status).toBe(200);
    const reassign = await patch(managerA, `/api/items/${items.open.id}`, { version: 1, assigneeId: users.memberA2.id });
    expect(reassign.status).toBe(200);
    expect(reassign.body.item.status).toBe('OPEN'); // reassigning keeps the status

    expect((await get(memberA, `/api/items/${items.open.id}`)).status).toBe(404);
    expect((await post(memberA, `/api/items/${items.open.id}/start`, { version: 2 })).status).toBe(404);
  });
});

describe('7. Workflow', () => {
  it('start, submit and approve, with an audit event for each step', async () => {
    const memberA = await signIn(users.memberA);
    const managerA = await signIn(users.managerA);
    const url = `/api/items/${items.open.id}`;

    const start = await post(memberA, `${url}/start`, { version: 1 });
    expect(start.status).toBe(200);
    expect(start.body.item).toMatchObject({ status: 'IN_PROGRESS', version: 2 });

    const submit = await post(memberA, `${url}/submit`, { version: 2, completionNote: 'Rotated the key.' });
    expect(submit.status).toBe(200);
    expect(submit.body.item).toMatchObject({ status: 'PENDING_REVIEW', version: 3 });

    const approve = await post(managerA, `${url}/approve`, { version: 3 });
    expect(approve.status).toBe(200);
    expect(approve.body.allowedActions).toEqual([]); // closed items are read-only

    // Check what was really saved, not just what the API answered.
    expect(await findItem(items.open.id)).toMatchObject({ status: 'CLOSED', completionNote: 'Rotated the key.', version: 4 });
    const events = await auditEvents(items.open.id);
    expect(events.map((event) => [event.action, event.actorId])).toEqual([
      ['STARTED', users.memberA.id],
      ['SUBMITTED', users.memberA.id],
      ['APPROVED', users.managerA.id],
    ]);
    expect(events[2].changes).toEqual({ status: { from: 'PENDING_REVIEW', to: 'CLOSED' } });

    // A closed item can't be edited.
    expect((await patch(managerA, url, { version: 4, title: 'Changed' })).status).toBe(409);
  });

  it('rejects a transition from the wrong status, and a submit without a completion note', async () => {
    const memberA = await signIn(users.memberA);
    const managerA = await signIn(users.managerA);
    const url = `/api/items/${items.open.id}`;

    // The item is Open: it can't be approved or submitted yet.
    expect((await post(managerA, `${url}/approve`, { version: 1 })).status).toBe(409);
    expect((await post(memberA, `${url}/submit`, { version: 1, completionNote: 'Done' })).status).toBe(409);

    await post(memberA, `${url}/start`, { version: 1 });
    const emptyNote = await post(memberA, `${url}/submit`, { version: 2, completionNote: '   ' });
    expect(emptyNote.status).toBe(400);
    expect(emptyNote.body.fields.completionNote).toEqual(['Completion note is required.']);

    expect(await findItem(items.open.id)).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    expect((await auditEvents(items.open.id)).map((event) => event.action)).toEqual(['STARTED']);
  });
});

describe('8. Stale and competing changes', () => {
  it('rejects an edit made on an old copy, and saves nothing from it', async () => {
    const managerA = await signIn(users.managerA);
    const managerA2 = await signIn(users.managerA2);
    const url = `/api/items/${items.open.id}`;

    // Both managers opened the item at version 1. The first one saves.
    const first = await patch(managerA, url, { version: 1, title: 'Title from managerA' });
    const second = await patch(managerA2, url, { version: 1, title: 'Title from managerA2' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await findItem(items.open.id)).toMatchObject({ title: 'Title from managerA', version: 2 });
    const events = await auditEvents(items.open.id);
    expect(events).toHaveLength(1); // no audit event for the rejected edit
    expect(events[0].changes).toEqual({ title: { from: 'Open item of memberA', to: 'Title from managerA' } });
  });

  it('two managers reviewing at the same moment: exactly one wins, and the audit log matches', async () => {
    const managerA = await signIn(users.managerA);
    const managerA2 = await signIn(users.managerA2);
    const url = `/api/items/${items.pending.id}`;

    // Sent normally, one request finishes before the other even reads the item, so the race never
    // happens. So we lock the item's row first: both requests read version 1, pass every check,
    // and get stuck right before saving. Then we unlock, and both saves run against each other.
    const unlock = await lockItemRow(items.pending.id);
    const reviews = Promise.all([
      post(managerA, `${url}/approve`, { version: 1 }),
      post(managerA2, `${url}/request-changes`, { version: 1, reason: 'Add evidence.' }),
    ]);
    await vi.waitFor(async () => expect(await queriesWaitingForLock()).toBe(2), { timeout: 5000 });
    await unlock();
    const [approve, requestChanges] = await reviews;

    expect([approve.status, requestChanges.status].sort()).toEqual([200, 409]);

    const winner = approve.status === 200 ? { status: 'CLOSED', action: 'APPROVED' } : { status: 'IN_PROGRESS', action: 'CHANGES_REQUESTED' };
    expect(await findItem(items.pending.id)).toMatchObject({ status: winner.status, version: 2 });
    const events = await auditEvents(items.pending.id);
    expect(events.map((event) => event.action)).toEqual([winner.action]); // one change, one audit event
  });
});
