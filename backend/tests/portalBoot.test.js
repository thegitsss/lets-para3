const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/assets/scripts/portal-boot.js'), 'utf8');

function boot({ theme = 'light', hour = 12, guarded = false, search = '', storageError = false } = {}) {
  const root = { dataset: {} }, frames = [], timers = [], clicks = [];
  const retry = { hidden: true, addEventListener: (_name, handler) => clicks.push(handler) };
  const label = { textContent: '' };
  const screen = {
    open: false, dataset: {}, removed: false,
    querySelector: selector => selector === '[data-lpc-boot-retry]' ? retry : label,
    addEventListener() {}, setAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.removed = true; },
  };
  const location = { search, reload: jest.fn() };
  const document = {
    documentElement: root,
    querySelector: selector => selector === '[data-lpc-boot-screen]' ? screen : null,
    fonts: { ready: new Promise(() => {}), addEventListener() {}, removeEventListener() {} },
  };
  const window = { addEventListener() {}, removeEventListener() {}, ...(guarded ? { lpcWorkspaceEntryGuard: {} } : {}) };
  vm.runInNewContext(source, {
    window, document, location, URLSearchParams,
    localStorage: { getItem: () => { if (storageError) throw new Error('Unavailable'); return JSON.stringify({ preferences: { theme } }); } },
    Date: class extends Date { getHours() { return hour; } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {},
    requestAnimationFrame: callback => frames.push(callback),
    matchMedia: () => ({ matches: true }),
  });
  return { root, window, screen, retry, label, location, frames, timers, clicks };
}

test.each(['dark', 'mountain-dark', ' Mountain-Dark ', 'DARK'])('the initial cover honors saved dark preference %s', theme => {
  expect(boot({ theme }).root.dataset.lpcBootTheme).toBe('dark');
});

test('system and unavailable preferences retain the existing day/night and light defaults', () => {
  expect(boot({ theme: 'system', hour: 20 }).root.dataset.lpcBootTheme).toBe('dark');
  expect(boot({ theme: 'system', hour: 10 }).root.dataset.lpcBootTheme).toBe('light');
  expect(boot({ storageError: true }).root.dataset.lpcBootTheme).toBe('light');
});

test.each(['?workspace=legacy', '?cardSetup=1', '?cardSetup=1&workspace=legacy'])('original dashboard entry %s remains immediately usable', search => {
  const result = boot({ guarded: true, search });
  expect(result.window.LPC_PORTAL_BOOT).toBeUndefined();
  expect(result.root.dataset.lpcBoot).toBeUndefined();
  expect(result.screen.open).toBe(false);
});

test('ordinary dashboard entries are covered while routing is pending', () => {
  const result = boot({ guarded: true });
  expect(result.root.dataset.lpcBoot).toBe('loading');
  expect(result.screen.open).toBe(true);
  expect(result.window.LPC_PORTAL_BOOT.pending).toBe(true);
});

test('a failed Settings load offers a working retry without exposing incomplete content', () => {
  const result = boot();
  result.window.LPC_PORTAL_BOOT.recover('Your settings couldn’t load. Try again.');
  expect(result.label.textContent).toBe('Your settings couldn’t load. Try again.');
  expect(result.retry.hidden).toBe(false);
  expect(result.root.dataset.lpcBoot).toBe('loading');
  result.clicks[0]();
  expect(result.location.reload).toHaveBeenCalledTimes(1);
});

test('original-page fallback can reveal without waiting on a stalled font', () => {
  const result = boot({ guarded: true });
  result.window.LPC_PORTAL_BOOT.fail();
  while (result.frames.length) result.frames.shift()();
  expect(result.root.dataset.lpcBoot).toBe('ready');
  expect(result.screen.removed).toBe(true);
  expect(result.window.LPC_PORTAL_BOOT.pending).toBe(false);
});
