import {
  api, startPage, statusBadge, overdueBadge, formatDate, formatDateTime,
  loadDraft, saveDraft, clearDraft, showFieldErrors, showMessage,
} from './common.js';

const itemId = new URLSearchParams(location.search).get('id');
const noteDraftKey = `draft:completionNote:${itemId}`;
const reasonDraftKey = `draft:reason:${itemId}`;

const pageLoading = document.querySelector('#page-loading');
const pageError = document.querySelector('#page-error');
const itemView = document.querySelector('#item-view');
const actionError = document.querySelector('#action-error');
const reloadButton = document.querySelector('#reload-item');
const submitForm = document.querySelector('#submit-form');
const changesForm = document.querySelector('#changes-form');
const activityTemplate = document.querySelector('#activity-row');

let item = null; // the latest copy from the server. Its version is sent with every action
let busy = false; // true while an action is running, so a double click doesn't send it twice

function setText(selector, text) {
  document.querySelector(selector).textContent = text;
}


function render({ item: latest, allowedActions, activity }) {
  item = latest;

  setText('#item-title', item.title);
  const badges = document.querySelector('#item-badges');
  badges.replaceChildren(statusBadge(item.status));
  if (item.isOverdue) badges.append(overdueBadge());
  setText('#item-assignee', item.assignee.name);
  setText('#item-due', formatDate(item.dueDate));
  setText('#item-created', formatDateTime(item.createdAt));
  setText('#item-updated', formatDateTime(item.updatedAt));
  setText('#item-description', item.description || 'No description.');
  setText('#item-completion-note', item.completionNote || '');
  document.querySelector('#completion-note-block').hidden = !item.completionNote;

  // Only show the actions the server says this user can take right now.
  const can = (action) => allowedActions.includes(action);
  const editLink = document.querySelector('#edit-link');
  editLink.href = `/item-form?id=${encodeURIComponent(item.id)}`;
  editLink.hidden = !can('edit');
  document.querySelector('#start-button').hidden = !can('start');
  document.querySelector('#approve-button').hidden = !can('approve');
  submitForm.hidden = !can('submit');
  changesForm.hidden = !can('request-changes');

  const noActionsText = item.status === 'CLOSED'
    ? 'This item is closed and read-only.'
    : 'There is nothing for you to do on this item right now.';
  showMessage(document.querySelector('#no-actions'), allowedActions.length === 0 ? noActionsText : '');

  // Bring back unsaved text, but don't overwrite anything already typed on this page.
  if (!submitForm.elements.completionNote.value) submitForm.elements.completionNote.value = loadDraft(noteDraftKey) || '';
  if (!changesForm.elements.reason.value) changesForm.elements.reason.value = loadDraft(reasonDraftKey) || '';

  document.querySelector('#no-activity').hidden = activity.length > 0;
  document.querySelector('#activity-list').replaceChildren(...activity.map(renderEvent));
}

function renderEvent(event) {
  const row = activityTemplate.content.cloneNode(true);
  const { summary, detail } = describe(event);
  row.querySelector('[data-actor]').textContent = event.actor.name;
  row.querySelector('[data-summary]').textContent = summary;
  showMessage(row.querySelector('[data-detail]'), detail);
  const time = row.querySelector('[data-time]');
  time.dateTime = event.createdAt;
  time.textContent = formatDateTime(event.createdAt);
  return row;
}

// Turns an audit event into a sentence, plus optional detail text.
function describe({ action, changes }) {
  switch (action) {
    case 'CREATED':
      return { summary: `created this item for ${changes.assignee.name}, due ${formatDate(changes.dueDate)}.` };
    case 'UPDATED':
      return {
        summary: 'edited the item.',
        detail: Object.entries(changes)
          .map(([field, { from, to }]) => {
            if (field === 'title') return `Title: "${from}" → "${to}"`;
            if (field === 'dueDate') return `Due date: ${formatDate(from)} → ${formatDate(to)}`;
            return 'Description was changed.';
          })
          .join('\n'),
      };
    case 'REASSIGNED':
      return { summary: `reassigned the item from ${changes.assignee.from.name} to ${changes.assignee.to.name}.` };
    case 'STARTED':
      return { summary: 'started work.' };
    case 'SUBMITTED':
      return { summary: 'submitted the work for review.', detail: changes.completionNote };
    case 'APPROVED':
      return { summary: 'approved the work and closed the item.' };
    case 'CHANGES_REQUESTED':
      return { summary: 'requested changes.', detail: changes.reason };
  }
}

async function loadItem() {
  try {
    render(await api(`/api/items/${encodeURIComponent(itemId)}`));
    itemView.hidden = false;
  } catch (error) {
    itemView.hidden = true;
    const message = error.status === 404 ? 'This item does not exist or you no longer have access to it.' : error.message;
    showMessage(pageError, message);
  } finally {
    pageLoading.hidden = true;
  }
}


async function runAction(action, button, extraFields = {}, form = null) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  actionError.hidden = true;

  try {
    const detail = await api(`/api/items/${encodeURIComponent(item.id)}/${action}`, {
      method: 'POST',
      body: { version: item.version, ...extraFields },
    });
    clearDraft(noteDraftKey);
    clearDraft(reasonDraftKey);
    form?.reset();
    render(detail);
  } catch (error) {
    // The typed text stays in the form. 409 means someone else changed the item first.
    // 404 means the user lost access to it.
    actionError.querySelector('[data-message]').textContent = error.message;
    reloadButton.hidden = error.status !== 409 && error.status !== 404;
    actionError.hidden = false;
    if (form) showFieldErrors(form, error.fields);
  } finally {
    busy = false;
    button.disabled = false;
  }
}

document.querySelector('#start-button').addEventListener('click', (event) => {
  runAction('start', event.currentTarget);
});

document.querySelector('#approve-button').addEventListener('click', (event) => {
  runAction('approve', event.currentTarget);
});

submitForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const completionNote = submitForm.elements.completionNote.value.trim();
  showFieldErrors(submitForm, completionNote ? {} : { completionNote: ['Completion note is required.'] });
  if (completionNote) runAction('submit', submitForm.querySelector('button'), { completionNote }, submitForm);
});

changesForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const reason = changesForm.elements.reason.value.trim();
  showFieldErrors(changesForm, reason ? {} : { reason: ['Please explain what needs to change.'] });
  if (reason) runAction('request-changes', changesForm.querySelector('button'), { reason }, changesForm);
});

submitForm.addEventListener('input', () => saveDraft(noteDraftKey, submitForm.elements.completionNote.value));
changesForm.addEventListener('input', () => saveDraft(reasonDraftKey, changesForm.elements.reason.value));

reloadButton.addEventListener('click', () => {
  actionError.hidden = true;
  loadItem();
});

// Start
try {
  await startPage();
  await loadItem();
} catch (error) {
  pageLoading.hidden = true;
  showMessage(pageError, error.message);
}
