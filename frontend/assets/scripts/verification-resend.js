import { secureFetch } from './auth.js';

// Both public recovery entry points use the existing generic, rate-limited endpoint.
for (const form of document.querySelectorAll('[data-verification-resend]')) {
  const email = form.querySelector('input[type="email"]');
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('[role="status"]');
  let busy = false;
  const details = form.closest('details');
  details?.addEventListener('toggle', () => {
    if (details.open && !email.value) email.value = document.getElementById('email')?.value || '';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true; button.disabled = true; form.setAttribute('aria-busy', 'true');
    status.textContent = 'Requesting a verification email…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let cooldown = 0;
    try {
      const response = await secureFetch('/api/auth/resend-verification', {
        method: 'POST', body: { email: email.value.trim() }, noRedirect: true, signal: controller.signal,
      });
      if (response.status === 429) {
        const retry = Number(response.headers.get('Retry-After'));
        cooldown = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 900) * 1000 : 60000;
        throw new Error('Please wait a little before requesting another email.');
      }
      if (!response.ok) throw new Error('We couldn’t request an email right now. Please try again.');
      cooldown = 60000;
      status.textContent = 'Request received. If this address needs verification, check your inbox and spam folder for a link. You can try again in one minute.';
    } catch (error) {
      status.textContent = error.name === 'AbortError'
        ? 'The request took too long. Please check your inbox before trying again.'
        : error.message || 'We couldn’t request an email. Please try again.';
    } finally {
      clearTimeout(timeout); form.removeAttribute('aria-busy');
      const restore = () => {
        busy = false; button.disabled = false;
        if (cooldown) status.textContent = 'You can request another verification email now.';
      };
      if (cooldown) setTimeout(restore, cooldown); else restore();
    }
  });
}
