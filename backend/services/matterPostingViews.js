const View = require('../models/MatterPostingView');
const Job = require('../models/Job');
const { iterateOpenListings } = require('./openMatterDiscovery');
const { openMatter } = require('./accountApplicationProjections');
const id = value => String(value?._id || value || '');
async function record(user, postingId) {
  if (user?.role !== 'paralegal') throw Object.assign(new Error('Paralegal access required.'), { status: 403 });
  if (!/^[a-f\d]{24}$/i.test(postingId)) throw Object.assign(new Error('Matter not found.'), { status: 404 });
  const viewerId = id(user.id || user._id);
  // Use the same canonical, block-aware visibility as Browse, including aliases.
  let selected;
  for await (const listing of iterateOpenListings(viewerId)) {
    if ([listing.id, listing.caseId, listing.jobId].some(value => id(value).toLowerCase() === postingId.toLowerCase())) { selected = listing; break; }
  }
  if (!selected || id(selected.attorneyId) === viewerId) throw Object.assign(new Error('Matter not found.'), { status: 404 });
  const caseId = selected.caseId || null, jobId = selected.jobId || null;
  const key = `${caseId ? 'case' : 'job'}:${id(caseId || jobId)}:${viewerId}`;
  try {
    await View.updateOne({ _id: key }, { $setOnInsert: { caseId, jobId, viewerId, firstViewedAt: new Date() } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
}
async function summary(matter, user, applications) {
  if (user?.role !== 'attorney' || id(matter.attorneyId || matter.attorney) !== id(user.id || user._id) || !openMatter(matter)) return null;
  const jobs = await Job.find({ caseId: matter._id }).select('_id').lean();
  const jobIds = [...jobs.map(job => job._id), ...(matter.jobId ? [matter.jobId] : [])];
  const viewers = await View.distinct('viewerId', { $or: [{ caseId: matter._id }, ...(jobIds.length ? [{ jobId: { $in: jobIds } }] : [])] });
  return { uniqueParalegals: viewers.length, applications };
}
module.exports = { record, summary };
