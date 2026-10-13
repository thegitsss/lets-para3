const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const url = pathToFileURL(path.resolve(__dirname, "../../frontend/assets/scripts/attorney-v2/read-model.mjs")).href;
function check(program) {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import * as s from ${JSON.stringify(url)}; ${program}`], { stdio: "pipe" });
}

describe("Attorney V2 read model", () => {
  test("malformed counts cannot become zero and cents/currency are explicit", () => check(`
    for (const value of [undefined, null, '0', -1, NaN, Infinity, 1.2]) assert.throws(() => s.count(value));
    assert.equal(s.count(0), 0);
    assert.equal(s.money(10005, 'usd'), '$100.05');
    assert.equal(s.money(10005, 'eur'), '€100.05');
    assert.equal(s.money(undefined), 'Amount unavailable');
    assert.equal(s.amount({ remainingAmount: 0, lockedTotalAmount: 50000 }), '$0.00');
    assert.equal(s.amount({ localDraft: true, compAmount: '450.00' }), '');
  `));
  test("categories retain posted, inquiry, paid, paused and relisted distinctions", () => check(`
    assert.equal(s.bucket({ status: 'open', applicantsCount: 0 }), 'active');
    assert.equal(s.bucket({ status: 'open', applicantsCount: 2 }), 'applications');
    assert.equal(s.bucket({ status: 'active', paralegal: { id: 'p' }, applicantsCount: 2 }), 'active');
    for (const status of ['completed', 'closed', 'cancelled', 'canceled']) assert.equal(s.bucket({ status }), 'archived');
    assert.equal(s.bucket({ status: 'active', paymentReleased: true }), 'archived');
    assert.equal(s.bucket({ status: 'paused' }), 'archived');
    assert.equal(s.bucket({ status: 'paused', relistRequestedAt: '2026-09-01' }), 'active');
    assert.equal(s.bucket({ status: 'paused', payoutFinalizedAt: '2026-09-01', payoutFinalizedType: 'partial_attorney' }), 'active');
    assert.equal(s.bucket({ status: 'paused', archived: true, relistRequestedAt: '2026-09-01' }), 'archived');
    assert.equal(s.bucket({ localDraft: true, status: 'draft' }), 'draft');
  `));
  test("unknown status does not invent a funded workspace or a lifecycle action", () => check(`
    const item = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'funded_in_progress', archived: false, paymentReleased: false, escrowStatus: 'funded', escrowIntentId: 'pi_test', paralegal: { id: 'p' } };
    assert.equal(s.workspaceEligible(item), false);
    assert.equal(s.statusLabel(item), 'Status: funded in progress');
    assert.equal(s.matterHref(item), '#/matters/aaaaaaaaaaaaaaaaaaaaaaaa/overview');
    assert.equal(s.workspaceEligible({ ...item, status: 'active' }), true);
    assert.equal(s.workspaceEligible({ ...item, status: 'active', escrowIntentId: null }), false);
    assert.equal(s.matterHref({ id: 'evil/id' }), '#/matters');
  `));
  test("Matter reads stay in V2 while selected applicants and tabs retain their identity", () => check(`
    const id='a'.repeat(24), applicantId='b'.repeat(24), applicationId='c'.repeat(24);
    for(const status of ['open','active','paused','disputed','completed','closed','unknown']) {
      assert.equal(s.matterHref({id,status},'files'),'#/matters/'+id+'/files');
      assert.equal(s.workspaceEligible({id,status}),false);
    }
    assert.equal(s.matterHref({id,localDraft:true}),'#/matters/new?draftId='+id+'&step=description');
    assert.equal(s.matterHref({id},'not-a-tab'),'#/matters');
    assert.equal(s.reviewHref({id,applicantId,applicationId}),'#/matters/'+id+'/applications?applicantId='+applicantId+'&applicationId='+applicationId);
    assert.equal(s.reviewHref(undefined),'#/matters?view=applications');
  `));
  test("date-only deadlines preserve calendar days across DST and filters", () => check(`
    assert.equal(s.dates.normalize('2026-02-30'), '');
    assert.equal(s.dates.addDays('2026-03-07', 2), '2026-03-09');
    const f = s.filtersFromQuery(new URLSearchParams('matterDeadline=7_days&matterSort=deadline'));
    const records = [
      { title: 'Tomorrow', deadlineDate: '2026-03-09', status: 'open' },
      { title: 'Today', deadlineDate: '2026-03-08', status: 'open' },
      { title: 'Old', deadlineDate: '2026-03-07', status: 'open' },
      { title: 'Later', deadlineDate: '2026-03-16', status: 'open' },
    ];
    assert.deepEqual(s.filterRecords(records, f, { today: '2026-03-08' }).map(x => x.title), ['Today', 'Tomorrow']);
    assert.equal(s.filterRecords(records, { ...f, deadline: 'overdue' }, { today: '2026-03-08' })[0].title, 'Old');
  `));
  test("URL filters and saved-view aliases retain search, sort and archive meaning", () => check(`
    const f = s.filtersFromQuery(new URLSearchParams('view=inquiries&q=contract&matterPractice=Business&matterSort=alphabetical&page=2'));
    assert.equal(f.view, 'applications'); assert.equal(f.page, 2);
    const records = [{ title: 'B contract', practiceArea: 'Business', applicantsCount: 1 }, { title: 'A contract', practiceArea: 'Business', applicantsCount: 1 }, { title: 'Contract', practiceArea: 'Family', applicantsCount: 1 }];
    assert.deepEqual(s.filterRecords(records, f).map(x => x.title), ['A contract', 'B contract']);
    const invalid = s.filtersFromQuery(new URLSearchParams('view=bad&matterSort=bad&page=-5'));
    assert.equal(invalid.view, 'active'); assert.equal(invalid.sort, 'recent'); assert.equal(invalid.page, 1);
  `));
  test("overlapping archive records deduplicate without rewriting applicant mirrors", () => check(`
    const current = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: 'Earlier', status: 'open', applicantsCount: 2 };
    const history = { ...current, title: 'Latest', archived: true };
    const all = s.mergeRecords([current], [history]);
    assert.equal(all.length, 1); assert.equal(all[0].title, 'Latest');
    const held = { ...current, status: 'paused', payoutFinalizedAt: '2026-09-01', payoutFinalizedType: 'partial_attorney', archived: false };
    assert.equal(s.bucket(s.mergeRecords([], [held])[0]), 'archived');
    assert.equal(held.archived, false);
    const apps = [{ caseId: current.id, paralegal: { id: 'p' } }];
    assert.equal(s.applicationDisagreements(apps, [current]).length, 1);
    assert.equal(current.applicantsCount, 2);
    assert.equal(s.eligibleApplications(apps, [history]).length, 0);
    assert.equal(s.eligibleApplications([{ jobId: 'unlinked' }], []).length, 1);
  `));
  test("unread reconciliation uses the unpaginated summary, never a partial thread sum", () => check(`
    const summary = { items: [{ caseId: 'a', unread: 2 }, { caseId: 'b', unread: 3 }] };
    const threads = { threads: [{ id: 'a', unread: 2 }], total: 2 };
    assert.equal(s.reconcileUnread({ count: 5 }, summary, threads).total, 5);
    assert.equal(s.reconcileUnread({ count: 4 }, summary, threads).total, null);
    assert.equal(s.reconcileUnread({ count: 5 }, summary, { ...threads, threads: [{ id: 'a', unread: 1 }] }).mismatch, true);
    assert.throws(() => s.reconcileUnread({}, summary, threads));
    assert.throws(() => s.reconcileUnread({ count: 5 }, summary, { total: 0, threads: [] }));
    assert.throws(() => s.reconcileUnread({ count: 0 }, summary, { total: 0, threads: [] }));
    assert.equal(s.reconcileUnread({ count: 0 }, { items: [] }, { total: 0, threads: [] }).total, 0);
  `));
  test("readiness preserves the existing profile evidence rules", () => check(`
    assert.equal(Boolean(s.profileComplete({})), false);
    assert.equal(Boolean(s.profileComplete({ practiceAreas: ['  '] })), false);
    for (const user of [{ onboarding: { attorneyProfileCompleted: true } }, { lawFirm: 'Firm' }, { practiceAreas: ['Business'] }, { bio: 'Biography' }]) assert.equal(Boolean(s.profileComplete(user)), true);
    assert.throws(() => s.profileComplete(null));
  `));
});
