const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
function check(module, program) {
  const url = pathToFileURL(path.resolve(__dirname, "../../frontend/assets/scripts", module)).href;
  execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as subject from ${JSON.stringify(url)}; ${program}`], { stdio: "pipe" });
}

test("attorney notification destinations preserve exact Matter objects inside valid V2 routes", () => check("attorney-v2/routes.mjs", `
  const matter = 'aaaaaaaaaaaaaaaaaaaaaaaa', object = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  for (const [tab, key] of [['applications','applicantId'],['files','fileId'],['messages','messageId'],['activity','eventId'],['deadlines','eventId'],['work','taskId']]) {
    const destination = subject.notificationDestination({ action: { href: '/case-detail.html?caseId=' + matter + '&tab=' + tab + '&' + key + '=' + object }});
    assert.equal(destination.href, '/attorney-v2.html#/matters/' + matter + '/' + tab + '?' + key + '=' + object);
    assert.equal(subject.parseRoute(new URL(destination.href, 'https://lpc.invalid').hash).found, true);
  }
  const map = new Map([
    ['/dashboard-attorney.html?highlightCase=' + matter + '#cases:archived', '/matters/' + matter + '/overview'],
    ['/dashboard-attorney.html#funds', '/payments'],
    ['/dashboard-attorney.html#cases', '/matters'],
    ['/profile-settings.html?tab=security', '/settings?tab=security'],
    ['/profile-paralegal.html?paralegalId=' + object, '/paralegals/' + object],
    ['/help.html', '/help'],
    ['/help.html?incident=INC-20260909-000001', '/help?incident=INC-20260909-000001'],
    ['/case-detail.html?caseId=' + matter + '#case-messages', '/matters/' + matter + '/messages'],
  ]);
  for (const [href, expected] of map) assert.equal(subject.notificationDestination({action:{href}}).href, '/attorney-v2.html#' + expected);
  for (const href of ['https://evil.test/case-detail.html?caseId=' + matter, '//evil.test/', 'javascript:alert(1)', '/api/users/me', '/case-detail.html?caseId=bad', '/case-detail.html?caseId=' + matter + '&tab=unknown', '/profile-settings.html?returnTo=https://evil.test/', '/attorney-v2.html#/unknown', 'https://user:pass@lpc.invalid/help.html', '/help.html?incident=invalid']) assert.equal(subject.notificationDestination({action:{href}}), null, href);
`));

test("attorney notification writes are fixed, owner-preflighted, CSRF-protected and account-bound", () => check("attorney-v2/api-client.mjs", `
  const ownerId = 'aaaaaaaaaaaaaaaaaaaaaaaa', id = 'bbbbbbbbbbbbbbbbbbbbbbbb', calls = [];
  const api = subject.createApiClient({ fetchImpl: async (path, options) => {
    calls.push({path,options});
    const payload = path === '/api/auth/me' ? { user: { _id: ownerId, role: 'attorney', status: 'approved' }} : path === '/api/csrf' ? { csrfToken: 'test-csrf' } : { success: true };
    return new Response(JSON.stringify(payload));
  }});
  for (const [path, method] of [['/api/notifications/' + id + '/read','POST'],['/api/notifications/' + id + '/unread','POST'],['/api/notifications/read-all','POST'],['/api/notifications/' + id,'DELETE'],['/api/notifications','DELETE']]) {
    calls.length = 0;
    assert.equal((await api.mutateNotification(path,method,{ownerId})).success,true);
    assert.equal(calls.length,3); assert.equal(calls[0].path,'/api/auth/me'); assert.equal(calls[1].path,'/api/csrf');
    assert.equal(calls[2].options.method,method); assert.deepEqual(JSON.parse(calls[2].options.body),{expectedOwnerId:ownerId});
    assert.equal(calls[2].options.headers['X-CSRF-Token'],'test-csrf');
  }
  for (const [path,method] of [['/api/account/deactivate','DELETE'],['/api/notifications/../../account/deactivate','DELETE'],['/api/notifications','POST'],['/api/notifications/read-all','GET'],['/api/notifications/not-an-id','DELETE']]) assert.throws(() => api.mutateNotification(path,method,{ownerId}));
`));

for (const role of ["attorney-v2", "paralegal-v2"]) test(`${role} invalidates account authority on notification cookie mismatch`, () => check(`${role}/api-client.mjs`, `
  let losses = 0;
  const api = subject.createApiClient({ onAuthenticationLost: () => losses++, fetchImpl: async () => new Response(JSON.stringify({code:'ACCOUNT_CHANGED',message:'Your account changed. Refresh before continuing.'}), { status:403, headers:{'content-type':'application/json'} }) });
  await assert.rejects(api.get('/api/notifications/page?expectedOwnerId=aaaaaaaaaaaaaaaaaaaaaaaa'), error => error.kind === 'authentication');
  assert.equal(losses,1);
`));

test("paralegal notification transport sends the owner expectation as JSON through its existing CSRF boundary", () => check("paralegal-v2/api-client.mjs", `
  const calls = [], ownerId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const api = subject.createApiClient({ fetchImpl: async (path,options) => { calls.push({path,options}); return new Response(JSON.stringify(path === '/api/csrf' ? {csrfToken:'test-csrf'} : {success:true}),{headers:{'content-type':'application/json'}}); }});
  await api.request('/api/notifications',{method:'DELETE',body:JSON.stringify({expectedOwnerId:ownerId})});
  assert.equal(calls.length,2); assert.deepEqual(JSON.parse(calls[1].options.body),{expectedOwnerId:ownerId});
  assert.equal(calls[1].options.headers.get('X-CSRF-Token'),'test-csrf');
`));


test("paralegal Help notification destinations preserve only valid report references", () => check("paralegal-v2/deep-links.mjs", `
  assert.equal(subject.adaptLegacyDestination('/paralegalhelp.html?incident=INC-20260909-000001').href, '/paralegal-v2.html#/help?incident=INC-20260909-000001');
  for (const href of ['/paralegalhelp.html?incident=bad', '/paralegalhelp.html?incident=%3Cscript%3E', 'https://evil.test/paralegalhelp.html?incident=INC-20260909-000001']) assert.equal(subject.adaptLegacyDestination(href), null);
`));

test("report status projects public fields and rejects mismatched, malformed and non-progressing pages", () => check("utils/report-status.mjs", `
  const publicId = 'INC-20260909-000001', at = '2026-09-09T12:00:00.000Z';
  const incident = { publicId, summary:'A report', userVisibleStatus:'received', createdAt:at, updatedAt:at, state:'internal-state', resolution:{code:'internal-code',summary:'A resolution'} };
  const payload = {ok:true,incident, events:[{seq:5,summary:'Received',createdAt:at,eventType:'internal-type',toState:'internal-state'}], hasMore:true,nextCursor:'5'};
  assert.deepEqual(subject.readReportUpdates(payload,publicId).events,[{seq:5,summary:'Received',createdAt:at}]);
  assert.equal(JSON.stringify(subject.readReport(payload,publicId)).includes('internal-'),false);
  for (const value of [{...payload,ok:false},{...payload,incident:{...incident,publicId:'INC-20260909-000002'}},{...payload,incident:{...incident,userVisibleStatus:'unknown'}},{...payload,incident:{...incident,createdAt:'bad'}},{...payload,events:[payload.events[0],payload.events[0]]},{...payload,nextCursor:'4'},{...payload,hasMore:false},{...payload,events:[]}]) assert.throws(() => subject.readReportUpdates(value,publicId));
  assert.throws(() => subject.readReportUpdates(payload,publicId,5));
  assert.equal(subject.readReportUpdates({...payload,hasMore:false,nextCursor:null},publicId).nextCursor,null);
`));
