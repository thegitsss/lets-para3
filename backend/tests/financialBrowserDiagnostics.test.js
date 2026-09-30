const inspect = require("./playwright/financial-lifecycle/browser-diagnostics");
const origin = "http://127.0.0.1:5051", owner = "a".repeat(24), application = "b".repeat(24);
const legacy = `${origin}/dashboard-paralegal.html?applicationId=${application}#cases`, next = `${origin}/paralegal-v2.html#/work?applicationId=${application}`;
function fixture(path = "/api/auth/me") {
  return { engine: "webkit", origin, paralegalOwnerId: owner,
    errors: [{ role: "paralegal", name: "Fetch API cannot load http", message: "Native diagnostic", stack: `Fetch API cannot load ${origin}${path} due to access control checks.\n    at secureFetch`, page: legacy, at: 1036 }],
    events: [
      { role: "paralegal", type: "beforeunload", documentId: "old", page: legacy, at: 1000 },
      { role: "paralegal", type: "pagehide", documentId: "old", page: legacy, at: 1093, persisted: false },
      { role: "paralegal", type: "navigation", page: next, at: 1153 },
      { role: "paralegal", type: "pageshow", documentId: "new", page: next, at: 1675 },
    ] };
}
test.each(["/api/auth/me", `/api/cases/my-completed?expectedOwnerId=${owner}&limit=100`])("accounts for the observed departure diagnostic without deleting its raw evidence: %s", path => {
  const input = fixture(path), before = structuredClone(input), result = inspect(input);
  expect(result.documentFailures).toEqual([]); expect(result.unexplainedPageErrors).toEqual([]);
  expect(result.departureFetchDiagnostics).toEqual([expect.objectContaining({ error: input.errors[0], departingDocumentId: "old", nextDocumentId: "new", millisecondsAfterBeforeUnload: 36 })]);
  expect(input).toEqual(before);
});
test.each([
  ["Chromium", value => { value.engine = "chromium"; }],
  ["Firefox", value => { value.engine = "firefox"; }],
  ["active page", value => { value.events.shift(); }],
  ["canceled departure", value => { value.events.splice(1, 1); }],
  ["different departing document", value => { value.events[1].documentId = "other"; }],
  ["error after pagehide", value => { value.errors[0].at = 1100; }],
  ["long-running departure", value => { value.events[0].at = 0; }],
  ["foreign request", value => { value.errors[0].stack = value.errors[0].stack.replace(origin, "http://foreign.test"); }],
  ["another API", value => { value.errors[0].stack = value.errors[0].stack.replace("/api/auth/me", "/api/messages"); }],
  ["auth query", value => { value.errors[0].stack = value.errors[0].stack.replace("/api/auth/me", "/api/auth/me?unexpected=1"); }],
  ["another role", value => { value.errors[0].role = "attorney"; }],
  ["another destination", value => { value.events[2].page = `${origin}/paralegal-v2.html#/settings`; }],
  ["another application", value => { value.events[2].page = next.replace(application, "c".repeat(24)); }],
  ["no next document", value => { value.events.pop(); }],
  ["same document", value => { value.events[3].documentId = "old"; }],
  ["real exception", value => { value.errors[0].name = "TypeError"; }],
  ["missing stack", value => { delete value.errors[0].stack; }],
  ["unrelated event owner", value => { value.events.forEach(event => { event.role = "attorney"; }); }],
])("keeps %s observations as failing errors", (_name, edit) => {
  const input = fixture(); edit(input); const result = inspect(input);
  expect(result.unexplainedPageErrors).toEqual(input.errors); expect(result.departureFetchDiagnostics).toEqual([]);
});
test.each([
  `expectedOwnerId=${"c".repeat(24)}&limit=100`,
  `expectedOwnerId=${owner}&limit=200`,
  `expectedOwnerId=${owner}&expectedOwnerId=${owner}&limit=100`,
])("does not account for a different history read: %s", query => {
  const input = fixture(`/api/cases/my-completed?${query}`);
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
});
test.each(["windowerror", "unhandledrejection"])("a document %s remains a failure even during an otherwise recognized departure", type => {
  const input = fixture(), failure = { role: "paralegal", type, documentId: "old", page: legacy, at: 1036, message: "Actual application error" };
  input.events.push(failure); expect(inspect(input).documentFailures).toEqual([failure]);
});
test("an ordinary clean journey needs no departure exception", () => {
  expect(inspect({ engine: "webkit", origin, errors: [], events: [] })).toEqual({ documentFailures: [], unexplainedPageErrors: [], departureFetchDiagnostics: [] });
});

function financialDeparture(path = "/api/auth/me") {
  const input = fixture(path), caseId = "d".repeat(24);
  const departing = `${origin}/attorney-v2.html#/matters/${caseId}/financials`;
  const destination = `${origin}/case-detail.html?caseId=${caseId}&tab=financials`;
  input.attorneyOwnerId = owner;
  input.errors[0].role = "attorney"; input.errors[0].page = departing;
  input.events.forEach(event => { event.role = "attorney"; event.page = event.page === legacy ? departing : destination; });
  return input;
}

test.each(["/api/auth/me", `/api/notifications/page?limit=100&expectedOwnerId=${owner}`, `/api/notifications/unread-count?expectedOwnerId=${owner}`])("retains the exact observed attorney financial-document departure: %s", path => {
  const input = financialDeparture(path), before = structuredClone(input), result = inspect(input);
  expect(result.unexplainedPageErrors).toEqual([]); expect(result.documentFailures).toEqual([]);
  expect(result.departureFetchDiagnostics).toEqual([expect.objectContaining({ error: input.errors[0], departingDocumentId: "old", nextDocumentId: "new" })]);
  expect(input).toEqual(before);
});

test.each(["/api/auth/me", `/api/notifications/page?limit=100&expectedOwnerId=${owner}`, `/api/notifications/unread-count?expectedOwnerId=${owner}`])("requires a new document for a financials reload with the owned read %s", path => {
  const input = financialDeparture(path);
  input.events[2].page = input.errors[0].page; input.events[3].page = input.errors[0].page;
  expect(inspect(input).unexplainedPageErrors).toEqual([]);
  input.events[3].documentId = "old";
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
});

test.each([
  ["active document", value => { value.events.shift(); }],
  ["another Matter", value => { value.events[2].page = value.events[2].page.replace("d".repeat(24), "e".repeat(24)); }],
  ["another section", value => { value.errors[0].page = value.errors[0].page.replace("financials", "files"); }],
  ["different notification owner", value => { value.attorneyOwnerId = "e".repeat(24); }],
  ["missing notification owner", value => { delete value.attorneyOwnerId; }],
  ["unexpected request query", value => { value.errors[0].stack = value.errors[0].stack.replace("limit=100", "limit=100&cursor=extra"); }],
  ["another notification limit", value => { value.errors[0].stack = value.errors[0].stack.replace("limit=100", "limit=200"); }],
  ["another API", value => { value.errors[0].stack = value.errors[0].stack.replace("notifications/page", "messages"); }],
  ["unconfirmed destination", value => { value.events.pop(); }],
  ["extra destination query", value => { value.events[2].page += "&unexpected=1"; }],
  ["real exception", value => { value.errors[0].name = "TypeError"; }],
])("does not account for an attorney %s", (_name, edit) => {
  const input = financialDeparture(`/api/notifications/page?limit=100&expectedOwnerId=${owner}`); edit(input);
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
  expect(inspect(input).departureFetchDiagnostics).toEqual([]);
});

test.each(["windowerror", "unhandledrejection"])("retains an actual %s during the financial-document departure", type => {
  const input = financialDeparture(), failure = { role: "attorney", type, documentId: "old", page: input.errors[0].page, at: 1036 };
  input.events.push(failure); expect(inspect(input).documentFailures).toEqual([failure]);
});

function filesReload(path = `/api/uploads/case/${"d".repeat(24)}?presentation=matter`) {
  const input = fixture(path), page = `${origin}/paralegal-v2.html#/matter/${"d".repeat(24)}?tab=files`;
  input.errors[0].page = page; input.events.forEach(event => { event.page = page; });
  return input;
}

test.each(["/api/auth/me", `/api/uploads/case/${"d".repeat(24)}?presentation=matter`, `/api/notifications/page?limit=100&expectedOwnerId=${owner}`, `/api/notifications/unread-count?expectedOwnerId=${owner}`])("requires a confirmed files-document reload for the native read diagnostic %s", path => {
  const input = filesReload(path), original = structuredClone(input);
  expect(inspect(input).unexplainedPageErrors).toEqual([]); expect(inspect(input).documentFailures).toEqual([]);
  expect(input).toEqual(original);
  input.events[3].documentId = "old";
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
});

test.each([
  ["another Matter", value => { value.errors[0].stack = value.errors[0].stack.replace("d".repeat(24), "e".repeat(24)); }],
  ["another tab", value => { value.events[2].page = value.events[2].page.replace("tab=files", "tab=work"); }],
  ["extra query", value => { value.errors[0].stack = value.errors[0].stack.replace("presentation=matter", "presentation=matter&unexpected=1"); }],
  ["missing presentation", value => { value.errors[0].stack = value.errors[0].stack.replace("?presentation=matter", ""); }],
  ["active document", value => { value.events.shift(); }],
  ["unconfirmed reload", value => { value.events.pop(); }],
])("does not account for a files reload with %s", (_label, edit) => {
  const input = filesReload(); edit(input);
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
});

test("preserves files reload owner restrictions and actual document failures", () => {
  const input = filesReload(`/api/notifications/page?limit=100&expectedOwnerId=${owner}`);
  input.paralegalOwnerId = "e".repeat(24);
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
  const failure = { type: "unhandledrejection", role: "paralegal", documentId: "old", page: input.errors[0].page, at: 1036 };
  input.events.push(failure); expect(inspect(input).documentFailures).toEqual([failure]);
});

function settingsReload(path = `/api/notifications/page?limit=100&expectedOwnerId=${owner}`) {
  const input = fixture(path), page = `${origin}/paralegal-v2.html#/settings`;
  input.errors[0].page = page; input.events.forEach(event => { event.page = page; });
  if (path.startsWith("/api/users/me/onboarding")) input.errors[0].stack += `\n    at start (${origin}/assets/scripts/paralegal-v2/onboarding-controller.mjs:1:5282)`;
  return input;
}

test.each(["/api/auth/me", "/api/users/me/onboarding", `/api/notifications/page?limit=100&expectedOwnerId=${owner}`, `/api/notifications/unread-count?expectedOwnerId=${owner}`])("retains the recorded native Settings reload diagnostic without losing raw evidence: %s", path => {
  const input = settingsReload(path), original = structuredClone(input), result = inspect(input);
  expect(result.documentFailures).toEqual([]); expect(result.unexplainedPageErrors).toEqual([]);
  expect(result.departureFetchDiagnostics).toEqual([expect.objectContaining({ error: input.errors[0], departingDocumentId: "old", nextDocumentId: "new" })]);
  expect(input).toEqual(original);
});

test.each([
  ["missing owner", value => { delete value.paralegalOwnerId; }],
  ["different notification owner", value => { value.paralegalOwnerId = "e".repeat(24); }],
  ["extra request query", value => { value.errors[0].stack = value.errors[0].stack.replace("limit=100", "limit=100&cursor=extra"); }],
  ["auth query", value => { value.errors[0].stack = settingsReload("/api/auth/me?unexpected=1").errors[0].stack; }],
  ["onboarding query", value => { value.errors[0].stack = settingsReload("/api/users/me/onboarding?unexpected=1").errors[0].stack; }],
  ["duplicate owner", value => { value.errors[0].stack = value.errors[0].stack.replace(`expectedOwnerId=${owner}`, `expectedOwnerId=${owner}&expectedOwnerId=${owner}`); }],
  ["another limit", value => { value.errors[0].stack = value.errors[0].stack.replace("limit=100", "limit=200"); }],
  ["another API", value => { value.errors[0].stack = value.errors[0].stack.replace("notifications/page", "messages"); }],
  ["another route", value => { value.errors[0].page = value.errors[0].page.replace("#/settings", "#/home"); }],
  ["another destination", value => { value.events[2].page = `${origin}/paralegal-v2.html#/home`; }],
  ["missing next document", value => { value.events.pop(); }],
  ["same document", value => { value.events[3].documentId = "old"; }],
])("does not account for a Settings diagnostic with %s", (_label, edit) => {
  const input = settingsReload(); edit(input);
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
  expect(inspect(input).departureFetchDiagnostics).toEqual([]);
});

test("an onboarding save or unknown caller is not the observed onboarding read", () => {
  const input = settingsReload("/api/users/me/onboarding");
  input.errors[0].stack = input.errors[0].stack.replace("at start (", "at save (");
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
});

test.each(["windowerror", "unhandledrejection"])("an actual %s still fails during a Settings reload", type => {
  const input = settingsReload(), failure = { role: "paralegal", type, documentId: "old", page: input.errors[0].page, at: 1036 };
  input.events.push(failure);
  expect(inspect(input).documentFailures).toEqual([failure]);
});

function invitationWorkDeparture(path = `/api/paralegal/dashboard?expectedOwnerId=${owner}`) {
  const input = fixture(path), page = `${origin}/paralegal-v2.html#/work?section=invitations`;
  input.errors[0].page = page;
  input.errors[0].stack += `\n    at loadSnapshot (${origin}/assets/scripts/paralegal-v2/work-view.mjs:1:7611)`;
  input.events.forEach(event => { event.page = event.page === legacy ? page : `${origin}/browse-jobs.html`; });
  return input;
}

test.each([
  `/api/paralegal/dashboard?expectedOwnerId=${owner}`,
  "/api/applications/my",
  "/api/cases/invited-to",
  `/api/cases/my-completed?expectedOwnerId=${owner}&limit=100&reviewContexts=1`,
  "/api/account/dashboard-views?scope=paralegal_applications",
  "/api/payments/connect/status",
])("retains the captured Work snapshot read only across a verified Browse departure: %s", path => {
  const input = invitationWorkDeparture(path), original = structuredClone(input), result = inspect(input);
  expect(result.documentFailures).toEqual([]); expect(result.unexplainedPageErrors).toEqual([]);
  expect(result.departureFetchDiagnostics).toEqual([expect.objectContaining({ error: input.errors[0], departingDocumentId: "old", nextDocumentId: "new", millisecondsAfterBeforeUnload: 36 })]);
  expect(input).toEqual(original);
});

test.each([
  ["missing verified owner", value => { delete value.paralegalOwnerId; }],
  ["different dashboard owner", value => { value.paralegalOwnerId = "e".repeat(24); }],
  ["extra request query", value => { value.errors[0].stack = value.errors[0].stack.replace(`expectedOwnerId=${owner}`, `expectedOwnerId=${owner}&unexpected=1`); }],
  ["duplicate request owner", value => { value.errors[0].stack = value.errors[0].stack.replace(`expectedOwnerId=${owner}`, `expectedOwnerId=${owner}&expectedOwnerId=${owner}`); }],
  ["source document query", value => { value.errors[0].page = value.errors[0].page.replace(".html#", ".html?unexpected=1#"); }],
  ["another Work section", value => { value.errors[0].page = value.errors[0].page.replace("section=invitations", "section=applications"); }],
  ["missing read frame", value => { value.errors[0].stack = value.errors[0].stack.split("\n")[0]; }],
  ["write caller", value => { value.errors[0].stack = value.errors[0].stack.replace("at loadSnapshot (", "at saveView ("); }],
  ["foreign read frame", value => { value.errors[0].stack = value.errors[0].stack.replace(`at loadSnapshot (${origin}`, "at loadSnapshot (http://foreign.test"); }],
  ["queried read script", value => { value.errors[0].stack = value.errors[0].stack.replace("work-view.mjs:1:7611", "work-view.mjs?unexpected=1:1:7611"); }],
  ["another read script", value => { value.errors[0].stack = value.errors[0].stack.replace("work-view.mjs", "other-view.mjs"); }],
  ["another API", value => { value.errors[0].stack = value.errors[0].stack.replace("/api/paralegal/dashboard", "/api/messages"); }],
  ["destination query", value => { value.events[2].page += "?unexpected=1"; }],
  ["destination fragment", value => { value.events[2].page += "#unexpected"; }],
  ["another destination", value => { value.events[2].page = `${origin}/paralegal-v2.html#/home`; }],
  ["no next document", value => { value.events.pop(); }],
  ["same next document", value => { value.events[3].documentId = "old"; }],
  ["canceled departure", value => { value.events.splice(1, 1); }],
])("does not account for a Work departure with %s", (_label, edit) => {
  const input = invitationWorkDeparture(); edit(input); const result = inspect(input);
  expect(result.unexplainedPageErrors).toEqual(input.errors);
  expect(result.departureFetchDiagnostics).toEqual([]);
});

test.each([
  `/api/cases/my-completed?expectedOwnerId=${"e".repeat(24)}&limit=100&reviewContexts=1`,
  `/api/cases/my-completed?expectedOwnerId=${owner}&limit=200&reviewContexts=1`,
  `/api/cases/my-completed?expectedOwnerId=${owner}&limit=100&reviewContexts=0`,
  `/api/cases/my-completed?expectedOwnerId=${owner}&limit=100`,
  "/api/account/dashboard-views?scope=attorney_matters",
  "/api/account/dashboard-views?scope=paralegal_applications&scope=paralegal_applications",
  "/api/applications/my?unexpected=1",
  "/api/cases/invited-to?unexpected=1",
  "/api/payments/connect/status?unexpected=1",
])("does not recognize a different Work snapshot query: %s", path => {
  const input = invitationWorkDeparture(path);
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
});

test.each(["windowerror", "unhandledrejection"])("preserves actual %s failures during the Work departure", type => {
  const input = invitationWorkDeparture(), failure = { role: "paralegal", type, documentId: "old", page: input.errors[0].page, at: 1036 };
  input.events.push(failure);
  expect(inspect(input).documentFailures).toEqual([failure]);
});


test.each([
  `/api/paralegal/dashboard?expectedOwnerId=${owner}`,
  "/api/applications/my",
  "/api/cases/invited-to",
  `/api/cases/my-completed?expectedOwnerId=${owner}&limit=100&reviewContexts=1`,
  "/api/account/dashboard-views?scope=paralegal_applications",
  "/api/payments/connect/status",
].flatMap(path => [1, 2].map(offset => [path, offset])))("retains post-pagehide Work read %s delivered %ims after hide, before Browse navigation", (path, offset) => {
  const input = invitationWorkDeparture(path);
  input.errors[0].at = input.events[1].at + offset;
  const original = structuredClone(input), result = inspect(input);
  expect(result.documentFailures).toEqual([]); expect(result.unexplainedPageErrors).toEqual([]);
  expect(result.departureFetchDiagnostics).toEqual([expect.objectContaining({ error: input.errors[0], departingDocumentId: "old", nextDocumentId: "new" })]);
  expect(input).toEqual(original);
});

test.each([
  ["hide before departure", value => { value.events[1].at = value.events[0].at - 1; }],
  ["report before departure", value => { value.errors[0].at = value.events[0].at - 1; }],
  ["report after destination navigation", value => { value.errors[0].at = value.events[2].at + 1; }],
  ["report after destination pageshow", value => { value.errors[0].at = value.events[3].at + 1; }],
  ["report outside departure interval", value => { value.errors[0].at = value.events[0].at + 1001; value.events[2].at = value.errors[0].at + 1; value.events[3].at = value.events[2].at + 1; }],
  ["persisted departing page", value => { value.events[1].persisted = true; }],
  ["missing beforeunload", value => { value.events.shift(); }],
  ["late destination navigation", value => { value.events[2].at = value.events[1].at + 1001; value.events[3].at = value.events[2].at + 1; }],
  ["unconfirmed new document", value => { value.events.pop(); }],
])("keeps post-pagehide Work diagnostics unexplained with %s", (_label, edit) => {
  const input = invitationWorkDeparture(); input.errors[0].at = input.events[1].at + 1; edit(input);
  const result = inspect(input);
  expect(result.unexplainedPageErrors).toEqual(input.errors); expect(result.departureFetchDiagnostics).toEqual([]);
});

test.each(["windowerror", "unhandledrejection"])("preserves actual %s after Work pagehide", type => {
  const input = invitationWorkDeparture(); input.errors[0].at = input.events[1].at + 1;
  const failure = { role: "paralegal", type, documentId: "old", page: input.errors[0].page, at: input.errors[0].at };
  input.events.push(failure);
  expect(inspect(input).documentFailures).toEqual([failure]);
});

test.each([
  ["legacy application", fixture],
  ["attorney financials", financialDeparture],
  ["paralegal files", filesReload],
  ["paralegal Settings", settingsReload],
])("does not change the existing post-pagehide contract for %s", (_label, makeInput) => {
  const input = makeInput(); input.errors[0].at = input.events[1].at + 1;
  expect(inspect(input).unexplainedPageErrors).toEqual(input.errors);
  expect(inspect(input).departureFetchDiagnostics).toEqual([]);
});

function inventoryReload(matter = false) {
  const input = fixture(), page = `${origin}/dashboard-attorney.html?archivedPage=6#cases:archived`;
  input.attorneyOwnerId = owner;
  input.errors[0].role = 'attorney'; input.errors[0].page = page;
  input.errors[0].stack = `Fetch API cannot load ${origin}/api/auth/me due to access control checks.
    at request (${origin}/assets/scripts/attorney-v2/api-client.mjs:1:1766)
    at verifyCaseNoteOwner (${origin}/assets/scripts/attorney-tabs.js?v=20260905-matter-notes:1:159083)
    at load (${origin}/assets/scripts/utils/current-draft-inventory.mjs:1:1333)
    ${matter ? `at readCurrentMattersFrom (${origin}/assets/scripts/attorney-tabs.js?v=20260905-matter-notes:1:147141)` : ''}
    at refreshApplicationsOverview (${origin}/assets/scripts/attorney-tabs.js?v=20260905-matter-notes:1:218920)`;
  input.events.forEach(event => { event.role = 'attorney'; event.page = page; });
  return input;
}

test.each([false, true])('retains the captured inventory owner read across a verified reload, Matter caller %s', matter => {
  const input = inventoryReload(matter), original = structuredClone(input), result = inspect(input);
  expect(result.unexplainedPageErrors).toEqual([]); expect(result.documentFailures).toEqual([]);
  expect(result.departureFetchDiagnostics).toEqual([expect.objectContaining({ error: input.errors[0], departingDocumentId: 'old', nextDocumentId: 'new' })]);
  expect(input).toEqual(original);
});

test.each([
  ["missing verified owner", value => { delete value.attorneyOwnerId; }],
  ["malformed owner", value => { value.attorneyOwnerId = 'unknown'; }],
  ["active inventory", value => { value.errors[0].page = value.errors[0].page.replace('#cases:archived','#cases:active'); }],
  ["another archived page", value => { value.errors[0].page = value.errors[0].page.replace('archivedPage=6','archivedPage=5'); }],
  ["extra document query", value => { value.errors[0].page = value.errors[0].page.replace('#cases:', '&extra=1#cases:'); }],
  ["auth query", value => { value.errors[0].stack = value.errors[0].stack.replace('/api/auth/me ', '/api/auth/me?extra=1 '); }],
  ["another API", value => { value.errors[0].stack = value.errors[0].stack.replace('/api/auth/me', '/api/messages'); }],
  ["foreign request", value => { value.errors[0].stack = value.errors[0].stack.replace(origin, 'http://foreign.test'); }],
  ["missing owner verifier", value => { value.errors[0].stack = value.errors[0].stack.replace('at verifyCaseNoteOwner (', 'at unknown ('); }],
  ["missing refresh caller", value => { value.errors[0].stack = value.errors[0].stack.replace('at refreshApplicationsOverview (', 'at unknown ('); }],
  ["write caller", value => { value.errors[0].stack = value.errors[0].stack.replace('at load (', 'at save ('); }],
  ["foreign read frame", value => { value.errors[0].stack = value.errors[0].stack.replace(`at load (${origin}`, 'at load (http://foreign.test'); }],
  ["different script version", value => { value.errors[0].stack = value.errors[0].stack.replaceAll('20260905-matter-notes', 'other-version'); }],
  ["same replacement document", value => { value.events[3].documentId = 'old'; }],
  ["persisted departing document", value => { value.events[1].persisted = true; }],
  ["missing beforeunload", value => { value.events.shift(); }],
  ["report after pagehide", value => { value.errors[0].at = value.events[1].at + 1; }],
  ["report before departure", value => { value.errors[0].at = value.events[0].at - 1; }],
  ["report after navigation", value => { value.errors[0].at = value.events[2].at + 1; }],
  ["late pagehide", value => { value.events[1].at = value.events[0].at + 1001; }],
  ["late navigation", value => { value.events[2].at = value.events[1].at + 1001; }],
  ["missing replacement document", value => { value.events.pop(); }],
  ["different destination", value => { value.events[2].page = `${origin}/dashboard-attorney.html?archivedPage=5#cases:archived`; }],
  ["different role", value => { value.errors[0].role = 'paralegal'; }],
  ["Chromium", value => { value.engine = 'chromium'; }],
  ["Firefox", value => { value.engine = 'firefox'; }],
  ["application exception", value => { value.errors[0].name = 'TypeError'; }],
])('keeps an inventory diagnostic unexplained with %s', (_label, edit) => {
  const input = inventoryReload(); edit(input); const result = inspect(input);
  expect(result.unexplainedPageErrors).toEqual(input.errors); expect(result.departureFetchDiagnostics).toEqual([]);
});

test.each(['windowerror', 'unhandledrejection'])('preserves actual %s during inventory reload', type => {
  const input = inventoryReload(), failure = { role: 'attorney', type, documentId: 'old', page: input.errors[0].page, at: 1036 };
  input.events.push(failure);
  expect(inspect(input).documentFailures).toEqual([failure]);
});
