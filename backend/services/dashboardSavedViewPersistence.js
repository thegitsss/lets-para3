const crypto = require("crypto");
const { Types } = require("mongoose");
const { MAX_VIEWS_PER_SCOPE, normalizeDashboardViewFilters, serializeDashboardSavedView } = require("./dashboardSavedViews");
const revisionFor = (view) => crypto.createHash("sha256").update(JSON.stringify(view)).digest("hex");
const exact = (value) => value === undefined ? { $exists: false } : { $eq: value };
const fail = (status, code) => ({ status, error: code });
const dto = (view) => ({ ...serializeDashboardSavedView(view), revision: revisionFor(view) });
function rawViews(user) {
  const prefs = user.preferences;
  if (prefs !== undefined && (!prefs || typeof prefs !== "object" || Array.isArray(prefs))) return null;
  if (prefs?.dashboardViews !== undefined && !Array.isArray(prefs.dashboardViews)) return null;
  return prefs?.dashboardViews || [];
}
async function mutateSavedView(User, { userId, role, scope, input, viewId, revision, remove = false }) {
  const filter = { _id: new Types.ObjectId(userId), role, status: "approved" };
  const requestedId = input?.id;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const user = await User.collection.findOne(filter);
    if (!user) return fail(403, "SAVED_VIEW_ACCOUNT_CHANGED");
    const views = rawViews(user);
    if (!views) return fail(409, "SAVED_VIEW_STORAGE_INVALID");
    const index = views.findIndex((view) => view?.scope === scope && String(view.id) === String(remove ? viewId : requestedId));
    const existing = views[index];
    const newId = requestedId;
    if (remove && !existing) return fail(404, "SAVED_VIEW_NOT_FOUND");
    if (existing && revision !== revisionFor(existing)) {
      if (!remove && revision === null && existing.name === input.name && JSON.stringify(normalizeDashboardViewFilters(scope, existing.filters)) === JSON.stringify(input.filters)) return { status: 200, view: dto(existing) };
      return fail(409, "SAVED_VIEW_CONFLICT");
    }
    if (!remove && !existing && revision !== null) return fail(404, "SAVED_VIEW_NOT_FOUND");
    if (!remove && !existing && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(newId)) return fail(400, "SAVED_VIEW_ID_REQUIRED");
    if (!remove && views.some((view, i) => i !== index && view?.scope === scope && serializeDashboardSavedView(view).name.toLowerCase() === input.name.toLowerCase())) return fail(409, "SAVED_VIEW_DUPLICATE_NAME");
    if (!remove && !existing && views.filter((view) => view?.scope === scope).length >= MAX_VIEWS_PER_SCOPE) return fail(409, "SAVED_VIEW_LIMIT");
    const now = new Date();
    const saved = remove ? null : {
      ...existing, id: existing?.id || newId, scope, name: input.name,
      filters: { ...(existing?.filters && typeof existing.filters === "object" && !Array.isArray(existing.filters) ? existing.filters : {}), ...input.filters },
      createdAt: existing?.createdAt || now, updatedAt: now,
    };
    const next = [...views];
    if (remove) next.splice(index, 1); else if (existing) next.splice(index, 1, saved); else next.push(saved);
    // Compare only this collection, and write its leaf. Other preferences and raw legacy data survive.
    const result = await User.collection.updateOne({ ...filter, "preferences.dashboardViews": exact(user.preferences?.dashboardViews) }, { $set: { "preferences.dashboardViews": next, updatedAt: now } });
    if (result.matchedCount) return remove ? { status: 200, ok: true } : { status: existing ? 200 : 201, view: dto(saved) };
  }
  return fail(409, "SAVED_VIEW_CONFLICT");
}
module.exports = { revisionFor, dto, rawViews, mutateSavedView };
