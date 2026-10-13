function eventPage(ownerId, value, params) {
  const page = Number(params.get("page") || 1), limit = Number(params.get("limit") || 100);
  const from = Date.parse(params.get("from")), to = Date.parse(params.get("to")), type = params.get("type");
  const items = (Array.isArray(value) ? value : value.items || []).filter(item =>
    (!type || item.type === type) && (!Number.isFinite(from) || Date.parse(item.start) >= from) && (!Number.isFinite(to) || Date.parse(item.start) <= to)
  ).map(item => ({ ...item, id: item.id || item._id })).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || String(a.id).localeCompare(String(b.id)));
  return { ownerId, page, limit, total: items.length, pages: Math.ceil(items.length / limit), items: items.slice((page - 1) * limit, page * limit) };
}
module.exports = { eventPage };
