import { draftValues } from '../matter-draft-contract.mjs';

// Copy editable scope only. A new Matter gets its own identity and review.
export function repeatMatterValues(source, ownerId, sourceId) {
  if (!/^[a-f\d]{24}$/i.test(sourceId || '') || String(source?.id || source?._id || '') !== sourceId || source?.matterExperience?.header?.relationship !== 'Matter owner') throw new Error('The previous Matter could not be verified.');
  const owner = source.attorneyId || source.attorney;
  if (owner && String(owner?._id || owner?.id || owner) !== ownerId) throw new Error('The previous Matter belongs to another account.');
  if (!['completed', 'closed'].includes(String(source.status || '').toLowerCase())) throw new Error('Start a similar Matter from a completed or closed engagement.');
  const cents = source.lockedTotalAmount ?? source.totalAmount;
  return draftValues({
    title: source.title,
    description: String(source.details || source.matterExperience.overview?.summary || '').split(/\n\s*Screening questions:/i)[0],
    practiceArea: source.practiceArea,
    state: source.locationState || source.state,
    compAmount: Number.isSafeInteger(cents) && cents >= 40000 && source.currency === 'usd' ? String(cents / 100) : '',
    tasks: (source.tasks || []).map(task => ({ title: task.title || task.name || '' })),
    deadline: '',
  });
}
