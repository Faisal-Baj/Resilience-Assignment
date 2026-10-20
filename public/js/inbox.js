import { api, startPage, statusBadge, overdueBadge, formatDate } from './common.js';

const filters = document.querySelector('#filters');
const list = document.querySelector('#item-list');
const rowTemplate = document.querySelector('#item-row');
const loading = document.querySelector('#list-loading');
const empty = document.querySelector('#list-empty');
const errorBox = document.querySelector('#list-error');
const pagination = document.querySelector('#pagination');
const prevButton = document.querySelector('#prev-page');
const nextButton = document.querySelector('#next-page');

let page = 1;

function showState(state, errorMessage) {
  loading.hidden = state !== 'loading';
  empty.hidden = state !== 'empty';
  errorBox.hidden = state !== 'error';
  errorBox.querySelector('[data-message]').textContent = errorMessage || '';
}

async function loadItems() {
  showState('loading');
  list.replaceChildren();
  pagination.hidden = true;

  // The server does the filtering and paging.
  const params = new URLSearchParams({ page });
  if (filters.elements.status.value) params.set('status', filters.elements.status.value);
  if (filters.elements.overdue.value) params.set('overdue', filters.elements.overdue.value);

  try {
    const data = await api(`/api/items?${params}`);
    renderItems(data);
  } catch (error) {
    showState('error', error.message);
  }
}

function renderItems({ items, total, pageSize }) {
  showState(items.length === 0 ? 'empty' : 'items');

  for (const item of items) {
    const row = rowTemplate.content.cloneNode(true);
    row.querySelector('[data-link]').href = `/item?id=${encodeURIComponent(item.id)}`;
    row.querySelector('[data-title]').textContent = item.title;
    row.querySelector('[data-assignee]').textContent = item.assignee.name;
    row.querySelector('[data-due]').textContent = formatDate(item.dueDate);
    const badges = row.querySelector('[data-badges]');
    badges.append(statusBadge(item.status));
    if (item.isOverdue) badges.append(overdueBadge());
    list.append(row);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  document.querySelector('#page-info').textContent = `Page ${page} of ${totalPages} · ${total} items`;
  prevButton.disabled = page <= 1;
  nextButton.disabled = page >= totalPages;
  pagination.hidden = total === 0;
}

filters.addEventListener('change', () => {
  page = 1;
  loadItems();
});
prevButton.addEventListener('click', () => {
  page -= 1;
  loadItems();
});
nextButton.addEventListener('click', () => {
  page += 1;
  loadItems();
});
document.querySelector('#retry').addEventListener('click', loadItems);

try {
  const user = await startPage();
  document.querySelector('#new-item').hidden = user.role !== 'MANAGER';
  loadItems();
} catch (error) {
  showState('error', error.message);
}
