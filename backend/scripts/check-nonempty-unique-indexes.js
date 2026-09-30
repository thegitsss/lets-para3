// Read-only preflight. This script never creates, drops, synchronizes or repairs indexes/data.
const { MongoClient } = require('mongoose').mongo;
const TARGETS = Object.freeze([
  { collection: 'director_outreach_events', field: 'providerMessageId', name: 'directorUserId_1_providerMessageId_1_eventType_1', key: { directorUserId: 1, providerMessageId: 1, eventType: 1 }, requiredKeyTypes: { directorUserId: 'objectId', eventType: 'string' } },
  { collection: 'sales_accounts', field: 'sourceFingerprint', name: 'sourceFingerprint_1', key: { sourceFingerprint: 1 }, requiredKeyTypes: {} },
]);
const MAX_TIME_MS = 10000;
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function intendedPartial(index, field) {
  const partial = index.partialFilterExpression;
  return partial && Object.keys(partial).length === 1 && partial[field]?.$type === 'string' && partial[field]?.$gt === '' && Object.keys(partial[field]).length === 2;
}
async function auditTarget(db, target) {
  const { collection: name, field, key, requiredKeyTypes } = target;
  const metadata = await db.listCollections({ name }, { nameOnly: false, maxTimeMS: MAX_TIME_MS }).next();
  if (!metadata) return { collection: name, exists: false, indexStatus: 'missing', documentCount: 0, duplicateGroups: 0, duplicateRows: 0, valueTypes: [], anomalies: [], indexes: [], requiresReview: false, action: 'create_collection_and_declared_indexes' };
  const collection = db.collection(name);
  const indexes = await collection.listIndexes({ maxTimeMS: MAX_TIME_MS }).toArray();
  // Both key-equivalent indexes under a different name and a reused expected
  // name with another key can prevent the declared createIndexes operation.
  const candidates = indexes.filter(index => equal(index.key, key) || index.name === target.name);
  const compatible = candidates.filter(index => index.name === target.name && equal(index.key, key) && index.unique === true && intendedPartial(index, field) && (!index.collation || index.collation.locale === 'simple'));
  const indexStatus = compatible.length === 1 && candidates.length === 1 ? 'present' : candidates.length ? 'conflict' : 'missing';
  const valueTypes = await collection.aggregate([
    { $group: { _id: { $type: `$${field}` }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ], { maxTimeMS: MAX_TIME_MS, allowDiskUse: false }).toArray();
  const anomalies = valueTypes.filter(row => !['string', 'null', 'missing'].includes(row._id)).map(row => ({ field, type: row._id, count: row.count }));
  for (const [keyField, type] of Object.entries(requiredKeyTypes)) {
    const invalid = await collection.aggregate([
      { $group: { _id: { $type: `$${keyField}` }, count: { $sum: 1 } } },
      { $match: { _id: { $ne: type } } },
      { $sort: { _id: 1 } },
    ], { maxTimeMS: MAX_TIME_MS, allowDiskUse: false }).toArray();
    anomalies.push(...invalid.map(row => ({ field: keyField, type: row._id, count: row.count })));
  }
  // $expr/$type deliberately inspects the stored top-level type. Query $type can
  // also match an array containing strings; arrays require review, not scalar normalization.
  const duplicates = await collection.aggregate([
    { $match: { $expr: { $and: [{ $eq: [{ $type: `$${field}` }, 'string'] }, { $gt: [`$${field}`, ''] }] } } },
    { $group: { _id: Object.fromEntries(Object.keys(key).map(part => [part, `$${part}`])), count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $group: { _id: null, groups: { $sum: 1 }, rows: { $sum: '$count' } } },
  ], { maxTimeMS: MAX_TIME_MS, allowDiskUse: false, collation: { locale: 'simple' } }).toArray();
  const duplicateGroups = duplicates[0]?.groups || 0, duplicateRows = duplicates[0]?.rows || 0;
  const collectionCollation = metadata.options?.collation || null;
  const requiresReview = anomalies.length > 0 || duplicateGroups > 0 || indexStatus === 'conflict' || Boolean(collectionCollation && collectionCollation.locale !== 'simple');
  return {
    collection: name, exists: true, indexStatus, documentCount: valueTypes.reduce((sum, row) => sum + row.count, 0),
    duplicateGroups, duplicateRows, valueTypes: valueTypes.map(row => ({ type: row._id, count: row.count })), anomalies, collectionCollation,
    indexes: indexes.map(index => ({ name: index.name, key: index.key, unique: index.unique === true, partialFilterExpression: index.partialFilterExpression || null, collation: index.collation || null })),
    requiresReview, action: requiresReview ? 'review_existing_data_and_indexes' : indexStatus === 'present' ? 'verify_deployed_definition' : 'create_declared_index',
  };
}
async function auditNonemptyUniqueIndexes(db) {
  const collections = [];
  for (const target of TARGETS) collections.push(await auditTarget(db, target));
  return { readOnly: true, checkedAt: new Date().toISOString(), requiresReview: collections.some(item => item.requiresReview), collections };
}
async function main() {
  const uri = process.env.LPC_INDEX_AUDIT_URI;
  if (!uri || !/^mongodb(?:\+srv)?:\/\/[^/]+\/[^?/#]+(?:[?#]|$)/i.test(uri)) throw Object.assign(new Error('Set LPC_INDEX_AUDIT_URI with an explicit database; no environment file or default database is loaded.'), { codeName: 'INDEX_PREFLIGHT_TARGET_REQUIRED' });
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, appName: 'lpc-read-only-index-preflight' });
  try { await client.connect(); const result = await auditNonemptyUniqueIndexes(client.db()); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); if (result.requiresReview) process.exitCode = 2; }
  finally { await client.close(); }
}
if (require.main === module) main().catch(error => { process.stderr.write(`Index preflight unavailable (${error.codeName || error.name || 'error'}). No changes were made.\n`); process.exitCode = 1; });
module.exports = { TARGETS, auditTarget, auditNonemptyUniqueIndexes };
