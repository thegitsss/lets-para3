const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const Mutation = require('../models/SupportMutation');
const { runMutation } = require('../services/support/mutationService');
const { checkSupportMutationIndexes, ensureSupportMutationIndexes } = require('../scripts/support-mutation-indexes');
beforeAll(connect, 90000); afterAll(closeDatabase); beforeEach(clearDatabase);
afterEach(async () => { await clearDatabase(); await ensureSupportMutationIndexes(); });

test('read-only preflight detects a missing constraint and writes fail before accepting a request', async () => {
  await Mutation.collection.dropIndex('ownerId_1_active_1');
  expect(await checkSupportMutationIndexes()).toBe(false);
  await expect(runMutation({ conversationId: new mongoose.Types.ObjectId(), user: { _id: new mongoose.Types.ObjectId(), role: 'attorney' }, action: 'send', input: { text: 'Synthetic' } }, () => { throw Error('Unexpected request work'); })).rejects.toMatchObject({ code: 'SUPPORT_MUTATION_UNAVAILABLE' });
  expect(await Mutation.countDocuments()).toBe(0);
});
test('explicit preparation restores required constraints while preserving unrelated indexes', async () => {
  await Mutation.collection.createIndex({ phase: 1 }, { name: 'synthetic_preserved_phase' });
  await Mutation.collection.dropIndex('ownerId_1_active_1');
  await ensureSupportMutationIndexes(); expect(await checkSupportMutationIndexes()).toBe(true);
  expect((await Mutation.collection.indexes()).some(index => index.name === 'synthetic_preserved_phase')).toBe(true);
});
test('conflicting request records require review and are never silently merged or deleted', async () => {
  await Mutation.collection.dropIndex('ownerId_1_requestId_1');
  const record = { ownerId: new mongoose.Types.ObjectId(), conversationId: new mongoose.Types.ObjectId(), role: 'attorney', requestId: '12345678-1234-4234-8234-123456789012', action: 'send', fingerprint: 'synthetic', active: false };
  await Mutation.insertMany([record, record]);
  await expect(ensureSupportMutationIndexes()).rejects.toMatchObject({ code: 11000 });
  expect(await Mutation.countDocuments()).toBe(2); expect(await checkSupportMutationIndexes()).toBe(false);
});
