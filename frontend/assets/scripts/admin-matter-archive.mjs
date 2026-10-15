import { readArchive, confirmsArchive, archiveEffect, archiveReason } from "./attorney-v2/archive-model.mjs";

// Preserve the existing admin post action using the reviewed archive contract.
// No retry is safe when a mutation response is missing or unrecognizable.
export async function archiveAdminPost(caseId, { confirmAction, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  if (!/^[a-f0-9]{24}$/i.test(caseId || "")) throw new Error("This post is unavailable.");
  async function request(path, options = {}) {
    const response = await fetchImpl(path, { credentials: "include", cache: "no-store", redirect: "error", ...options });
    const body = await response.json();
    if (!response.ok) throw new Error("The post could not be verified. Refresh it before continuing.");
    return body;
  }
  async function identity() {
    const payload = await request("/api/auth/me"), user = payload.user || payload, id = String(user.id || user._id || "");
    if (user.role !== "admin" || !/^[a-f0-9]{24}$/i.test(id)) throw new Error("Your admin account could not be verified.");
    return id;
  }
  const ownerId = await identity(), path = `/api/cases/${caseId}/archive`;
  const value = readArchive(await request(`${path}?expectedOwnerId=${ownerId}`), caseId, ownerId);
  if (value.archived) return { state: "already_archived" };
  if (!value.canChange) throw new Error(archiveReason(value));
  if (!await confirmAction(`${value.caseTitle}. ${archiveEffect(value)}`, { title: "Archive this post?", confirmLabel: "Archive post", tone: "danger" })) return null;
  if (await identity() !== ownerId) throw new Error("The signed-in account changed. Refresh before continuing.");
  const csrf = await request("/api/csrf");
  if (typeof csrf.csrfToken !== "string" || !csrf.csrfToken) throw new Error("The post could not be verified. Refresh it before continuing.");
  const sent = { expectedOwnerId: ownerId, revision: value.revision, archived: true, requestId: crypto.randomUUID() };
  try {
    const result = await request(path, { method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken }, body: JSON.stringify(sent) });
    if (result.ok !== true || !confirmsArchive(readArchive(result.archive, caseId, ownerId), sent)) throw new Error("unconfirmed_archive");
    return { state: "recorded" };
  } catch {
    throw new Error("The archive result was not confirmed. Refresh the post and check its current archive status before trying again.");
  }
}
