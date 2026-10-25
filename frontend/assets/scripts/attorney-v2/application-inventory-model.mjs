import { readApplications } from "./application-model.mjs";

export const APPLICATION_STATUSES = ["submitted", "viewed", "shortlisted", "accepted", "rejected", "withdrawn", "unknown"];
export const APPLICATION_SORTS = ["newest", "oldest", "name", "starred"];
const keys = ["appPage", "appSort", "appStatus", "appSearch", "applicantId"];
const fail = () => { throw new Error("invalid_application_inventory"); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function applicationFilters(query = new URLSearchParams()) {
  if (keys.some(key => query.getAll(key).length > 1)) fail();
  const page = query.get("appPage") || "1", sort = query.get("appSort") || "newest", status = query.get("appStatus") || "all", rawSearch = query.get("appSearch") || "", applicantId = (query.get("applicantId") || "").toLowerCase();
  if (!/^[1-9]\d{0,6}$/.test(page) || Number(page) > 1000000 || !APPLICATION_SORTS.includes(sort) || !["all", ...APPLICATION_STATUSES].includes(status) || rawSearch.length > 200 || /[\x00-\x1f\x7f]/.test(rawSearch) || applicantId && !/^[a-f0-9]{24}$/.test(applicantId)) fail();
  return { page: Number(page), sort, status, search: rawSearch.trim(), applicantId };
}
export function applicationQuery(filters, previous = new URLSearchParams()) {
  const query = new URLSearchParams(previous);
  keys.forEach(key => query.delete(key));
  if (filters.page !== 1) query.set("appPage", String(filters.page));
  if (filters.sort !== "newest") query.set("appSort", filters.sort);
  if (filters.status !== "all") query.set("appStatus", filters.status);
  if (filters.search) query.set("appSearch", filters.search);
  if (filters.applicantId) query.set("applicantId", filters.applicantId);
  applicationFilters(query);
  return query;
}
export function readApplicationInventory(value, caseId, ownerId, filters) {
  const records = readApplications({ ...value, cursor: "", next: null }, caseId, ownerId, "", filters.applicantId);
  const page = filters.applicantId ? 1 : filters.page;
  if (!value.filters || Object.keys(filters).some(key => value.filters[key] !== filters[key]) || value.page !== page || value.pageSize !== 25 || !integer(value.total) || value.pages !== Math.max(1, Math.ceil(value.total / 25)) || typeof value.complete !== "boolean" || value.complete !== !records.warnings.length || !/^[a-f0-9]{64}$/.test(value.revision || "") || !value.counts || APPLICATION_STATUSES.some(key => !integer(value.counts[key])) || Object.keys(value.counts).some(key => !APPLICATION_STATUSES.includes(key))) fail();
  const count = APPLICATION_STATUSES.reduce((sum, key) => sum + value.counts[key], 0);
  if (!integer(count) || value.total > count || filters.applicantId && value.total > 1 || !filters.applicantId && !filters.search && value.total !== (filters.status === "all" ? count : value.counts[filters.status]) || records.applications.length !== Math.min(25, Math.max(0, value.total - (page - 1) * 25))) fail();
  for (const key of APPLICATION_STATUSES) if (records.applications.filter(item => item.status === key).length > value.counts[key]) fail();
  if (!filters.applicantId && filters.status !== "all" && records.applications.some(item => item.status !== filters.status)) fail();
  return { ...records, filters: { ...filters }, counts: { ...value.counts }, total: value.total, page, pages: value.pages, complete: value.complete, revision: value.revision };
}
