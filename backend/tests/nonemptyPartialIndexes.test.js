const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
mongoose.set('autoCreate', false); mongoose.set('autoIndex', false);
const DirectorOutreachEvent = require('../models/DirectorOutreachEvent');
const SalesAccount = require('../models/SalesAccount');
let mongo;
beforeAll(async () => { mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', launchTimeout: 60000 } }); await mongoose.connect(mongo.getUri('nonempty_indexes_isolated'), { autoCreate: false, autoIndex: false }); }, 90000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop({ doCleanup: true, force: true }); });
const specifications = [
  { Model: DirectorOutreachEvent, field: 'providerMessageId', key: { directorUserId: 1, providerMessageId: 1, eventType: 1 }, base: () => ({ directorUserId: new mongoose.Types.ObjectId(), eventType: 'reply_received' }) },
  { Model: SalesAccount, field: 'sourceFingerprint', key: { sourceFingerprint: 1 }, base: () => ({}) },
];
test.each(specifications)('$Model.modelName creates its declared indexes and enforces only intended nonempty-key uniqueness', async ({ Model, field, key, base }) => {
  await Model.createCollection();
  await Model.createIndexes();
  const indexes = await Model.collection.listIndexes().toArray();
  const index = indexes.find(item => JSON.stringify(item.key) === JSON.stringify(key));
  expect(index).toMatchObject({ unique: true, partialFilterExpression: { [field]: { $type: 'string', $gt: '' } } });
  const identity = base();
  const row = value => ({ ...identity, ...(value === undefined ? {} : { [field]: value }) });
  for (const value of [undefined, null, '']) {
    await Model.collection.insertOne(row(value)); await Model.collection.insertOne(row(value));
  }
  for (const value of ['ordinary-key', 'évidence-日本語', 'e\u0301vidence', ' ', '\u0000']) {
    await Model.collection.insertOne(row(value));
    await expect(Model.collection.insertOne(row(value))).rejects.toMatchObject({ code: 11000 });
  }
  // Binary scalar semantics remain intact: no implicit case or Unicode normalization.
  await Model.collection.insertOne(row('Évidence-日本語'));
  await Model.collection.insertOne(row('évidence'));
  if (Model === DirectorOutreachEvent) {
    await Model.collection.insertOne({ ...row('ordinary-key'), directorUserId: new mongoose.Types.ObjectId() });
    await Model.collection.insertOne({ ...row('ordinary-key'), eventType: 'outreach_sent' });
  }
  expect(await Model.collection.countDocuments({ [field]: { $exists: false } })).toBe(2);
  expect(await Model.collection.countDocuments({ [field]: { $type: 'null' } })).toBe(2);
  expect(await Model.collection.countDocuments({ [field]: '' })).toBe(2);
});

const { auditTarget, TARGETS } = require('../scripts/check-nonempty-unique-indexes');
test.each(TARGETS)('$collection preflight reports duplicates, arrays and non-string values without writes', async target => {
  const database = mongoose.connection.client.db(`preflight_${target.collection}`), collection = database.collection(target.collection);
  const base = target.collection === 'director_outreach_events' ? { directorUserId: new mongoose.Types.ObjectId(), eventType: 'reply_received' } : {};
  const row = value => ({ ...base, ...(value === undefined ? {} : { [target.field]: value }) });
  await collection.insertMany([row(undefined), row(null), row(''), row('duplicate'), row('duplicate'), row(['array-key']), row(42), row(false), row({ nested: 'value' }), row('日本語')]);
  const before = await collection.find({}).toArray(), beforeIndexes = await collection.listIndexes().toArray();
  const report = await auditTarget(database, target);
  expect(report).toMatchObject({ exists: true, indexStatus: 'missing', documentCount: 10, duplicateGroups: 1, duplicateRows: 2, requiresReview: true });
  expect(report.anomalies).toEqual(expect.arrayContaining(['array', 'int', 'bool', 'object'].map(type => ({ field: target.field, type, count: 1 }))));
  expect(JSON.stringify(report)).not.toContain('duplicate"');
  expect(await collection.find({}).toArray()).toEqual(before); expect(await collection.listIndexes().toArray()).toEqual(beforeIndexes);
});

test.each(TARGETS)('$collection preflight preserves and reports an incompatible existing index', async target => {
  const database = mongoose.connection.client.db(`conflict_${target.collection}`), collection = database.collection(target.collection);
  await collection.createIndex(target.key, { sparse: true });
  const indexes = await collection.listIndexes().toArray();
  const report = await auditTarget(database, target);
  expect(report).toMatchObject({ indexStatus: 'conflict', requiresReview: true, action: 'review_existing_data_and_indexes' });
  expect(await collection.listIndexes().toArray()).toEqual(indexes);
});

test.each(specifications)('$Model.modelName scalar index admits excluded legacy types but preflight flags them and observes string-array membership', async ({ Model, field, key, base }) => {
  await Model.createCollection(); await Model.createIndexes();
  const identity = base(), row = value => ({ ...identity, [field]: value });
  for (const value of [42, false]) { await Model.collection.insertOne(row(value)); await Model.collection.insertOne(row(value)); }
  // Mongo's query $type sees string members in arrays. The existing String
  // schema rejects these; raw legacy/imported anomalies must be reviewed.
  await Model.collection.insertOne(row(['array-member']));
  await expect(Model.collection.insertOne(row('array-member'))).rejects.toMatchObject({ code: 11000 });
  const target = TARGETS.find(item => item.collection === Model.collection.name);
  const report = await auditTarget(mongoose.connection.db, target);
  expect(report.indexStatus).toBe('present'); expect(report.requiresReview).toBe(true);
  expect(report.anomalies).toEqual(expect.arrayContaining([{ field, type: 'array', count: 1 }, { field, type: 'int', count: 2 }, { field, type: 'bool', count: 2 }]));
  const indexes = await Model.collection.listIndexes().toArray(); expect(indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key)).unique).toBe(true);
});

test('missing collections remain missing after read-only preflight', async () => {
  const db = mongoose.connection.client.db('absent_preflight');
  for (const target of TARGETS) expect(await auditTarget(db, target)).toMatchObject({ exists: false, indexStatus: 'missing', requiresReview: false });
  expect(await db.listCollections().toArray()).toEqual([]);
});

test.each(TARGETS)('$collection preflight recognizes a compatible index and clean scalar data', async target => {
  const database = mongoose.connection.client.db(`compatible_${target.collection}`), collection = database.collection(target.collection);
  await collection.createIndex(target.key, { unique: true, partialFilterExpression: { [target.field]: { $type: 'string', $gt: '' } } });
  const base = target.requiredKeyTypes.directorUserId ? { directorUserId: new mongoose.Types.ObjectId(), eventType: 'reply_received' } : {};
  await collection.insertMany([base, { ...base, [target.field]: null }, { ...base, [target.field]: '' }, { ...base, [target.field]: '日本語' }]);
  expect(await auditTarget(database, target)).toMatchObject({ indexStatus: 'present', requiresReview: false, duplicateGroups: 0, anomalies: [], action: 'verify_deployed_definition' });
});

test('preflight never reports an unavailable source as clean', async () => {
  const failure = new Error('synthetic index source failure');
  const db = { listCollections: () => ({ next: async () => { throw failure; } }) };
  await expect(auditTarget(db, TARGETS[0])).rejects.toBe(failure);
});

test.each(TARGETS.flatMap(target => ['same-key-other-name', 'expected-name-other-key'].map(collision => ({ target, collision }))))('$target.collection preflight flags $collision without changing either index', async ({ target, collision }) => {
  const db = mongoose.connection.client.db(`name_${collision.replaceAll('-', '_')}_${target.collection}`), collection = db.collection(target.collection);
  const expectedName = Object.entries(target.key).map(([field, order]) => `${field}_${order}`).join('_');
  const intended = { name: expectedName, unique: true, partialFilterExpression: { [target.field]: { $type: 'string', $gt: '' } } };
  if (collision === 'same-key-other-name') await collection.createIndex(target.key, { ...intended, name: 'retained_alternate_name' });
  else await collection.createIndex({ retainedDifferentKey: 1 }, { name: expectedName });
  const before = await collection.listIndexes().toArray();
  const buildResult = await collection.createIndex(target.key, intended).then(() => ({ succeeded: true }), error => ({ code: error.code, codeName: error.codeName }));
  expect([85, 86]).toContain(buildResult.code);
  const report = await auditTarget(db, target);
  expect(report).toMatchObject({ indexStatus: 'conflict', requiresReview: true, action: 'review_existing_data_and_indexes' });
  expect(await collection.listIndexes().toArray()).toEqual(before);
  expect(await collection.countDocuments()).toBe(0);
});
