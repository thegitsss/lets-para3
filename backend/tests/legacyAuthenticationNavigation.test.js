'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function navigationBoundary() {
  const source = read('frontend/assets/scripts/universal-header.js');
  const end = source.indexOf('  const scriptUrl =');
  if (end < 0) throw Error('Actual header bootstrap boundary missing');
  const listeners = {}, appended = [];
  const context = { URL, queueMicrotask, window: { location: { origin: 'http://127.0.0.1:5000' }, navigation: { addEventListener: (name, fn) => { listeners[name] = fn; } }, addEventListener: (name, fn) => { listeners[name] = fn; } }, document: { createElement: () => ({ remove() { this.removed = true; } }), head: { append: element => appended.push(element) } } };
  vm.runInNewContext(source.slice(0, end) + '})();', context);
  return { listeners, appended, navigate: (url, sameDocument = false) => listeners.navigate({ destination: { url, sameDocument } }) };
}

function actualLegacyBoot(window) {
  const source = read('frontend/assets/scripts/attorney-tabs.js');
  const start = source.indexOf('async function bootAttorneyExperience() {');
  const end = source.indexOf('\n}', start) + 2;
  if (start < 0 || end < start) throw Error('Actual legacy startup missing');
  const calls = [], context = { window, REQUIRED_ROLES: ['attorney'], weeklyNoteOwnerId: '', state: {}, loadUserHeaderInfo: async () => calls.push('header'), applyRoleVisibility: user => calls.push('role:' + user.role), bootstrap: async () => calls.push('bootstrap') };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  return { context, calls, run: () => context.bootAttorneyExperience() };
}

for (const pathname of ['/dashboard-attorney.html', '/create-case.html', '/attorney-v2.html', '/paralegal-v2.html', '/dashboard-paralegal.html', '/browse-jobs.html', '/profile-settings.html', '/case-detail.html', '/login.html', '/paralegal-admission.html']) {
  test(`actual header uses its existing ordinary-navigation boundary for ${pathname}`, () => {
    const fixture = navigationBoundary(); fixture.navigate(`http://127.0.0.1:5000${pathname}?next=owned#test`);
    expect(fixture.appended).toHaveLength(1);
    expect(fixture.appended[0].textContent).toBe('@view-transition { navigation: none; }');
  });
}
for (const url of ['http://127.0.0.1:5000/help.html', 'https://foreign.invalid/login.html']) {
  test(`actual header preserves ordinary existing motion authority for ${url}`, () => {
    const fixture = navigationBoundary(); fixture.navigate(url); expect(fixture.appended).toHaveLength(0);
  });
}
for (const event of ['pageshow', 'navigateerror']) {
  test(`actual header clears temporary transition boundary on ${event}`, async () => {
    const fixture = navigationBoundary(); fixture.navigate('http://127.0.0.1:5000/login.html'); fixture.listeners[event]();
    await Promise.resolve();
    expect(fixture.appended[0].removed).toBe(true);
  });
}
test('actual header replaces temporary boundary for the next navigation', () => {
  const fixture = navigationBoundary(); fixture.navigate('http://127.0.0.1:5000/login.html'); fixture.navigate('http://127.0.0.1:5000/help.html');
  expect(fixture.appended).toHaveLength(1); expect(fixture.appended[0].removed).toBe(true);
});
test('actual header keeps the selected sign-in departure through same-document history normalization', () => {
  const fixture = navigationBoundary();
  fixture.navigate('http://127.0.0.1:5000/login.html');
  fixture.navigate('http://127.0.0.1:5000/dashboard-paralegal.html?workspace=legacy', true);
  expect(fixture.appended).toHaveLength(1);
  expect(fixture.appended[0].removed).not.toBe(true);
});
test('actual header leaves an ordinary same-document V2 route change under existing motion policy', () => {
  const fixture = navigationBoundary();
  fixture.navigate('http://127.0.0.1:5000/paralegal-v2.html#/home', true);
  expect(fixture.appended).toHaveLength(0);
});
test('actual header retains the continuing sign-in boundary through native abort then synchronous history normalization', async () => {
  const fixture = navigationBoundary(); fixture.navigate('http://127.0.0.1:5000/login.html');
  fixture.listeners.navigateerror();
  fixture.navigate('http://127.0.0.1:5000/dashboard-paralegal.html?workspace=legacy', true);
  await Promise.resolve();
  expect(fixture.appended).toHaveLength(1); expect(fixture.appended[0].removed).not.toBe(true);
});
test('actual stale cancellation cannot remove the superseding protected document boundary', async () => {
  const fixture = navigationBoundary(); fixture.navigate('http://127.0.0.1:5000/login.html');
  fixture.listeners.navigateerror(); fixture.navigate('http://127.0.0.1:5000/profile-settings.html');
  await Promise.resolve();
  expect(fixture.appended).toHaveLength(2); expect(fixture.appended[0].removed).toBe(true); expect(fixture.appended[1].removed).not.toBe(true);
});
test('actual native cancellation followed by an ordinary document departure restores its existing motion', async () => {
  const fixture = navigationBoundary(); fixture.navigate('http://127.0.0.1:5000/login.html');
  fixture.listeners.navigateerror(); fixture.navigate('http://127.0.0.1:5000/help.html');
  await Promise.resolve();
  expect(fixture.appended).toHaveLength(1); expect(fixture.appended[0].removed).toBe(true);
});
test('actual restored pageshow invalidates stale cancellation before a new protected departure', async () => {
  const fixture = navigationBoundary(); fixture.navigate('http://127.0.0.1:5000/login.html');
  fixture.listeners.navigateerror(); fixture.listeners.pageshow(); fixture.navigate('http://127.0.0.1:5000/profile-settings.html');
  await Promise.resolve();
  expect(fixture.appended).toHaveLength(2); expect(fixture.appended[0].removed).toBe(true); expect(fixture.appended[1].removed).not.toBe(true);
});
test('actual pageswap preserves committed departure against pending or late signals until history restoration', async () => {
  const fixture = navigationBoundary(); fixture.navigate('http://127.0.0.1:5000/login.html');
  fixture.listeners.navigateerror(); fixture.listeners.pageswap(); await Promise.resolve();
  fixture.listeners.navigateerror(); fixture.navigate('http://127.0.0.1:5000/dashboard-paralegal.html', true);
  fixture.navigate('http://127.0.0.1:5000/help.html'); await Promise.resolve();
  expect(fixture.appended).toHaveLength(1); expect(fixture.appended[0].removed).not.toBe(true);
  fixture.listeners.pageshow(); fixture.navigate('http://127.0.0.1:5000/help.html');
  expect(fixture.appended[0].removed).toBe(true); expect(fixture.appended).toHaveLength(1);
});

test('actual rejected authoritative legacy check never starts a departing fallback/session bootstrap', async () => {
  let checks = 0, fallbacks = 0;
  const fixture = actualLegacyBoot({ checkSession: async (_role, options) => { checks++; expect(options.redirectOnFail).toBe(true); throw Error('Authentication required'); }, requireRole: async () => { fallbacks++; return { id: 'owner', role: 'attorney' }; } });
  await fixture.run(); expect(checks).toBe(1); expect(fallbacks).toBe(0); expect(fixture.calls).toEqual([]);
});
test('actual null authoritative legacy check remains fail closed without a second check', async () => {
  let fallbacks = 0; const fixture = actualLegacyBoot({ checkSession: async () => null, requireRole: async () => { fallbacks++; return { role: 'attorney' }; } });
  await fixture.run(); expect(fallbacks).toBe(0); expect(fixture.calls).toEqual([]);
});
test('actual approved authoritative legacy check initializes the existing owned dashboard once', async () => {
  const fixture = actualLegacyBoot({ checkSession: async () => ({ user: { id: 'owner', role: 'attorney' } }), requireRole: async () => { throw Error('Unexpected duplicate'); } });
  await fixture.run(); expect(fixture.context.weeklyNoteOwnerId).toBe('owner'); expect(fixture.calls).toEqual(['header', 'role:attorney', 'bootstrap']);
});
test('actual legacy fallback remains available when authoritative API is absent', async () => {
  let fallbacks = 0; const fixture = actualLegacyBoot({ requireRole: async role => { fallbacks++; expect(role).toBe('attorney'); return { id: 'owner', role }; } });
  await fixture.run(); expect(fallbacks).toBe(1); expect(fixture.calls).toEqual(['header', 'role:attorney', 'bootstrap']);
});
test('actual wrong-role authoritative result redirects before protected bootstrap', async () => {
  const redirects = []; const fixture = actualLegacyBoot({ checkSession: async () => ({ role: 'paralegal' }), redirectUserDashboard: role => redirects.push(role) });
  await fixture.run(); expect(redirects).toEqual(['paralegal']); expect(fixture.calls).toEqual([]);
});
