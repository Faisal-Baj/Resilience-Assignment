// Helpers shared by every page.

export class ApiError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status; // HTTP status, or 0 when the server could not be reached
    this.fields = fields || {}; // messages for each field.
  }
}

// Calls our API and returns the JSON, or throws an ApiError.
// The browser adds the session cookie by itself. Our JavaScript never sees the token.
export async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  const data = response.status === 204 ? null : await response.json().catch(() => null);

  // 401 means not signed in, or the session ended.
  // If it happens when a page opens (/api/auth/me), we go to the login page quietly.
  // If it happens later, the session ended while the user was working, so the login page tells them.
  if (response.status === 401 && path !== '/api/auth/login') {
    location.assign(path === '/api/auth/me' ? '/login' : '/login?expired=1');
  }

  if (!response.ok) {
    throw new ApiError(response.status, data?.error || 'Something went wrong. Please try again.', data?.fields);
  }
  return data;
}

// The HTML pages have no data in them. Everything comes from the API, which checks permissions.
export async function startPage() {
  const { user } = await api('/api/auth/me');

  // sticky + top-0 keeps the header on screen while you scroll.
  const header = document.querySelector('#app-header');
  header.className = 'sticky top-0 z-10 border-b border-line bg-night/80 backdrop-blur';
  header.innerHTML = `
    <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
      <a href="/" class="font-semibold text-white">
        Remediation <span class="brand-gradient">Workspace</span>
        <span class="text-slate-500">—</span> <span data-org class="text-mist"></span>
      </a>
      <div class="flex items-center gap-3 text-sm">
        <span data-user class="text-slate-300"></span>
        <button type="button" data-logout class="btn btn-secondary">Sign out</button>
      </div>
    </div>`;
  header.querySelector('[data-org]').textContent = user.organizationName;
  header.querySelector('[data-user]').textContent = `${user.name} (${ROLE_LABELS[user.role]})`;
  header.querySelector('[data-logout]').addEventListener('click', logout);

  return user;
}

async function logout(event) {
  event.currentTarget.disabled = true;
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Go to the login page anyway.
  }
  sessionStorage.clear(); // delete drafts saved in this browser tab
  location.assign('/login');
}


export const ROLE_LABELS = { MANAGER: 'Manager', MEMBER: 'Member' };

export const STATUS_LABELS = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  PENDING_REVIEW: 'Pending review',
  CLOSED: 'Closed',
};

const STATUS_COLORS = {
  OPEN: 'bg-slate-400/10 text-slate-300 ring-slate-400/30',
  IN_PROGRESS: 'bg-sky-400/10 text-sky-300 ring-sky-400/30',
  PENDING_REVIEW: 'bg-amber-400/10 text-amber-300 ring-amber-400/30',
  CLOSED: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30',
};

export function statusBadge(status) {
  return badge(STATUS_LABELS[status], STATUS_COLORS[status]);
}

export function overdueBadge() {
  return badge('Overdue', 'bg-red-400/10 text-red-300 ring-red-400/30');
}

function badge(text, colors) {
  const span = document.createElement('span');
  span.className = `badge ${colors}`;
  span.textContent = text;
  return span;
}

// "2026-10-20" -> "Oct 20, 2026". Due dates have no time, so we format them in UTC.
export function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatDateTime(isoString) {
  return new Date(isoString).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Shows a message in an element. An empty message hides the element.
export function showMessage(element, message) {
  element.textContent = message || '';
  element.hidden = !message;
}

// Shows each field's error under its input.
export function showFieldErrors(form, fields = {}) {
  for (const input of form.querySelectorAll('input[name], textarea[name], select[name]')) {
    const message = fields[input.name]?.[0];
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    showMessage(form.querySelector(`#${input.name}-error`), message);
  }
  form.querySelector('[aria-invalid="true"]')?.focus();
}

// What the user types is saved in sessionStorage (this browser tab only), so it isn't lost after
// an error, a reload, or signing in again. It is cleared after saving and on sign out.
export const loadDraft = (key) => JSON.parse(sessionStorage.getItem(key));
export const saveDraft = (key, value) => sessionStorage.setItem(key, JSON.stringify(value));
export const clearDraft = (key) => sessionStorage.removeItem(key);
