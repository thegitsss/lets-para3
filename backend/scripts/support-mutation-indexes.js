const path = require('node:path');
const mongoose = require('mongoose');
const Mutation = require('../models/SupportMutation');
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require('../utils/mongooseOperationPolicy');
const required = Mutation.schema.indexes().filter(([, options]) => options.unique === true);

async function checkSupportMutationIndexes() {
  let indexes;
  try { indexes = await Mutation.collection.indexes(); }
  catch (error) { if (error.code === 26) return false; throw error; }
  return required.every(([key, options]) => indexes.some(index => index.unique === true
    && JSON.stringify(index.key) === JSON.stringify(key)
    && JSON.stringify(index.partialFilterExpression || null) === JSON.stringify(options.partialFilterExpression || null)));
}

async function ensureSupportMutationIndexes() {
  // Add the two declared constraints. Conflicting rows fail for review; no
  // records or unrelated indexes are deleted or silently repaired.
  for (const [key, options] of required) await Mutation.collection.createIndex(key, options);
  if (!await checkSupportMutationIndexes()) throw new Error('Assistant request indexes are unavailable.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(value => !['--check', '--apply'].includes(value))) throw new Error('Choose --check or --apply.');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  try {
    await mongoose.connect(requireMongoUri(process.env.MONGO_URI), { ...MONGO_OPERATION_OPTIONS, autoCreate: false, autoIndex: false });
    if (args[0] === '--apply') await ensureSupportMutationIndexes();
    if (!await checkSupportMutationIndexes()) throw new Error('Assistant request indexes are missing.');
    console.log('[support-mutations] Required request and owner uniqueness are ready.');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => {
  console.error('[support-mutations] Preflight failed. Review database access, declared indexes and conflicting records before enabling request recovery.');
  process.exitCode = 1;
});
module.exports = { checkSupportMutationIndexes, ensureSupportMutationIndexes };
