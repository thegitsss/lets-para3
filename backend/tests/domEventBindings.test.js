const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/utils/event-bindings.mjs')).href;
function check(body) {
  execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import {replaceEventHandler} from ${JSON.stringify(moduleUrl)}; ${body}`], { stdio: 'pipe' });
}
test('re-rendered controls run only the current writer and preserve sibling listener order', () => check(`
  const target = new EventTarget(), calls = [];
  target.addEventListener('click', () => calls.push('before'));
  replaceEventHandler(target, 'click', () => calls.push('old writer'));
  target.addEventListener('click', () => calls.push('after'));
  for (let i = 0; i < 5; i++) replaceEventHandler(target, 'click', function(event) { assert.equal(this, target); assert.equal(event.type, 'click'); calls.push('current writer'); });
  target.dispatchEvent(new Event('click'));
  assert.deepEqual(calls, ['before', 'current writer', 'after']);
  replaceEventHandler(target, 'click', null); calls.length = 0; target.dispatchEvent(new Event('click'));
  assert.deepEqual(calls, ['before', 'after']);
`));
test('replacement retains cancellation semantics and independent event ownership', () => check(`
  const target = new EventTarget(), other = new EventTarget(); let changes = 0, others = 0;
  const cancel = () => false; assert.equal(replaceEventHandler(target, 'submit', cancel), cancel);
  replaceEventHandler(target, 'change', () => changes++); replaceEventHandler(other, 'submit', () => others++);
  assert.equal(target.dispatchEvent(new Event('submit', { cancelable: true })), false);
  target.dispatchEvent(new Event('change')); other.dispatchEvent(new Event('submit'));
  assert.equal(changes, 1); assert.equal(others, 1);
  replaceEventHandler(target, 'submit', () => true); assert.equal(target.dispatchEvent(new Event('submit', { cancelable: true })), true);
`));
