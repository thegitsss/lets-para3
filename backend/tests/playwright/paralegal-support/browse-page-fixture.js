// Controlled HTTP peer for UI interactions only. Database/catalog semantics are
// exercised separately through the real discovery routes, without this peer.
function browsePageFixture(listings, params = new URLSearchParams(), viewerId = "64b000000000000000000001") {
  const stateCode = value => ({ "New York": "NY", California: "CA" }[value] || value || "");
  const available = listings.filter(item => !item.appliedAt || item.relistRequestedAt);
  const states = [...new Set(available.map(item => stateCode(item.state)).filter(Boolean))].sort();
  const practices = [...new Set(available.map(item => String(item.practiceArea || "").toLowerCase()).filter(Boolean))].sort();
  const filters = { practice: (params.get("practice") || "").toLowerCase(),
    state: params.has("state") ? stateCode(params.get("state")) : states.includes("NY") ? "NY" : "",
    minPay: Number(params.get("minPay") || 400), deadline: params.get("deadline") || "", posted: params.get("posted") || "",
    sort: params.get("sort") || "newest", page: Number(params.get("page") || 1) };
  const amount = item => (item.remainingAmount ?? item.lockedTotalAmount ?? item.totalAmount ?? Number(item.budget || 0) * 100) / 100;
  const matching = available.filter(item => (!filters.state || stateCode(item.state) === filters.state) &&
    (!filters.practice || String(item.practiceArea || "").toLowerCase() === filters.practice) && amount(item) >= filters.minPay);
  if (filters.sort === "payHigh") matching.sort((a, b) => amount(b) - amount(a));
  if (filters.sort === "payLow") matching.sort((a, b) => amount(a) - amount(b));
  const totalPages = Math.max(1, Math.ceil(matching.length / 12));
  filters.page = Math.min(filters.page, totalPages);
  const selected = available.find(item => [item._id, item.caseId, item.jobId].includes(params.get("matterId"))) || null;
  return { viewerId, items: matching.slice((filters.page - 1) * 12, filters.page * 12), selected,
    total: matching.length, availableTotal: available.length, limit: 12, page: filters.page, totalPages,
    hasMore: filters.page < totalPages, filters, facets: { states, practices } };
}

module.exports = { browsePageFixture };
