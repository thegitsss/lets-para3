const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), jwt = require('jsonwebtoken');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_revision_summary'; process.env.S3_BUCKET = 'synthetic-revision-summary'; process.env.S3_MALWARE_SCAN_REQUIRED = 'false';
const mockStorage = jest.fn(async command => { if (['PutObjectCommand', 'DeleteObjectCommand'].includes(command.constructor.name)) return { ETag: 'synthetic' }; throw Error('Unconfigured synthetic revision storage operation'); });
const mockStripe = { paymentIntents: { retrieve: jest.fn() }, transfers: { create: jest.fn() }, accounts: { retrieve: jest.fn() }, isTransferablePaymentIntent: jest.fn(), sanitizeStripeError: jest.fn((_error, fallback) => fallback), stripeIdempotencyKey: jest.fn((kind, ...values) => `${kind}:${values.join(':')}`), caseTransferGroup: jest.fn(value => `case_${value}`) };
jest.mock('../utils/s3Client', () => ({ createS3Client: () => ({ send: mockStorage }) }));
jest.mock('../utils/stripe', () => mockStripe);
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const Case = require('../models/Case'), CaseFile = require('../models/CaseFile'), User = require('../models/User'), Payout = require('../models/Payout'), PaymentOperation = require('../models/PaymentOperation'), PlatformIncome = require('../models/PlatformIncome'), AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService'), { generateCsrfToken, respondToCsrfError } = require('../utils/csrf');
const app = express(); app.use(cookieParser(), express.json()); app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) })); app.use('/api/cases', require('../routes/cases')); app.use('/api/uploads', require('../routes/uploads'));
app.use((error, _req, res, _next) => { if (!respondToCsrfError(error, res)) res.status(error.statusCode || error.status || 500).json({ error: error.message, code: error.publicCode || error.code }); });
let attorney, para, replacement, outsider, matter, previousCsrf;
beforeAll(async () => { previousCsrf = process.env.ENABLE_CSRF; process.env.ENABLE_CSRF = 'true'; await connect(); }, 60000);
afterAll(async () => { if (previousCsrf === undefined) delete process.env.ENABLE_CSRF; else process.env.ENABLE_CSRF = previousCsrf; await closeDatabase(); });
async function actor(role) {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Revision summary', email: `${role}-${crypto.randomUUID()}@revision-summary.test`, password: 'Synthetic revision summary password!', role, status: 'approved', emailVerified: true, ...(role === 'paralegal' ? { stripeAccountId: `acct_synthetic_${crypto.randomUUID().replaceAll('-', '')}`, stripeOnboarded: true, stripePayoutsEnabled: true } : {}) });
  const session = await createAuthSession(user, { headers: { 'user-agent': 'Actual revision summary API' }, ip: '192.0.2.22' });
  const signed = `token=${jwt.sign({ id: String(user._id), role, status: user.status, sid: session.sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const csrf = await request(app).get('/api/csrf').set('Cookie', signed); expect(csrf.status).toBe(200);
  return { id: String(user._id), cookie: [signed, ...(csrf.headers['set-cookie'] || []).map(value => value.split(';')[0])].join('; '), csrf: csrf.body.csrfToken };
}
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); attorney = await actor('attorney'); para = await actor('paralegal'); replacement = await actor('paralegal'); outsider = await actor('paralegal');
  matter = await Case.create({ title: 'Actual revision summary', details: 'Keep current review and retained revision history consistent.', attorney: attorney.id, attorneyId: attorney.id, paralegal: para.id, paralegalId: para.id, status: 'in progress', hiredAt: new Date(), tasksLocked: true, tasks: [{ title: 'Reviewed work', completed: true }], escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_revision_summary', totalAmount: 40000, lockedTotalAmount: 40000, currency: 'usd' });
});
const cookie = person => person.cookie;
async function review(person = attorney) {
  const response = await request(app).get(`/api/cases/${matter._id}/completion-review`).query({ expectedOwnerId: person.id }).set('Cookie', cookie(person));
  return { status: response.status, body: response.body };
}
function providerCalls() { return { storage: mockStorage.mock.calls.map(([command]) => command.constructor.name), paymentIntents: mockStripe.paymentIntents.retrieve.mock.calls, transfers: mockStripe.transfers.create.mock.calls, accounts: mockStripe.accounts.retrieve.mock.calls }; }
async function file(changes = {}) {
  return CaseFile.create({ caseId: matter._id, userId: para.id, uploadedByRole: 'paralegal', originalName: 'Synthetic revision.pdf', storageKey: `cases/${matter._id}/documents/synthetic-${crypto.randomUUID()}.pdf`, mimeType: 'application/pdf', size: 32, version: 1, status: 'attorney_revision', revisionRequestedAt: new Date('2026-09-30T12:00:00.000Z'), securityStatus: 'not_required', ...changes });
}
async function responseTo(source, changes = {}) {
  return file({ userId: source.userId, status: 'approved', approvedAt: new Date(), version: Number(source.version) + 1, revisionOfFileId: source._id, revisionOfVersion: source.version, revisionRequestAt: source.revisionRequestedAt, revisionRequestedAt: null, ...changes });
}
async function snapshot() {
  return { case: await Case.collection.findOne({ _id: matter._id }), files: await CaseFile.collection.find({}).sort({ _id: 1 }).toArray(), payouts: await Payout.find({ caseId: matter._id }).lean(), operations: await PaymentOperation.find({ caseId: matter._id }).lean(), income: await PlatformIncome.find({ caseId: matter._id }).lean(), audit: await AuditLog.find({ targetId: matter._id }).select('actor actorRole targetType targetId action meta createdAt').lean() };
}
async function evidence(record) {
  if (!process.env.LPC_REVISION_SUMMARY_EVIDENCE) return;
  const title = expect.getState().currentTestName;
  await fs.mkdir(process.env.LPC_REVISION_SUMMARY_EVIDENCE, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(process.env.LPC_REVISION_SUMMARY_EVIDENCE, crypto.createHash('sha256').update(title).digest('hex') + '.json'), JSON.stringify({ title, ...record, after: await snapshot(), actualParalegalIds: { source: para.id, replacement: replacement.id, unrelated: outsider.id }, providerCalls: providerCalls() }, null, 2), { mode: 0o600 });
}
function eligibility(dto) { const { revision, documents, ...rest } = dto; return rest; }
async function readWithoutWrites(record) {
  record.before = await snapshot(); const calls = JSON.stringify(providerCalls()); const result = await review(); record.response = result;
  expect(result.status).toBe(200); expect(await snapshot()).toEqual(record.before); expect(JSON.stringify(providerCalls())).toBe(calls); expect(JSON.stringify(result.body)).not.toMatch(/storageKey|synthetic-.*\.pdf|token=|sessionId/); return result.body;
}
test('an actual approved explicit response resolves only the current revision count while preserving raw original history and financial eligibility', async () => {
  const record = {};
  try {
    const source = await file(), response = await responseTo(source, { status: 'pending_review', approvedAt: null, securityStatus: 'pending' });
    const pending = await review(); expect(pending.status).toBe(200);
    await CaseFile.collection.updateOne({ _id: response._id }, { $set: { status: 'approved', approvedAt: new Date() } });
    const dto = await readWithoutWrites(record);
    expect(dto.documents).toMatchObject({ total: 2, awaitingReview: 0, revisions: 0, approved: 1, securityPending: 1 }); expect(eligibility(dto)).toEqual(eligibility(pending.body));
    expect(record.before.files.find(value => String(value._id) === String(source._id)).status).toBe('attorney_revision');
  } finally { await evidence(record); }
});
test('a pending linked response leaves the actual original revision request unresolved', async () => {
  const record = {};
  try { const source = await file(); await responseTo(source, { status: 'pending_review', approvedAt: null }); const dto = await readWithoutWrites(record); expect(dto.documents).toMatchObject({ total: 2, awaitingReview: 1, revisions: 1, approved: 0 }); }
  finally { await evidence(record); }
});
test('an actual approved deeper response resolves both retained revision requests without rewriting either original version', async () => {
  const record = {};
  try {
    const source = await file(), middle = await responseTo(source, { status: 'attorney_revision', approvedAt: null, revisionRequestedAt: new Date('2026-10-01T12:00:00.000Z') }); await responseTo(middle);
    const dto = await readWithoutWrites(record); expect(dto.documents).toMatchObject({ total: 3, awaitingReview: 0, revisions: 0, approved: 1 }); expect(record.before.files.filter(value => value.status === 'attorney_revision')).toHaveLength(2);
  } finally { await evidence(record); }
});
test.each(['wrong-source', 'cross-Matter', 'other-role', 'wrong-source-version', 'nonadvanced-version', 'old-request', 'unverified-response-version'])('actual %s metadata cannot resolve a different or unverified revision request', async variation => {
  const record = { variation };
  try {
    const source = await file(), changes = {};
    if (variation === 'wrong-source') changes.revisionOfFileId = new (require('mongoose').Types.ObjectId)();
    if (variation === 'cross-Matter') { const otherMatter = await Case.create({ title: 'Separate synthetic Matter', details: 'Keep its revisions separate.', attorney: attorney.id, attorneyId: attorney.id, status: 'open' }); changes.caseId = otherMatter._id; }
    if (variation === 'other-role') { changes.uploadedByRole = 'attorney'; changes.userId = attorney.id; }
    if (variation === 'wrong-source-version') changes.revisionOfVersion = 2;
    if (variation === 'nonadvanced-version') changes.version = 1;
    if (variation === 'old-request') changes.revisionRequestAt = new Date('2026-09-29T12:00:00.000Z');
    const response = await responseTo(source, changes);
    if (variation === 'unverified-response-version') { const changed = await CaseFile.collection.updateOne({ _id: response._id }, { $set: { version: 'unverified' } }); expect(changed.modifiedCount).toBe(1); record.explicitMalformedRawRecord = true; }
    const dto = await readWithoutWrites(record); expect(dto.documents.revisions).toBe(1);
  } finally { await evidence(record); }
});
test('actual history-only metadata changes invalidate reviewed revision while leaving counts and financial eligibility unchanged', async () => {
  const record = {};
  try {
    const source = await file(); await responseTo(source); const first = await review(); expect(first.status).toBe(200);
    const result = await CaseFile.collection.updateOne({ _id: source._id }, { $push: { history: { storageKey: 'synthetic-retained-history-key', replacedAt: new Date() } } }); expect(result.modifiedCount).toBe(1);
    const dto = await readWithoutWrites(record); expect(dto.revision).not.toBe(first.body.revision); expect(dto.documents).toEqual(first.body.documents); expect(eligibility(dto)).toEqual(eligibility(first.body)); record.firstReview = first;
  } finally { await evidence(record); }
});
test('actual legacy requests without recorded dates preserve explicit valid version linkage rather than inventing a new timestamp policy', async () => {
  const record = {};
  try { const source = await file({ revisionRequestedAt: null }); await responseTo(source, { revisionRequestAt: null }); const dto = await readWithoutWrites(record); expect(dto.documents.revisions).toBe(0); record.legacyNullDateClassification = 'Existing upload route compares empty request date with empty stored date; valid explicit version/source links remain permitted.'; }
  finally { await evidence(record); }
});
test('an actual current replacement can revise a visible legacy prior-Paralegal source while an unrelated Paralegal upload is denied without a CaseFile change', async () => {
  const record = {};
  try {
    const source = await file(); await CaseFile.collection.updateOne({ _id: source._id }, { $set: { createdAt: null } });
    await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegal: replacement.id, paralegalId: replacement.id, withdrawnParalegalId: para.id, hiredAt: new Date() } });
    expect(String(source.userId)).not.toBe(replacement.id);
    const submit = async person => {
      const response = await request(app).post(`/api/uploads/case/${matter._id}?presentation=matter`).set('Cookie', cookie(person)).set('X-CSRF-Token', person.csrf).field('revisionOfFileId', String(source._id)).field('revisionRequestAt', source.revisionRequestedAt.toISOString()).field('clientUploadId', crypto.randomUUID()).attach('file', Buffer.from('%PDF-1.4\nSynthetic revised work\n%%EOF'), { filename: 'Legacy response.pdf', contentType: 'application/pdf' });
      return { status: response.status, body: response.body };
    };
    const beforeDenial = await snapshot(); record.unrelatedUpload = await submit(outsider); expect(record.unrelatedUpload.status).toBe(403); expect(await snapshot()).toEqual(beforeDenial);
    record.permittedReplacementUpload = await submit(replacement); expect(record.permittedReplacementUpload.status).toBe(201);
    const stored = await CaseFile.findOne({ caseId: matter._id, revisionOfFileId: source._id }).lean(); expect(String(stored.userId)).toBe(replacement.id); expect(stored.revisionOfVersion).toBe(source.version); expect(stored.revisionRequestAt).toEqual(source.revisionRequestedAt);
    // Arrange an actual retained approval for the read-only summary comparison;
    // native owner review/approval is separately conserved in the browser body.
    await CaseFile.collection.updateOne({ _id: stored._id }, { $set: { status: 'approved', approvedAt: new Date() } });
    const dto = await readWithoutWrites(record); expect(dto.documents).toMatchObject({ total: 2, awaitingReview: 0, revisions: 0, approved: 1 });
    record.actorBoundary = { sourceUploaderId: String(source.userId), permittedReplacementUploaderId: String(stored.userId), unrelatedId: outsider.id };
  } finally { await evidence(record); }
});

test.each(['fractional-response', 'infinite-response', 'unsafe-response', 'fractional-source', 'unsafe-source', 'fractional-reference', 'valid-numeric-strings', 'missing-source-legacy-fallback', 'zero-source-legacy-fallback'])('actual revision-version boundary %s preserves truthful summary, raw history and payment eligibility', async variation => {
  const record = { variation, rawVersionBoundaryArrangement: true };
  try {
    const source = await file(), response = await responseTo(source), sourceChanges = {}, responseChanges = {};
    if (variation === 'fractional-response') responseChanges.version = 2.5;
    if (variation === 'infinite-response') responseChanges.version = Infinity;
    if (variation === 'unsafe-response') responseChanges.version = Number.MAX_SAFE_INTEGER + 1;
    if (variation === 'fractional-source') { sourceChanges.version = 1.5; responseChanges.revisionOfVersion = 1.5; }
    if (variation === 'unsafe-source') { sourceChanges.version = Number.MAX_SAFE_INTEGER + 1; responseChanges.revisionOfVersion = Number.MAX_SAFE_INTEGER + 1; responseChanges.version = Number.MAX_SAFE_INTEGER + 3; }
    if (variation === 'fractional-reference') responseChanges.revisionOfVersion = 1.5;
    if (variation === 'valid-numeric-strings') { sourceChanges.version = '1'; responseChanges.version = '2'; responseChanges.revisionOfVersion = '1'; }
    if (variation === 'zero-source-legacy-fallback') sourceChanges.version = 0;
    if (variation === 'missing-source-legacy-fallback') expect((await CaseFile.collection.updateOne({ _id: source._id }, { $unset: { version: '' } })).modifiedCount).toBe(1);
    if (Object.keys(sourceChanges).length) expect((await CaseFile.collection.updateOne({ _id: source._id }, { $set: sourceChanges })).modifiedCount).toBe(1);
    if (Object.keys(responseChanges).length) expect((await CaseFile.collection.updateOne({ _id: response._id }, { $set: responseChanges })).modifiedCount).toBe(1);
    // JSON serializes Infinity as null. Preserve independently read BSON value
    // type/text alongside the complete raw export, rather than hiding that fact.
    record.actualVersionReadbacks = (await CaseFile.collection.find({ caseId: matter._id }).toArray()).map(row => ({ id: String(row._id), version: { type: typeof row.version, text: String(row.version) }, referenceVersion: { type: typeof row.revisionOfVersion, text: String(row.revisionOfVersion) } }));
    const dto = await readWithoutWrites(record), resolved = ['valid-numeric-strings', 'missing-source-legacy-fallback', 'zero-source-legacy-fallback'].includes(variation);
    expect(dto.documents).toMatchObject({ total: 2, approved: 1, awaitingReview: 0, revisions: resolved ? 0 : 1, resolvedRevisions: resolved ? 1 : 0 });
    expect(dto).toMatchObject({ canComplete: true, grossCents: 40000, feeCents: 7200, payoutCents: 32800 });
  } finally { await evidence(record); }
});
