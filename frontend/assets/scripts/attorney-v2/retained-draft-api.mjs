import { readPosting, postingChanges } from './posting-editor.mjs';

// Keep the existing draft editor/recovery/publication behavior while saving the
// older Case record in place. This adapter never creates a replacement draft.
export function retainedDraftApi(api, state) {
  const present = payload => {
    const posting = readPosting(payload, state.id);
    const limits = { title: 300, practiceArea: 200, state: 200, compAmount: 100, experience: 200, deadline: 50, description: 100000 };
    const exceedsEditor = Object.entries(limits).some(([key, limit]) => posting.values[key].length > limit) || posting.values.tasks.some(task => task.title.length > 200);
    // Never let the normalizer silently clip an older stored requirement.
    if (!posting.isDraft || !posting.permissions.canEdit || exceedsEditor) throw Object.assign(new Error('retained_draft_unavailable'), { status: 409, code: "DRAFT_RETAINED_REVIEW_REQUIRED" });
    state.canDelete = posting.permissions.canDelete;
    return { draft: { id: posting.id, revision: posting.revision, rawTitle: posting.values.title, ...posting.values } };
  };
  return {
    ...api,
    async get(path, options) {
      if (path === `/api/case-drafts/${state.id}`) return present(await api.get(`/api/cases/posting/${state.id}?source=case`, options));
      if (path === `/api/cases/posting/drafts/${state.id}`) path += '?source=case';
      return api.get(path, options);
    },
    saveMatterDraft: async (id, values, revision, options) => present(await api.saveMatterPosting(id, {...postingChanges(state.base, values), ...(JSON.stringify(state.base.requirements || []) !== JSON.stringify(values.requirements || []) ? {requirements: values.requirements || []} : {})}, revision, options)),
    deleteMatterDraft: async (id, revision, options) => {
      const result = await api.deleteMatterPosting(id, revision, options);
      if (result?.ok !== true) throw new Error('invalid_delete');
      return { success: true };
    },
    publishMatter: (review, options) => api.publishMatter({ ...review, source: 'case' }, options),
    createMatterDraft: async () => { throw new Error('A retained Matter must not be recreated.'); },
  };
}
