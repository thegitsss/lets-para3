(() => {
  const form = document.getElementById('contactForm');
  const statusEl = document.getElementById('formStatus');
  const submitBtn = form?.querySelector('button[type="submit"]');

  async function fetchCsrfToken() {
    try {
      const res = await fetch('/api/csrf', { credentials: 'include' });
      if (!res.ok) return '';
      const data = await res.json().catch(() => ({}));
      return data?.csrfToken || '';
    } catch {
      return '';
    }
  }

  function setStatus(message, type) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.remove('success', 'error', 'show');
    if (type) statusEl.classList.add(type, 'show');
  }

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      const originalLabel = submitBtn?.textContent || 'Submit Message';

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending...';
      }
      setStatus('Sending your message...', '');

      try {
        const csrfToken = await fetchCsrfToken();
        const res = await fetch('/api/public/contact', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          credentials: 'include',
          body: JSON.stringify(payload),
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.ok) {
          setStatus('Message sent. We will get back to you shortly.', 'success');
          form.reset();
        } else {
          const msg = data?.msg || 'We could not send your message. Please try again.';
          setStatus(msg, 'error');
        }
      } catch {
        setStatus('Unable to send message. Please check your connection and try again.', 'error');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
      }
    });
  }
})();
