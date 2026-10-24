const { revisionFor } = require('./matterDraftRevision');

function presentMatterDraft(draft) {
  if (!draft) return null;
  return {
    id: draft._id,
    title: draft.title || 'Untitled Matter',
    rawTitle: draft.title || '',
    revision: revisionFor(draft),
    clientRequestId: draft.clientRequestId || null,
    publishedCaseId: draft.publishedCaseId || null,
    practiceArea: draft.practiceArea || '',
    state: draft.state || '',
    compAmount: draft.compAmount || '',
    experience: draft.experience || '',
    deadline: draft.deadline || '',
    description: draft.description || '',
    sourceDescription: draft.sourceDescription || '',
    appliedSourceDescription: draft.appliedSourceDescription ?? draft.sourceDescription ?? '',
    tasks: Array.isArray(draft.tasks) ? draft.tasks : [],
    pendingRequirement: draft.pendingRequirement || '',
    requirements: Array.isArray(draft.requirements) ? draft.requirements : [],
    status: draft.status || 'draft',
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

module.exports = { presentMatterDraft };
