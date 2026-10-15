const { Types } = require('mongoose');

const id = value => String(value?._id || value || '').toLowerCase();
const validId = value => /^[a-f0-9]{24}$/.test(id(value));
const refs = value => [new Types.ObjectId(id(value)), id(value), id(value).toUpperCase()];
const invalid = () => { throw Object.assign(new Error('Application identities need verification before these records can be used.'), { status: 409, publicCode: 'APPLICATION_REVIEW_SOURCE_INVALID' }); };
const normalizedId = value => ({ $toLower: { $convert: { input: value, to: 'string', onError: '', onNull: '' } } });

// Keep physical BSON identities for writes; compare logical IDs only at joins.
// Never choose one of multiple raw records representing the same logical ID.
async function uniqueRecords(Model, query, projection, session) {
  const records = await Model.collection.find(query, { projection, session, maxTimeMS: 15000 }).sort({ _id: 1 }).toArray();
  const seen = new Set();
  for (const record of records) {
    const key = id(record._id);
    if (!validId(key) || seen.has(key)) invalid();
    seen.add(key);
  }
  return records;
}
async function one(Model, value, projection, session) {
  if (!validId(value)) invalid();
  return (await uniqueRecords(Model, { _id: { $in: refs(value) } }, projection, session))[0] || null;
}
module.exports = { id, validId, refs, invalid, normalizedId, uniqueRecords, one };
