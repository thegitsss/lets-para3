'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/assets/scripts/utils/support-drawer.js'), 'utf8');
function actualFunction(name, next) {
  const begin = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n${next}`, begin);
  assert(begin >= 0 && end > begin, `Actual ${name} source must remain available`);
  return source.slice(begin, end);
}
const functions = [
  actualFunction('canPinSupportDrawer', 'function canCollapseDashboardSidebar('),
  actualFunction('syncPinnedSupportDrawer', 'function setSupportDrawerPinned('),
  actualFunction('setSupportDrawerPinned', 'function syncSupportResponsiveState('),
  actualFunction('syncSupportResponsiveState', 'export function closeSupportDrawer('),
].join('\n');
function classes(initial = []) {
  const values = new Set(initial);
  return { contains: name => values.has(name), toggle: (name, present) => { if (present) values.add(name); else values.delete(name); }, values };
}
function fixture(shell, width, { open = true, pinned = true, activeInside = false } = {}) {
  class Element {}
  const composer = new Element(), inside = new Element(), launcher = new Element();
  const attrs = new Map(), focus = [], persisted = [];
  const drawer = { classList: classes(), setAttribute: (name, value) => attrs.set(name, value), contains: element => element === inside || element === composer };
  const state = { open, pinned, drawer, textarea: composer, lastFocusedLauncher: launcher };
  const document = { body: { classList: classes(shell ? [shell] : []) }, documentElement: { classList: classes() }, activeElement: activeInside ? inside : launcher };
  const window = { matchMedia: query => ({ matches: width >= Number(query.match(/min-width: (\d+)px/)[1]) }) };
  let escapes = 0;
  const context = { state, document, window, HTMLElement: Element, persistPinnedSupportDrawer: value => persisted.push(value), closeSupportMenu() {}, syncSidebarCollapseTab() {}, deactivateDialogFocus: (_drawer, options) => focus.push({ kind: 'deactivate', options }), activateDialogFocus: (_drawer, options) => focus.push({ kind: 'activate', options }), closeSupportDrawer: () => { escapes += 1; } };
  vm.createContext(context); vm.runInContext(functions, context, { filename: 'support-drawer.actual-responsive-source.js' });
  return { context, state, document, drawer, attrs, focus, persisted, composer, inside, launcher, get escapes() { return escapes; }, pin: () => context.canPinSupportDrawer(), resize: () => context.syncSupportResponsiveState(), setWidth: value => { width = value; } };
}

test('Attorney docking follows the existing 900/901 CSS boundary', () => {
  for (const width of [390, 768, 900]) assert.equal(fixture('av2', width).pin(), false, `${width}px must use modal behavior`);
  for (const width of [901, 1101, 1440]) assert.equal(fixture('av2', width).pin(), true, `${width}px retains docking`);
});
test('Paralegal retains its existing 1100/1101 docking boundary', () => {
  assert.equal(fixture('lpc-v2', 1100).pin(), false);
  assert.equal(fixture('lpc-v2', 1101).pin(), true);
});
test('Previous workspace retains its existing 680/681 docking boundary', () => {
  assert.equal(fixture('', 680).pin(), false);
  assert.equal(fixture('', 681).pin(), true);
});
test('Open Attorney drawer becomes modal on tablet resize and retains Escape/return focus', () => {
  const f = fixture('av2', 768); f.resize();
  assert.equal(f.state.pinned, false); assert.equal(f.attrs.get('aria-modal'), 'true');
  assert.equal(f.document.body.classList.contains('support-drawer-pinned'), false);
  assert.equal(f.drawer.classList.contains('is-pinned'), false);
  assert.deepEqual(f.persisted, [false]); assert.equal(f.focus.length, 1);
  assert.equal(f.focus[0].kind, 'activate'); assert.equal(f.focus[0].options.initialFocus, f.composer);
  assert.equal(f.focus[0].options.returnFocus, f.launcher);
  f.focus[0].options.onEscape(); assert.equal(f.escapes, 1);
});
test('Tablet resize preserves focus already inside the Assistant', () => {
  const f = fixture('av2', 900, { activeInside: true }); f.resize();
  assert.equal(f.focus[0].options.initialFocus, f.inside);
});
test('Returning to desktop restores docking and releases modal focus without moving focus', () => {
  const f = fixture('av2', 768); f.resize(); f.setWidth(1440); f.resize();
  assert.equal(f.state.pinned, true); assert.equal(f.attrs.get('aria-modal'), 'false');
  assert.equal(f.document.body.classList.contains('support-drawer-pinned'), true);
  assert.equal(f.drawer.classList.contains('is-pinned'), true);
  assert.deepEqual(f.persisted, [false, true]); assert.equal(f.focus[1].kind, 'deactivate');
  assert.equal(f.focus[1].options.restoreFocus, false);
});
test('Closed drawer resize leaves the saved closed state and focus alone', () => {
  const f = fixture('av2', 768, { open: false }); f.resize();
  assert.equal(f.state.pinned, true); assert.equal(f.attrs.size, 0); assert.equal(f.focus.length, 0); assert.equal(f.persisted.length, 0);
});
test('Environments without matchMedia retain the existing fallback', () => {
  const f = fixture('', 768); f.context.window = {};
  assert.equal(f.pin(), true);
});
