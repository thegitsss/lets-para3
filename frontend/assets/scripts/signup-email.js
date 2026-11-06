import { secureFetch } from './auth.js';

const form = document.getElementById('signupEmailForm');
const email = document.getElementById('signupEmail');
const password = document.getElementById('signupPassword');
const nextEmail = document.getElementById('signupNewEmail');
const status = document.getElementById('signupEmailStatus');
const button = form.querySelector('button[type="submit"]');
const credentials = document.getElementById('signupEmailCredentials');
let busy = false;
let recentSignup = false;

// No credentials, email addresses or verification tokens are put in the URL or
// persisted in browser storage. A provider's recent-signup proof is HttpOnly.
async function context() {
  try {
    const response = await secureFetch('/api/auth/signup-email', { noRedirect: true });
    if (!response.ok) return;
    const data = await response.json();
    if (data.recentSignup) {
      recentSignup = true;
      credentials.hidden = true;
      email.required = password.required = false;
      document.getElementById('correctionLead').textContent = `Update the address for ${data.email}. Your saved registration will stay intact.`;
    }
  } catch { /* Password authentication remains available. */ }
}
const ready = context();

function showSaved(target, delivered) {
  form.hidden = true;
  password.value = '';
  const title = document.getElementById('verificationTitle');
  title.textContent = delivered ? 'Check your new inbox.' : 'New address saved.';
  document.getElementById('correctionLead').textContent = delivered
    ? `We sent a verification email to ${target}. Confirm that address to finish the change.`
    : 'We couldn’t confirm email delivery. Check your new inbox before requesting another link.';
  status.setAttribute('role', 'status');
  status.textContent = 'Your saved registration is unchanged. Previous verification links no longer work.';
  document.getElementById('correctionResendEmail').value = target;
  document.getElementById('signupEmailRecovery').hidden = false;
  document.getElementById('signupEmailSettingsHelp').hidden = true;
  title.focus();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  await ready;
  if (busy || !form.reportValidity()) return;
  busy = true;
  form.setAttribute('aria-busy', 'true');
  button.disabled = true;
  button.textContent = 'Sending…';
  status.setAttribute('role', 'status');
  status.textContent = '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await secureFetch('/api/auth/signup-email', { method: 'POST',
      body: { email: email.value.trim(), password: password.value, newEmail: nextEmail.value.trim() },
      noRedirect: true, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (data.saved === true && data.email) return showSaved(data.email, false);
    if (!response.ok || data.ok !== true) {
      if (recentSignup && data.code === 'SIGNUP_CHANGED') {
        credentials.hidden = false; email.required = password.required = true; recentSignup = false;
      }
      throw Error(data.msg || 'We couldn’t confirm the change. Please try again.');
    }
    showSaved(data.email, true);
  } catch (error) {
    status.setAttribute('role', 'alert');
    status.textContent = error.name === 'AbortError'
      ? 'We couldn’t confirm the result. Check your new inbox before trying again.'
      : error.message;
  } finally {
    clearTimeout(timeout);
    busy = false;
    form.removeAttribute('aria-busy');
    button.disabled = false;
    button.textContent = 'Send verification email';
  }
});
