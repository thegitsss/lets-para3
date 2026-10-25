const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { ensureModelIndexes, equivalentIndex } = require('../scripts/admin-communications-indexes');
const schema = new mongoose.Schema({ caseId: mongoose.Schema.Types.ObjectId, createdAt: Date, text: String });
schema.index({ caseId: 1, createdAt: -1, _id: -1 });
const Model = mongoose.model('PredeployIndexCompatibility', schema);
beforeAll(connect); afterAll(closeDatabase); beforeEach(clearDatabase);
test('preserves a production-named equivalent index and every stored record across repeated preparation', async () => {
  const key = { caseId: 1, createdAt: -1, _id: -1 };
  await Model.collection.dropIndex('caseId_1_createdAt_-1__id_-1');
  await Model.collection.createIndex(key, { name: 'message_case_stable_page' });
  const value = { _id: new mongoose.Types.ObjectId(), caseId: new mongoose.Types.ObjectId(), createdAt: new Date(), text: 'Preserved synthetic message' };
  await Model.collection.insertOne(value);
  await ensureModelIndexes(Model); await ensureModelIndexes(Model);
  expect(await Model.collection.findOne({ _id: value._id })).toEqual(value);
  const indexes = await Model.collection.indexes();
  expect(indexes.filter(index => JSON.stringify(index.key) === JSON.stringify(key)).map(index => index.name)).toEqual(['message_case_stable_page']);
});
test('does not mistake weaker uniqueness, partial coverage or TTL for equivalent protection', () => {
  const key = { userId: 1 };
  expect(equivalentIndex({ key }, key, { unique: true })).toBe(false);
  expect(equivalentIndex({ key, unique: true, partialFilterExpression: { enabled: true } }, key, { unique: true })).toBe(false);
  expect(equivalentIndex({ key, expireAfterSeconds: 60 }, key, { expireAfterSeconds: 600 })).toBe(false);
  expect(equivalentIndex({ key, name: 'old_name', unique: true }, key, { name: 'new_name', unique: true })).toBe(true);
});
