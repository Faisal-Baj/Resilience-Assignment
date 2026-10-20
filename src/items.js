// Routes for remediation items. Every route:
//  1. needs a signed-in user (requireAuth)
//  2. checks the input with a strict schema (unknown fields are rejected)
//  3. only reads or changes items that pass visibleItemsFilter(req.user)
//  4. saves a change and its audit event in one database transaction, so you never get one without the other
import express from 'express';
import { z } from 'zod';
import { prisma } from './db.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { requireAuth } from './auth.js';
import { ACTIONS, allowedActions, assertCan, requireManager, visibleItemsFilter } from './permissions.js';

export const itemsRouter = express.Router();

// ---------- Due dates ----------
// Due dates are plain dates ("2026-10-20") with no time. "Today" always uses one timezone
// (APP_TIMEZONE), so every user gets the same answer to "is this item overdue?".

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.appTimezone }).format(new Date()); // "YYYY-MM-DD"
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

// ---------- Input validation ----------
// A client can only send the fields listed here. The server sets everything else
// (organization, status, version, timestamps, audit events).

const version = z.number().int().positive();

const itemFields = {
  title: z.string().trim().min(1, 'Title is required.').max(200, 'Title must be 200 characters or fewer.'),
  description: z.string().trim().max(5000, 'Description must be 5000 characters or fewer.'),
  assigneeId: z.string().min(1, 'Choose who this item is assigned to.').max(100),
  dueDate: z.iso.date('Enter a valid due date.'),
};

const createSchema = z.strictObject(itemFields);
const editSchema = z.strictObject(itemFields).partial().extend({ version });

const listQuerySchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'PENDING_REVIEW', 'CLOSED']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

const versionOnlySchema = z.strictObject({ version });
const submitSchema = z.strictObject({
  version,
  completionNote: z.string().trim().min(1, 'Completion note is required.').max(5000, 'Completion note must be 5000 characters or fewer.'),
});
const requestChangesSchema = z.strictObject({
  version,
  reason: z.string().trim().min(1, 'Please explain what needs to change.').max(2000, 'Reason must be 2000 characters or fewer.'),
});

// ---------- Helpers ----------

const person = { select: { id: true, name: true } };

function toItemResponse(item) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    status: item.status,
    dueDate: toDateString(item.dueDate),
    isOverdue: item.status !== 'CLOSED' && toDateString(item.dueDate) < today(),
    completionNote: item.completionNote,
    assignee: item.assignee,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// Loads one item the user is allowed to see, or throws 404. Other organizations' items also get 404
// (not 403), so nobody can tell whether an item id exists.
async function findVisibleItem(db, user, itemId) {
  const item = await db.remediationItem.findFirst({
    where: { id: itemId, ...visibleItemsFilter(user) },
    include: { assignee: person },
  });
  if (!item) throw new HttpError(404, 'Item not found.');
  return item;
}

// Items can only be assigned to people in the manager's own organization.
async function findAssignee(db, user, assigneeId) {
  const assignee = await db.user.findFirst({
    where: { id: assigneeId, organizationId: user.organizationId },
    select: { id: true, name: true },
  });
  if (!assignee) {
    throw new HttpError(400, 'Please correct the highlighted fields.', {
      assigneeId: ['Choose a person from your organization.'],
    });
  }
  return assignee;
}

const STALE_ITEM = 'Someone else changed this item after you opened it. Reload to see the latest version.';

// The client sends the version it saw. If the item has changed since then, refuse with 409.
function assertSameVersion(item, clientVersion) {
  if (item.version !== clientVersion) throw new HttpError(409, STALE_ITEM);
}

// Saves only if the item still has the version we read. If another request changed it in between,
// nothing is saved and the error undoes the whole transaction, audit event included.
async function saveItem(tx, item, data) {
  const { count } = await tx.remediationItem.updateMany({
    where: { id: item.id, version: item.version },
    data: { ...data, version: { increment: 1 } },
  });
  if (count === 0) throw new HttpError(409, STALE_ITEM);
}

function recordAudit(tx, user, itemId, action, changes) {
  return tx.auditEvent.create({ data: { itemId, actorId: user.id, action, changes } });
}

// Everything the item page needs: the item, what this user can do with it, and its history.
async function getItemDetail(user, itemId) {
  const item = await prisma.remediationItem.findFirst({
    where: { id: itemId, ...visibleItemsFilter(user) },
    include: {
      assignee: person,
      auditEvents: { include: { actor: person }, orderBy: { createdAt: 'desc' }, take: 100 },
    },
  });
  if (!item) throw new HttpError(404, 'Item not found.');

  return {
    item: toItemResponse(item),
    allowedActions: allowedActions(user, item),
    activity: item.auditEvents.map((event) => ({
      id: event.id,
      action: event.action,
      actor: event.actor,
      changes: event.changes,
      createdAt: event.createdAt,
    })),
  };
}

// ---------- Routes: reading ----------

// Inbox: managers see their whole organization, members only their own items.
itemsRouter.get('/items', requireAuth, async (req, res) => {
  const { status, overdue, page, pageSize } = listQuerySchema.parse(req.query);
  const todayDate = new Date(today());

  const where = { ...visibleItemsFilter(req.user) };
  if (status) where.status = status;
  if (overdue === 'true') where.AND = [{ status: { not: 'CLOSED' } }, { dueDate: { lt: todayDate } }];
  if (overdue === 'false') where.OR = [{ status: 'CLOSED' }, { dueDate: { gte: todayDate } }];

  // The count and the list use the same `where`, so the total never counts items the user can't see.
  const [total, items] = await prisma.$transaction([
    prisma.remediationItem.count({ where }),
    prisma.remediationItem.findMany({
      where,
      include: { assignee: person },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  res.json({ items: items.map(toItemResponse), page, pageSize, total });
});

itemsRouter.get('/items/:id', requireAuth, async (req, res) => {
  res.json(await getItemDetail(req.user, req.params.id));
});

// The people a manager can assign items to (everyone in their organization).
itemsRouter.get('/users', requireAuth, requireManager, async (req, res) => {
  const users = await prisma.user.findMany({
    where: { organizationId: req.user.organizationId },
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
    take: 200,
  });
  res.json({ users });
});

// ---------- Routes: creating and editing (managers) ----------

itemsRouter.post('/items', requireAuth, requireManager, async (req, res) => {
  const input = createSchema.parse(req.body);
  const user = req.user;

  const itemId = await prisma.$transaction(async (tx) => {
    const assignee = await findAssignee(tx, user, input.assigneeId);
    const item = await tx.remediationItem.create({
      data: {
        title: input.title,
        description: input.description,
        assigneeId: assignee.id,
        dueDate: new Date(input.dueDate),
        organizationId: user.organizationId, // from the signed-in user, never from the request
      },
    });
    await recordAudit(tx, user, item.id, 'CREATED', { title: input.title, assignee, dueDate: input.dueDate });
    return item.id;
  });

  res.status(201).json(await getItemDetail(user, itemId));
});

// Edit or reassign an item. Only allowed while it is Open or In progress (see ACTIONS.edit).
// Reassigning doesn't change the status.
itemsRouter.patch('/items/:id', requireAuth, async (req, res) => {
  const input = editSchema.parse(req.body);
  const user = req.user;

  await prisma.$transaction(async (tx) => {
    const item = await findVisibleItem(tx, user, req.params.id);
    assertCan(user, item, 'edit');
    assertSameVersion(item, input.version);

    // Find what really changed, for the update and the audit log.
    const data = {};
    const changes = {};
    const current = { title: item.title, description: item.description, dueDate: toDateString(item.dueDate) };
    for (const field of ['title', 'description', 'dueDate']) {
      if (input[field] !== undefined && input[field] !== current[field]) {
        data[field] = field === 'dueDate' ? new Date(input.dueDate) : input[field];
        changes[field] = { from: current[field], to: input[field] };
      }
    }

    let newAssignee = null;
    if (input.assigneeId !== undefined && input.assigneeId !== item.assigneeId) {
      newAssignee = await findAssignee(tx, user, input.assigneeId);
      data.assigneeId = newAssignee.id;
    }

    if (Object.keys(data).length === 0) return; // nothing changed, nothing to save

    await saveItem(tx, item, data);
    if (Object.keys(changes).length > 0) {
      await recordAudit(tx, user, item.id, 'UPDATED', changes);
    }
    if (newAssignee) {
      await recordAudit(tx, user, item.id, 'REASSIGNED', { assignee: { from: item.assignee, to: newAssignee } });
    }
  });

  res.json(await getItemDetail(user, req.params.id));
});

// ---------- Routes: workflow ----------

// Moves an item to its next status. ACTIONS decides who can do it and from which status.
async function changeStatus(user, itemId, action, clientVersion, details = {}) {
  const { to, auditAction } = ACTIONS[action];

  await prisma.$transaction(async (tx) => {
    const item = await findVisibleItem(tx, user, itemId);
    assertCan(user, item, action);
    assertSameVersion(item, clientVersion);

    const data = { status: to };
    if (action === 'submit') data.completionNote = details.completionNote;

    await saveItem(tx, item, data);
    await recordAudit(tx, user, item.id, auditAction, { status: { from: item.status, to }, ...details });
  });

  return getItemDetail(user, itemId);
}

itemsRouter.post('/items/:id/start', requireAuth, async (req, res) => {
  const { version } = versionOnlySchema.parse(req.body);
  res.json(await changeStatus(req.user, req.params.id, 'start', version));
});

itemsRouter.post('/items/:id/submit', requireAuth, async (req, res) => {
  const { version, completionNote } = submitSchema.parse(req.body);
  res.json(await changeStatus(req.user, req.params.id, 'submit', version, { completionNote }));
});

itemsRouter.post('/items/:id/approve', requireAuth, async (req, res) => {
  const { version } = versionOnlySchema.parse(req.body);
  res.json(await changeStatus(req.user, req.params.id, 'approve', version));
});

itemsRouter.post('/items/:id/request-changes', requireAuth, async (req, res) => {
  const { version, reason } = requestChangesSchema.parse(req.body);
  res.json(await changeStatus(req.user, req.params.id, 'request-changes', version, { reason }));
});
