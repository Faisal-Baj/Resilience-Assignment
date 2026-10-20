// Every rule about who can see and do what is in this file.
// Routes call these functions before every read and every change. The frontend only gets the
// result (allowedActions) to decide which buttons to show. Hiding a button is not the protection:
// the server always checks.
import { HttpError } from './errors.js';

// Which items a user can see. Every list, count, detail and update query starts from this filter.
// Managers see every item in their organization. Members only see items assigned to them right now,
// so after a reassignment the old member loses access on their next request.
export function visibleItemsFilter(user) {
  if (user.role === 'MANAGER') {
    return { organizationId: user.organizationId };
  }
  return { organizationId: user.organizationId, assigneeId: user.id };
}

// The workflow as a table.
//   who:  'manager'  = any manager in the organization
//         'assignee' = the person the item is assigned to right now
//         'reviewer' = a manager who is not the assignee (nobody reviews their own work)
//   from: the statuses where the action is allowed
//   to:   the status after the action
export const ACTIONS = {
  edit: { who: 'manager', from: ['OPEN', 'IN_PROGRESS'] },
  start: { who: 'assignee', from: ['OPEN'], to: 'IN_PROGRESS', auditAction: 'STARTED' },
  submit: { who: 'assignee', from: ['IN_PROGRESS'], to: 'PENDING_REVIEW', auditAction: 'SUBMITTED' },
  approve: { who: 'reviewer', from: ['PENDING_REVIEW'], to: 'CLOSED', auditAction: 'APPROVED' },
  'request-changes': { who: 'reviewer', from: ['PENDING_REVIEW'], to: 'IN_PROGRESS', auditAction: 'CHANGES_REQUESTED' },
};

function isRightPerson(user, item, who) {
  if (who === 'manager') return user.role === 'MANAGER';
  if (who === 'assignee') return item.assigneeId === user.id;
  if (who === 'reviewer') return user.role === 'MANAGER' && item.assigneeId !== user.id;
  return false;
}

// Throws 403 if the user is the wrong person, or 409 if the item is in the wrong status.
export function assertCan(user, item, action) {
  const rule = ACTIONS[action];
  if (!isRightPerson(user, item, rule.who)) {
    throw new HttpError(403, 'You are not allowed to do this.');
  }
  if (!rule.from.includes(item.status)) {
    throw new HttpError(409, 'This action is not available in the item\'s current status. Reload to see the latest version.');
  }
}

// What this user can do with this item right now. Sent to the frontend to pick which buttons to show.
export function allowedActions(user, item) {
  return Object.keys(ACTIONS).filter((action) => {
    const rule = ACTIONS[action];
    return isRightPerson(user, item, rule.who) && rule.from.includes(item.status);
  });
}

// Add this to routes only managers may use (create an item, list the people to assign).
export function requireManager(req, res, next) {
  if (req.user.role !== 'MANAGER') throw new HttpError(403, 'Only managers can do this.');
  next();
}
