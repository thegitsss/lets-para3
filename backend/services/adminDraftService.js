const mongoose = require('mongoose');
const Draft = require('../models/AdminDraft');
const User = require('../models/User');
const Ticket = require('../models/SupportTicket');
const { encryptString, decryptString } = require('../utils/dataEncryption');
const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };
async function keyFor({ owner, kind, recordId }) {
  if (!mongoose.isValidObjectId(owner) || !mongoose.isValidObjectId(recordId) || !['inquiry','account'].includes(kind)) fail('Invalid draft record.',400);
  const model = kind === 'inquiry' ? Ticket : User;
  if (!await model.exists({ _id: recordId })) fail('The draft’s record was not found.',404);
  return { owner, kind, recordId };
}
function present(doc) {
  const content = doc && doc.expiresAt > new Date() ? JSON.parse(decryptString(doc.content)) : {};
  return { text: '', note: '', requestId: '', uncertain: false, ...content, revision: doc?.revision || 0, updatedAt: doc?.updatedAt || null };
}
async function loadDraft(args) {
  return present(await Draft.findOne(await keyFor(args)).lean());
}
async function saveDraft(args, input = {}) {
  const key = await keyFor(args);
  const { text = '', note = '', requestId = '', uncertain = false, revision } = input;
  if (typeof text !== 'string' || text.length > 12000 || typeof note !== 'string' || note.length > (args.kind === 'account' ? 4000 : 8000)) fail('The draft is too long or invalid.',400);
  if (typeof requestId !== 'string' || (requestId && !/^[a-f0-9-]{36}$/i.test(requestId)) || typeof uncertain !== 'boolean' || !Number.isSafeInteger(revision) || revision < 0) fail('Invalid draft version.',400);
  const content = encryptString(JSON.stringify({ text, note, requestId, uncertain }));
  let saved;
  try {
    saved = await Draft.findOneAndUpdate({ ...key, revision }, {
      $set: { content, expiresAt: new Date(Date.now()+30*86400000) },
      $inc: { revision: 1 },
    }, { upsert: revision === 0, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: false }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  if (!saved) fail('This draft changed in another tab. Your text is still here; copy it before reloading the page.',409);
  return present(saved);
}
module.exports = { loadDraft, saveDraft };
