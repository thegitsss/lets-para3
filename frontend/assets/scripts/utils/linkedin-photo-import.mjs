// OAuth runs in a separate window; polling also works when provider COOP
// severs window.opener. The server binds each temporary result to this session.
export async function importLinkedInPhoto({ start, read, signal, windowObject = window }) {
  const popup = windowObject.open('about:blank', 'lpc-linkedin-photo', 'popup,width=560,height=720');
  if (!popup) throw new Error('Allow pop-ups to import your LinkedIn photo.');
  try { popup.opener = null; } catch {}
  const check = () => { if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError'); };
  const close = () => { try { popup.close(); } catch {} };
  signal?.addEventListener('abort', close, { once: true });
  const pause = () => new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = windowObject.setTimeout(done, 1500);
    const abort = () => { windowObject.clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Import cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    check();
    const attempt = await start(); check();
    const authorization = new URL(attempt.authorizationUrl);
    if (authorization.origin !== 'https://www.linkedin.com' || authorization.pathname !== '/oauth/v2/authorization' || !/^[a-f0-9]{64}$/.test(attempt.requestId || '')) throw new Error('LinkedIn could not connect. Please try again.');
    popup.location.replace(authorization.href);
    const deadline = Date.now() + 3 * 60000;
    while (Date.now() < deadline) {
      await pause(); check();
      const result = await read(attempt.requestId); check();
      if (result.status === 'failed') throw new Error('Your LinkedIn photo couldn’t be imported. Try again or upload a photo.');
      if (result.status !== 'ready') continue;
      if (result.contentType !== 'image/jpeg' || typeof result.photo !== 'string' || result.photo.length > 7 * 1024 * 1024) throw new Error('LinkedIn did not provide a supported photo.');
      const data = Uint8Array.from(atob(result.photo), char => char.charCodeAt(0));
      return new File([data], 'linkedin-photo.jpg', { type: 'image/jpeg' });
    }
    throw new Error('The LinkedIn connection timed out. Please try again.');
  } finally { signal?.removeEventListener('abort', close); close(); }
}
