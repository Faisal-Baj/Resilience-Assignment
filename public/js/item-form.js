import { api, startPage, loadDraft, saveDraft, clearDraft, showFieldErrors, showMessage, ROLE_LABELS } from './common.js';

const itemId = new URLSearchParams(location.search).get('id'); // no id = creating a new item
const draftKey = `draft:item-form:${itemId || 'new'}`;
const cancelPage = itemId ? `/item?id=${encodeURIComponent(itemId)}` : '/';

const form = document.querySelector('#item-form');
const saveButton = form.querySelector('button[type="submit"]');
const pageLoading = document.querySelector('#page-loading');
const pageError = document.querySelector('#page-error');
const formError = document.querySelector('#form-error');
const loadLatestButton = document.querySelector('#load-latest');

let version = null; // the item version this form started from (edit only), to catch edits made on an old copy

const FIELDS = ['title', 'description', 'assigneeId', 'dueDate'];

function readForm() {
  const values = {};
  for (const name of FIELDS) values[name] = form.elements[name].value.trim();
  return values;
}

function fillForm(values) {
  for (const name of FIELDS) form.elements[name].value = values[name] ?? '';
}

// Quick checks in the browser for a fast answer. The server checks everything again.
function validate(values) {
  const errors = {};
  if (!values.title) errors.title = ['Title is required.'];
  if (!values.assigneeId) errors.assigneeId = ['Choose who this item is assigned to.'];
  if (!values.dueDate) errors.dueDate = ['Enter a valid due date.'];
  return errors;
}

async function init() {
  const user = await startPage();
  if (user.role !== 'MANAGER') throw new Error('Only managers can create or edit items.');

  const [{ users }, detail] = await Promise.all([
    api('/api/users'),
    itemId ? api(`/api/items/${encodeURIComponent(itemId)}`) : null,
  ]);

  for (const person of users) {
    form.elements.assigneeId.add(new Option(`${person.name} (${ROLE_LABELS[person.role]})`, person.id));
  }

  if (detail) {
    if (!detail.allowedActions.includes('edit')) {
      throw new Error('This item can no longer be edited. Only Open and In progress items can be changed.');
    }
    document.querySelector('#form-title').textContent = 'Edit item';
    fillForm({ ...detail.item, assigneeId: detail.item.assignee.id });
    version = detail.item.version;
  }

  // Bring back unsaved changes. We keep the version the draft started from, so if the item changed
  // in the meantime, the server answers 409 instead of quietly overwriting the newer version.
  const draft = loadDraft(draftKey);
  if (draft) {
    fillForm(draft.values);
    version = draft.version;
  }

  form.hidden = false;
}

form.addEventListener('input', () => saveDraft(draftKey, { values: readForm(), version }));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saveButton.disabled) return;

  const values = readForm();
  const errors = validate(values);
  showFieldErrors(form, errors);
  if (Object.keys(errors).length > 0) return;

  formError.hidden = true;
  saveButton.disabled = true;
  try {
    const result = itemId
      ? await api(`/api/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: { ...values, version } })
      : await api('/api/items', { method: 'POST', body: values });
    clearDraft(draftKey);
    location.assign(`/item?id=${encodeURIComponent(result.item.id)}`); // the button stays disabled while we leave
  } catch (error) {
    // Everything the user typed stays in the form.
    formError.querySelector('[data-message]').textContent = error.message;
    loadLatestButton.hidden = error.status !== 409;
    formError.hidden = false;
    showFieldErrors(form, error.fields);
    saveButton.disabled = false;
  }
});

document.querySelector('#cancel').addEventListener('click', () => {
  clearDraft(draftKey);
  location.assign(cancelPage);
});

loadLatestButton.addEventListener('click', () => {
  clearDraft(draftKey);
  location.reload();
});

try {
  await init();
} catch (error) {
  showMessage(pageError, error.message);
} finally {
  pageLoading.hidden = true;
}
