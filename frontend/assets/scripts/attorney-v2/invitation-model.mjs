import { candidateHref } from "./candidate-model.mjs";
const id = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const date = value => value === null || (typeof value === "string" && Number.isFinite(new Date(value).getTime()));
const statuses = { pending: "Awaiting response", accepted: "Accepted invitation", declined: "Declined invitation", expired: "Invitation expired", unknown: "Invitation status unavailable" };

export function readInvitations(value, caseId, ownerId) {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (value?.caseId !== caseId || typeof value.caseTitle !== "string" || typeof value.complete !== "boolean" || !Array.isArray(value.invites)) throw new Error("invalid_invitations");
  return { caseId, ownerId, caseTitle: value.caseTitle, complete: value.complete, invites: value.invites.map(item => {
    const profile = item?.paralegal;
    if (!id(profile?.id) || typeof profile.name !== "string" || typeof profile.available !== "boolean" || !Object.hasOwn(statuses, item.status) || !date(item.invitedAt) || !date(item.respondedAt)) throw new Error("invalid_invitation");
    return { paralegal: { id: profile.id, name: profile.name || "Invited paralegal", available: profile.available, profileImage: typeof profile.profileImage === "string" ? profile.profileImage : null }, status: item.status, invitedAt: item.invitedAt, respondedAt: item.respondedAt };
  }) };
}
export const invitationStatus = value => statuses[value] || statuses.unknown;
export function invitationProfileHref(invite, caseId, current = false, returnContext = "") {
  if (!invite.paralegal.available || !id(invite.paralegal.id) || !id(caseId)) return null;
  if (current) return `/profile-paralegal.html?${new URLSearchParams({ paralegalId: invite.paralegal.id, caseId, returnTo: "/dashboard-attorney.html#cases" })}`;
  return candidateHref(invite.paralegal.id, new URLSearchParams({ caseId, returnTo: returnContext || `#/matters/${caseId}/invitations` }));
}

export function invitationFilters(query = new URLSearchParams()) {
  const keys = ["invPage", "invSort", "invStatus", "invSearch"], page = query.get("invPage") || "1", sort = query.get("invSort") || "newest", status = query.get("invStatus") || "all", rawSearch = query.get("invSearch") || "";
  if (keys.some(key => query.getAll(key).length > 1) || !/^[1-9]\d{0,6}$/.test(page) || Number(page) > 1000000 || !["newest", "oldest", "name"].includes(sort) || !["all", ...Object.keys(statuses)].includes(status) || rawSearch.length > 200 || /[\x00-\x1f\x7f]/.test(rawSearch)) throw new Error("invalid_invitation_filters");
  return { page: Number(page), sort, status, search: rawSearch.trim() };
}
export function invitationQuery(filters, previous = new URLSearchParams()) {
  const query = new URLSearchParams(previous);
  ["invPage", "invSort", "invStatus", "invSearch"].forEach(key => query.delete(key));
  if (filters.page !== 1) query.set("invPage", String(filters.page));
  if (filters.sort !== "newest") query.set("invSort", filters.sort);
  if (filters.status !== "all") query.set("invStatus", filters.status);
  if (filters.search) query.set("invSearch", filters.search);
  invitationFilters(query); return query;
}
export function invitationInventory(value, filters) {
  const counts = Object.fromEntries(Object.keys(statuses).map(key => [key, value.invites.filter(item => item.status === key).length]));
  const items = value.invites.map((item, index) => ({ ...item, index })).filter(item => (filters.status === "all" || item.status === filters.status) && item.paralegal.name.toLocaleLowerCase().includes(filters.search.toLocaleLowerCase()));
  const names = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  items.sort((a, b) => {
    if (filters.sort === "name") return names.compare(a.paralegal.name, b.paralegal.name) || a.index - b.index;
    if (a.invitedAt === null || b.invitedAt === null) return Number(a.invitedAt === null) - Number(b.invitedAt === null) || a.index - b.index;
    return (Date.parse(a.invitedAt) - Date.parse(b.invitedAt)) * (filters.sort === "oldest" ? 1 : -1) || a.index - b.index;
  });
  return { ...value, counts, total: items.length, page: filters.page, pages: Math.max(1, Math.ceil(items.length / 25)), invites: items.slice((filters.page - 1) * 25, filters.page * 25) };
}
