import { api, showMessage } from './common.js';

const form = document.querySelector('#login-form');
const formError = document.querySelector('#form-error');
const submitButton = form.querySelector('button[type="submit"]');

if (new URLSearchParams(location.search).get('expired')) {
  showMessage(document.querySelector('#notice'), 'Your session has expired. Please sign in again.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return; // already signing in

  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;
  if (!email || !password) {
    showMessage(formError, 'Enter your email and password.');
    return;
  }

  showMessage(formError, '');
  submitButton.disabled = true;
  try {
    await api('/api/auth/login', { method: 'POST', body: { email, password } });
    location.assign('/');
  } catch (error) {
    showMessage(formError, error.message);
    form.elements.password.value = ''; // keep the email, clear the password
    form.elements.password.focus();
    submitButton.disabled = false;
  }
});
