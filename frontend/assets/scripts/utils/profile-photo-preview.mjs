const previews = new WeakMap();
const PLACEHOLDER = '/assets/avatar-placeholder.svg';

// A pending upload can finish scanning after the first image request fails.
// Retry only that explicit state, for at most two minutes; never bypass scanning.
export function setProfilePhotoPreview(image, source, { signal, onStatus, retry = false } = {}) {
  const url = source || PLACEHOLDER;
  const previous = previews.get(image);
  if (previous?.url === url && !retry) return;
  onStatus ||= previous?.onStatus || (() => {});
  previous?.stop();
  const controller = new AbortController();
  const state = { url, stopped: false, stop, onStatus, originalTitle: previous?.originalTitle ?? image.title };
  previews.set(image, state);
  let timer, attempt = 0, probing = false;
  const started = Date.now();
  const originalTitle = state.originalTitle;
  const pending = /^\/api\/users\/profile-photo\/[a-f0-9]{24}\?/.test(url) && new URL(url, location.origin).searchParams.get('variant') === 'pending';
  function status(value) {
    image.dataset.photoPreviewState = value;
    image.title = value === 'scanning' ? 'Photo security check in progress' : value === 'unavailable' ? 'Photo preview unavailable. Reload to try again.' : originalTitle;
    onStatus(value);
  }
  function stop() {
    state.stopped = true;
    clearTimeout(timer);
    controller.abort();
    image.removeEventListener('error', failed);
    image.removeEventListener('load', loaded);
    signal?.removeEventListener('abort', stop);
  }
  function active() { return !state.stopped && !signal?.aborted && image.isConnected && Date.now() - started < 120000; }
  function unavailable() { image.src = PLACEHOLDER; status('unavailable'); stop(); }
  function loaded() {
    if (image.getAttribute('src') === PLACEHOLDER) return;
    status('ready');
    clearTimeout(timer);
  }
  async function failed() {
    if (image.getAttribute('src') === PLACEHOLDER || probing || state.stopped) return;
    image.src = PLACEHOLDER;
    if (!pending || !active()) { unavailable(); return; }
    probing = true;
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!active()) { stop(); return; }
      if (response.ok) {
        await response.body?.cancel();
        image.src = `${url}&previewRetry=${++attempt}`;
      } else {
        const result = await response.json().catch(() => ({}));
        if (response.status !== 423 || result.code !== 'FILE_SCAN_PENDING' || ++attempt >= 40) { unavailable(); return; }
        status('scanning');
        timer = setTimeout(() => {
          if (!active()) { if (image.isConnected && !state.stopped) unavailable(); else stop(); return; }
          image.src = `${url}&previewRetry=${attempt}`;
        }, 3000);
      }
    } catch {
      if (!state.stopped) unavailable();
    } finally { probing = false; }
  }
  image.addEventListener('error', failed);
  image.addEventListener('load', loaded);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) { stop(); return; }
  status('loading');
  image.src = url;
}
