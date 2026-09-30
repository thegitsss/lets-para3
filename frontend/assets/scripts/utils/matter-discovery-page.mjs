function listingId(value) { return value?.caseId || value?.id || value?._id || value?.jobId || ""; }

export function readMatterDiscoveryPage(value, { pageSize = 12 } = {}) {
  const integer = number => Number.isSafeInteger(number) && number >= 0;
  const stringList = list => Array.isArray(list) && list.every(item => typeof item === "string");
  const filters = value?.filters;
  const validFilters = filters && typeof filters.practice === "string" && typeof filters.state === "string" &&
    Number.isFinite(filters.minPay) && filters.minPay >= 0 &&
    ["newest", "deadline", "payHigh", "payLow"].includes(filters.sort) &&
    ["", "7_days", "30_days", "none"].includes(filters.deadline) && ["", "7_days", "30_days"].includes(filters.posted) &&
    filters.page === value.page;
  if (!value || !Array.isArray(value.items) || !integer(value.total) || !integer(value.availableTotal) ||
      !integer(value.page) || value.page < 1 || value.limit !== pageSize || value.items.length > pageSize ||
      value.total < value.items.length || value.availableTotal < value.total ||
      value.totalPages !== Math.max(1, Math.ceil(value.total / pageSize)) || value.page > value.totalPages ||
      !/^[a-f\d]{24}$/i.test(value.viewerId || "") || !validFilters ||
      value.items.length !== Math.min(pageSize, Math.max(0, value.total - (value.page - 1) * pageSize)) ||
      !stringList(value.facets?.states) || !stringList(value.facets?.practices) ||
      value.items.some(item => !/^[a-f\d]{24}$/i.test(listingId(item))) ||
      (value.selected !== null && !/^[a-f\d]{24}$/i.test(listingId(value.selected)))) {
    throw new Error("The Matter results could not be verified.");
  }
  return Object.freeze({ listings: value.items, selected: value.selected, total: value.total, availableTotal: value.availableTotal,
    page: value.page, totalPages: value.totalPages, filters: value.filters, facets: value.facets, profile: { _id: value.viewerId } });
}
