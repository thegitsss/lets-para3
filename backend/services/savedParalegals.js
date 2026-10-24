const { buildAuthenticatedProfilePhotoUrl } = require('../services/profilePhotoDelivery');
const Saved = require('../models/SavedParalegal');
const User = require('../models/User');
const Case = require('../models/Case');
const Job = require('../models/Job');
const Application = require('../models/Application');
const { isBlockedBetween } = require('../utils/blocks');
const { hasRequiredParalegalFieldsForPublic } = require('../utils/paralegalProfile');
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const fail = (status, code) => { throw Object.assign(new Error(code), { status, publicCode: code }); };
async function owner(req) {
  const id = req.user?.id;
  const expected = req.method === 'GET' ? req.query.expectedOwnerId : req.body.expectedOwnerId;
  if (!validId(id) || expected !== id || req.user.role !== 'attorney') fail(403, 'SAVED_PARALEGAL_ACCOUNT_CHANGED');
  const user = await User.findById(id).select('role status disabled deleted authVersion').lean();
  if (!user || user.role !== 'attorney' || user.status !== 'approved' || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0)) fail(403, 'SAVED_PARALEGAL_ACCOUNT_CHANGED');
  return id;
}
async function profile(attorneyId, paralegalId) {
  const value = await User.findOne({ _id: paralegalId, role: 'paralegal', status: 'approved', disabled: { $ne: true }, deleted: { $ne: true } }).select('firstName lastName location state practiceAreas availability bio skills resumeURL profilePhotoStatus pendingProfileImage profileImage avatarURL preferences updatedAt').lean();
  if (!value || await isBlockedBetween(attorneyId, paralegalId)) return null;
  if (value.preferences?.hideProfile || !hasRequiredParalegalFieldsForPublic(value)) {
    let related = await Case.exists({ $and: [{ $or: [{ attorney: attorneyId }, { attorneyId }] }, { $or: [{ paralegal: paralegalId }, { paralegalId }, { 'applicants.paralegalId': paralegalId }] }] });
    if (!related) {
      const jobs = await Job.find({ attorneyId }).select('_id').lean();
      related = jobs.length && await Application.exists({ paralegalId, jobId: { $in: jobs.map(job => job._id) } });
    }
    if (!related) return null;
  }
  return { avatarURL: value.profileImage || value.avatarURL ? buildAuthenticatedProfilePhotoUrl(value) : '', name: [value.firstName, value.lastName].filter(Boolean).join(' ') || 'Paralegal', location: value.location || value.state || '', practiceAreas: Array.isArray(value.practiceAreas) ? value.practiceAreas : [], availability: typeof value.availability === 'string' ? value.availability : '' };
}
async function read(req) {
  const attorneyId = await owner(req), paralegalId = req.params.paralegalId;
  if (!validId(paralegalId)) fail(400, 'SAVED_PARALEGAL_INVALID');
  const record = await Saved.findOne({ attorneyId, paralegalId }).lean();
  const available = Boolean(await profile(attorneyId, paralegalId));
  await owner(req);
  return { ownerId: attorneyId, paralegalId, saved: record?.saved === true, decided: Boolean(record), available };
}
async function write(req) {
  const attorneyId = await owner(req), paralegalId = req.params.paralegalId;
  if (!validId(paralegalId) || typeof req.body.saved !== 'boolean' || Object.keys(req.body).some(key => !['saved', 'expectedOwnerId'].includes(key))) fail(400, 'SAVED_PARALEGAL_INVALID');
  const filter = { attorneyId, paralegalId }, exists = await Saved.exists(filter);
  if ((req.body.saved || !exists) && !await profile(attorneyId, paralegalId)) fail(404, 'SAVED_PARALEGAL_UNAVAILABLE');
  await owner(req);
  try { await Saved.findOneAndUpdate(filter, { $set: { saved: req.body.saved } }, { upsert: true, runValidators: true }); }
  catch (error) { if (error.code !== 11000) throw error; await Saved.updateOne(filter, { $set: { saved: req.body.saved } }); }
  return { ownerId: attorneyId, paralegalId, saved: req.body.saved, decided: true };
}
async function list(req) {
  const attorneyId = await owner(req), rawPage = req.query.page || '1';
  if (!/^[1-9]\d{0,5}$/.test(rawPage) || Object.keys(req.query).some(key => !['expectedOwnerId', 'page'].includes(key))) fail(400, 'SAVED_PARALEGAL_INVALID');
  const page = Number(rawPage), filter = { attorneyId, saved: true }, limit = 20;
  const [records, total] = await Promise.all([Saved.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), Saved.countDocuments(filter)]);
  const items = await Promise.all(records.map(async record => ({ id: String(record.paralegalId), profile: await profile(attorneyId, record.paralegalId) })));
  await owner(req);
  return { ownerId: attorneyId, items, total, page, pages: Math.ceil(total / limit) };
}
module.exports = { read, write, list };
