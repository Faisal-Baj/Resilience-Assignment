// @vitest-environment jsdom
// Test 9: a frontend interaction. It runs the real login page in a fake browser (jsdom).
// The server is replaced by a fake fetch, so we can decide what it answers and when.
import { it, expect, vi } from 'vitest';
import fs from 'node:fs';

it('a failed sign-in shows the error, keeps the email, and a double click sends only one request', async () => {
  // Load the page's HTML. Scripts added this way don't run, so we import login.js ourselves below.
  document.documentElement.innerHTML = fs.readFileSync('public/login.html', 'utf8');

  // A fake server that only answers when we call answer(...).
  let answer;
  const fakeFetch = vi.fn(() => new Promise((resolve) => (answer = resolve)));
  vi.stubGlobal('fetch', fakeFetch);
  await import('../public/js/login.js');

  const form = document.querySelector('#login-form');
  const button = form.querySelector('button[type="submit"]');
  form.elements.email.value = 'user@orga.test';
  form.elements.password.value = 'wrong-password';

  button.click();
  button.click(); // the user double-clicks

  expect(fakeFetch).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true); // disabled while the request is running

  // The server says the password is wrong.
  answer({ status: 401, ok: false, json: async () => ({ error: 'Invalid email or password.' }) });

  await vi.waitFor(() => expect(button.disabled).toBe(false)); // the user can try again
  const error = document.querySelector('#form-error');
  expect(error.hidden).toBe(false);
  expect(error.textContent).toBe('Invalid email or password.');
  expect(form.elements.email.value).toBe('user@orga.test'); // their input is kept
  expect(form.elements.password.value).toBe(''); // except the password
});
