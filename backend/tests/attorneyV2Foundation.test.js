const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const directory = path.resolve(__dirname, "../../frontend/assets/scripts/attorney-v2");
function check(module, program) {
  const url = pathToFileURL(path.join(directory, module)).href;
  execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as subject from ${JSON.stringify(url)}; ${program}`], { stdio: "pipe" });
}

describe("Attorney V2 foundation behavior", () => {
  test("production defaults off and cohort membership never overrides role or approval", () => check("release.mjs", `
    const attorney = { id: 'a', role: 'attorney', status: 'approved' };
    assert.equal(subject.canEnter(attorney, 'example.com'), false);
    assert.equal(subject.canEnter(attorney, 'localhost'), true);
    const release = { enabled: true, attorneyIds: ['a'] };
    assert.equal(subject.canEnter(attorney, 'example.com', release), true);
    for (const patch of [{ id: 'b' }, { role: 'paralegal' }, { status: 'pending' }, { disabled: true }, { deleted: true }]) {
      assert.equal(subject.canEnter({ ...attorney, ...patch }, 'example.com', release), false);
    }
    for (const hostname of ['localhost.evil.test', 'example.com', '127.0.0.1.evil.test']) assert.equal(subject.isLocalPreview(hostname), false);
  `));

  test("session authority rejects malformed, disabled, unapproved and other-role identities", () => check("session-boundary.mjs", `
    const user = { _id: 'a', role: 'attorney', status: 'approved' };
    assert.equal(subject.classifySession({ user }).state, 'ready');
    for (const user of [null, [], {}, 'attorney']) assert.equal(subject.classifySession({ user }).state, 'unauthenticated');
    assert.equal(subject.classifySession({ user: { ...user, disabled: true } }).state, 'unavailable');
    assert.equal(subject.classifySession({ user: { ...user, status: 'pending' } }).state, 'unapproved');
    assert.equal(subject.classifySession({ user: { ...user, role: 'paralegal' } }).state, 'wrong_role');
    assert.equal(subject.projectIdentity({ ...user, secret: 'never retain', preferences: { theme: 'mountain-dark' } }).secret, undefined);
    assert.equal(subject.projectIdentity({ ...user, preferences: { theme: 'mountain-dark' } }).preferences.theme, 'dark');
  `));

  test("routes retain navigation meaning and reject malformed workspace identities", () => check("routes.mjs", `
    assert.equal(subject.parseRoute('').name, 'home');
    assert.equal(subject.parseRoute('#/').name, 'home');
    for (const section of subject.SECTIONS) assert.equal(subject.parseRoute('#' + section.path).name, section.name);
    const files = subject.parseRoute('#/matters/aaaaaaaaaaaaaaaaaaaaaaaa/files');
    assert.equal(files.name, 'matter-downloads');
    assert.equal(files.caseId, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(files.tab, 'files');
    assert.equal(subject.parseRoute('#/matters/%2Fsecrets/files').found, false);
    assert.equal(subject.parseRoute('#/settings?tab=security').query.get('tab'), 'security');
    assert.equal(subject.legacyDestination(subject.parseRoute('#/payments')), '/dashboard-attorney.html#funds');
    assert.equal(subject.legacyDestination(subject.parseRoute('#/matters/new?draftId=a')), '/create-case.html?draftId=a');
    assert.equal(subject.legacyDestination(subject.parseRoute('#/matters?openApplicants=1')), '/dashboard-attorney.html?openApplicants=1#cases');
    assert.equal(subject.legacyDestination(subject.parseRoute('#/matters?view=applications')), '/dashboard-attorney.html#cases:inquiries');
    assert.equal(subject.legacyDestination(subject.parseRoute('#/matters?view=archived')), '/dashboard-attorney.html#cases:archived');
  `));

  test("handoffs reject open redirects, credentials, unknown pages, and unsafe nested returns", () => check("routes.mjs", `
    for (const href of ['https://evil.test/', '//evil.test/', 'javascript:alert(1)', '/api/account/deactivate', '/login.html', '/profile-paralegal.html?returnTo=https%3A%2F%2Fevil.test', '/profile-paralegal.html?returnTo=%2Fprofile-paralegal.html%3FreturnTo%3Dhttps%253A%252F%252Fevil.test', 'https://user:pass@lpc.invalid/case-detail.html']) {
      assert.equal(subject.safeLegacyHref(href), null, href);
    }
    assert.equal(subject.safeLegacyHref('/case-detail.html?caseId=a&tab=files'), '/case-detail.html?caseId=a&tab=files');
    assert.equal(subject.safeLegacyHref('dashboard-attorney.html?openApplicants=1#cases:inquiries'), '/dashboard-attorney.html?openApplicants=1#cases:inquiries');
  `));

  test("API client only accepts same-origin API paths including encoded traversal defenses", () => check("api-client.mjs", `
    for (const value of ['https://evil.test/api/a', '//evil.test/api/a', '/api/../login', '/api/%2e%2e/login', '/api/%252e%252e/login', '/api/a#fragment', '/api/a b']) assert.throws(() => subject.safeApiPath(value));
    assert.equal(subject.safeApiPath('/api/cases/search?q=two%20words'), '/api/cases/search?q=two%20words');
  `));

  test("API requests are cookie-authenticated, uncached, and are never retried", () => check("api-client.mjs", `
    const calls = [];
    let losses = 0;
    const api = subject.createApiClient({ fetchImpl: async (...args) => { calls.push(args); return new Response(JSON.stringify({ error: 'Session expired' }), { status: 401 }); }, onAuthenticationLost: () => losses++ });
    await assert.rejects(api.get('/api/auth/me'), error => error.kind === 'authentication');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].credentials, 'include');
    assert.equal(calls[0][1].cache, 'no-store');
    assert.equal(calls[0][1].redirect, 'error');
    assert.equal(calls[0][1].method, 'GET');
    assert.equal(losses, 1);
  `));

  test("clearing a session suppresses late responses even when the transport ignores abort", () => check("api-client.mjs", `
    let resolve;
    const api = subject.createApiClient({ fetchImpl: () => new Promise(done => { resolve = done; }) });
    const pending = api.get('/api/cases/search?q=test');
    api.clear();
    resolve(new Response(JSON.stringify({ confidential: 'previous account' })));
    await assert.rejects(pending, error => error.name === 'AbortError');
  `));

  test("authorization errors stay distinct from network failures and do not expose response bodies", () => check("api-client.mjs", `
    let losses = 0;
    const api = subject.createApiClient({ fetchImpl: async () => new Response(JSON.stringify({ error: 'Confidential case detail' }), { status: 403 }), onAuthenticationLost: () => losses++ });
    await assert.rejects(api.get('/api/cases/search'), error => error.kind === 'authorization' && !error.message.includes('Confidential'));
    assert.equal(losses, 0);
    const offline = subject.createApiClient({ fetchImpl: async () => { throw new Error('private server details'); } });
    await assert.rejects(offline.get('/api/auth/me'), error => error.kind === 'network' && !error.message.includes('private'));
  `));

  test("router contains render failures and suppresses stale async route results", () => check("router.mjs", `
    let fail = false, delayed = false, resolve;
    const outlet = { addEventListener() {}, removeEventListener() {}, scrollTop: 0, content: 'original', replaceChildren(value) { this.content = value; }, setAttribute() {}, focus() {} };
    const win = { location: { hash: '#/home' }, document: { title: '', documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} };
    const router = subject.createRouter({ outlet, windowObject: win, onError: () => 'retry', render: async route => {
      if (fail) throw new Error('View failure');
      if (delayed) return new Promise(done => { resolve = done; });
      return route.name;
    } });
    await router.start();
    assert.equal(outlet.content, 'home');
    fail = true;
    await router.refresh();
    assert.equal(outlet.content, 'retry');
    fail = false; delayed = true;
    const old = router.refresh();
    assert.equal(outlet.content, 'retry');
    delayed = false; win.location.hash = '#/matters';
    await router.refresh();
    resolve('stale home'); await old;
    assert.equal(outlet.content, 'matters');
    delayed = true;
    const stopped = router.refresh(); router.stop(); resolve('after logout'); await stopped;
    assert.equal(outlet.content, 'matters');
  `));

  test("tour completion is a fixed CSRF-protected acknowledgment with no automatic retry", () => check("api-client.mjs", `
    const calls = [];
    const api = subject.createApiClient({ fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return path === '/api/csrf' ? new Response(JSON.stringify({ csrfToken: 'synthetic' })) : new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
    } });
    await assert.rejects(api.completeAttorneyTour());
    assert.equal(calls.length, 2);
    assert.equal(calls[1].path, '/api/users/me/onboarding');
    assert.equal(calls[1].options.method, 'PATCH');
    assert.equal(calls[1].options.headers['X-CSRF-Token'], 'synthetic');
    assert.deepEqual(JSON.parse(calls[1].options.body), { attorneyTourCompleted: true });
    const empty = subject.createApiClient({ fetchImpl: async () => new Response('{}') });
    await assert.rejects(empty.completeAttorneyTour(), error => error.kind === 'invalid_response');
  `));
});

test("session read retries only transient failures and abandons replaced accounts", () => check("session-read.mjs", `
  let calls=0;
  const payload={user:{id:'a',role:'attorney',status:'approved'}};
  const api={get:async()=>{if(++calls===1)throw {kind:'network'};return payload;}};
  assert.equal(await subject.readSession(api,{wait:async()=>{}}),payload);
  assert.equal(calls,2);
  for (const malformed of [null, [], {}, '<html>Unavailable</html>', {user:{}}, {user:{id:'a',role:'attorney'}}, {user:'invalid'}]) {
    calls=0;await assert.rejects(subject.readSession({get:async()=>{calls++;return malformed;}},{wait:async()=>{}}),{kind:'invalid_response'});assert.equal(calls,1);
  }
  assert.deepEqual(await subject.readSession({get:async()=>({user:null})}),{user:null});
  calls=0;
  assert.equal(await subject.readSession({get:async()=>{if(++calls===1)throw {status:503,retryAfterMs:50000};return payload;}},{wait:async delay=>assert.equal(delay,5000)}),payload);
  for(const error of [{kind:'authentication',status:401},{kind:'authorization',status:403},{kind:'invalid_response',status:200},{status:429},{name:'AbortError'}]){
    calls=0;await assert.rejects(subject.readSession({get:async()=>{calls++;throw error;}},{wait:async()=>{}}));assert.equal(calls,1);
  }
  calls=0;let current=true;
  await assert.rejects(subject.readSession({get:async()=>{calls++;throw {kind:'network'};}},{isCurrent:()=>current,wait:async()=>{current=false;}}),{name:'AbortError'});
  assert.equal(calls,1);
  calls=0;await assert.rejects(subject.readSession({get:async()=>{calls++;throw {status:503};}},{wait:async()=>{}}));assert.equal(calls,2);
  calls=0;const signals=[];
  const canceled = new AbortController();let finish;
  const pendingRead = subject.readSession({get:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}},{signal:canceled.signal});
  canceled.abort();finish(payload);
  await assert.rejects(pendingRead,{name:'AbortError'});assert.equal(calls,1);
  calls=0;
  const stalled={get:(_path,{signal})=>{calls++;signals.push(signal);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError')),{once:true}));}};
  await assert.rejects(subject.readSession(stalled,{timeoutMs:5,wait:async()=>{}}),{kind:'network',status:0});
  assert.equal(calls,2);assert.ok(signals.every(signal=>signal.aborted));
  calls=0;
  assert.equal(await subject.readSession({get:(path,options)=>++calls===1?stalled.get(path,options):Promise.resolve(payload)},{timeoutMs:5,wait:async()=>{}}),payload);
`));
test('temporary service responses expose only a bounded numeric retry hint', () => check('api-client.mjs', `
  for (const [hint, expected] of [['5',5000],['999',5000],['1',1000],['invalid',undefined],['-1',undefined]]) {
    const api=subject.createApiClient({fetchImpl:async()=>new Response('{}',{status:503,headers:{'Retry-After':hint}})});
    await assert.rejects(api.get('/api/auth/me'),error=>error.status===503 && error.retryAfterMs===expected);
  }
`));
