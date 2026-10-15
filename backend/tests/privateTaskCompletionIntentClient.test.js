const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const frontend = path.resolve(__dirname, '../../frontend/assets/scripts');
function client(program) {
  execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import {createApiClient} from ${JSON.stringify(pathToFileURL(path.join(frontend, 'attorney-v2/api-client.mjs')).href)}; ${program}`], { stdio: 'pipe' });
}
function retained({ done = false, status = 200, accountChanged = false } = {}) {
  const sourcePath = path.join(frontend, 'attorney-tabs.js');
  // Use Node's package loader for the installed ESM parser; Jest's CommonJS
  // registry cannot load it. Execute the exact retained function source in VM.
  const functions = JSON.parse(execFileSync(process.execPath, ['--eval', `const fs=require('node:fs'),{parse}=require('@babel/parser');const source=fs.readFileSync(${JSON.stringify(sourcePath)},'utf8');const ast=parse(source,{sourceType:'module'});process.stdout.write(JSON.stringify(ast.program.body.filter(item=>item.type==='FunctionDeclaration'&&['bindTaskEvents','openTaskModal'].includes(item.id.name)).map(item=>source.slice(item.start,item.end))));`], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }));
  expect(functions).toHaveLength(2);
  const writes = [], notices = [], reads = [], dialogs = [], owner = 'a'.repeat(24), other = 'c'.repeat(24);
  const revision = '2026-10-13T20:00:00.000Z', id = 'b'.repeat(24), callbacks = new Map();
  const control = { disabled: false, dataset: {}, textContent: '', addEventListener: (name, handler) => callbacks.set(name, handler) };
  const modal = { dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; }, querySelector: selector => selector === '[data-toggle-task]' ? control : null, querySelectorAll: () => [], addEventListener: () => {} };
  const nodes = new Map(['taskDetailNotes', 'taskDetailMeta', 'taskDetailTitle'].map(name => [name, { textContent: '', innerHTML: '' }]));
  const state = { user: { id: owner }, tasks: [{ id, done, updatedAt: revision }], caseLookup: new Map() };
  const context = { state, document: { getElementById: name => name === 'taskDetailModal' ? modal : nodes.get(name) || null }, sanitize: value => value, toggleModal: (_, open) => dialogs.push(open), secureFetch: async (url, options) => { writes.push({ url, options }); return { status, ok: status === 200 }; }, loadTasks: async () => reads.push('current authoritative task read'), renderTasks: () => reads.push('current task presentation'), notifyTasks: (text, kind) => notices.push({ text, kind }), console };
  vm.createContext(context); vm.runInContext(functions.join('\n'), context);
  context.bindTaskEvents(); context.openTaskModal({ id, title: 'Synthetic task', notes: 'Owner-only notes', due: null, done, updatedAt: revision });
  const originalLabel = control.textContent;
  // A background state/account change after the modal opens must not rebind its promise.
  state.tasks = [{ id, done: !done, updatedAt: '2026-10-13T20:00:01.000Z' }];
  if (accountChanged) state.user = { id: other };
  return { run: () => callbacks.get('click')(), writes, notices, reads, dialogs, originalLabel, owner, revision, id };
}

test('current task API sends only displayed intent, exact revision and reviewed owner with real client CSRF handling', () => client(`
 const owner='a'.repeat(24),task='b'.repeat(24),revision='2026-10-13T20:00:00.000Z',calls=[];
 const api=createApiClient({fetchImpl:async(url,options)=>{calls.push({url,...options});const body=url==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:url==='/api/csrf'?{csrfToken:'local-token'}:{ok:true,done:true,revision};return {ok:true,status:200,json:async()=>body};}});
 await api.togglePrivateTask(task,{done:true,revision,ownerId:owner,ignoredPrivateField:'do not send'});
 assert.deepEqual(calls.map(call=>call.url),['/api/auth/me','/api/csrf','/api/checklist/'+task+'/toggle']);
 assert.deepEqual(JSON.parse(calls.at(-1).body),{done:true,revision,expectedOwnerId:owner});assert.equal(calls.at(-1).headers['X-CSRF-Token'],'local-token');assert.equal(calls.at(-1).credentials,'include');
`));
test('an uncertain task decision is sent once and never silently retried or inverted by the current client', () => client(`
 const owner='a'.repeat(24),calls=[];const api=createApiClient({fetchImpl:async(url,options)=>{calls.push({url,...options});const body=url==='/api/auth/me'?{user:{id:owner,role:'attorney',status:'approved'}}:url==='/api/csrf'?{csrfToken:'local-token'}:{error:'unconfirmed'};return {ok:options.method==='GET',status:options.method==='GET'?200:503,json:async()=>body};}});
 await assert.rejects(api.togglePrivateTask('b'.repeat(24),{done:false,revision:null,ownerId:owner}));
 assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.deepEqual(JSON.parse(calls.at(-1).body),{done:false,revision:null,expectedOwnerId:owner});
`));
test('a switched current account cannot send the previous task intent', () => client(`
 const owner='a'.repeat(24),calls=[];const api=createApiClient({fetchImpl:async(url,options)=>{calls.push({url,...options});return {ok:true,status:200,json:async()=>({user:{id:'c'.repeat(24),role:'attorney',status:'approved'}})};}});
 await assert.rejects(api.togglePrivateTask('b'.repeat(24),{done:true,revision:'2026-10-13T20:00:00.000Z',ownerId:owner}));assert.deepEqual(calls.map(call=>call.url),['/api/auth/me']);
`));
test.each([false, true])('the retained modal preserves displayed completion intent after background state changes (initial done=%s)', async done => {
  const scope = retained({ done }); await scope.run();
  expect(scope.originalLabel).toBe(done ? 'Mark Incomplete' : 'Mark Complete'); expect(scope.writes).toHaveLength(1);
  const write = scope.writes[0]; expect(write.url).toBe(`/api/checklist/${scope.id}/toggle`);
  expect(JSON.parse(JSON.stringify(write.options.body))).toEqual({ done: !done, revision: scope.revision, expectedOwnerId: scope.owner });
});
test('a retained conflicting decision reads the current task and closes its old decision before another review', async () => {
  const scope = retained({ status: 409 }); await scope.run();
  expect(scope.writes).toHaveLength(1); expect(scope.reads).toEqual(['current authoritative task read', 'current task presentation']);
  expect(scope.dialogs).toEqual([true, false]); expect(scope.notices.at(-1).text).toContain('Open it again to review its current status.');
});
test('a retained modal carries its originally reviewed owner rather than a subsequently switched account', async () => {
  const scope = retained({ accountChanged: true }); await scope.run();
  expect(scope.writes[0].options.body.expectedOwnerId).toBe(scope.owner);
});
