import { dateOnly, newYorkDateOnly } from "./home-model.mjs";

const id = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new Error("The reminder list could not be verified. Try again."); };

export async function loadHomeDeadlines(api, ownerId, range, { signal, isCurrent = () => true } = {}) {
  const current = () => { if (signal?.aborted || !isCurrent()) throw new DOMException("View changed", "AbortError"); };
  current();
  if (!id(ownerId) || dateOnly(range?.start) !== range?.start || dateOnly(range?.end) !== range?.end || range.start >= range.end) invalid();
  // Include all-day UTC dates and timed New York dates, then trim the extra
  // boundary day using the same calendar-date projection as Home.
  const query = new URLSearchParams({ expectedOwnerId: ownerId, type: "deadline", from: `${range.start}T00:00:00.000Z`, to: `${range.end}T23:59:59.999Z`, limit: "200" });
  const items = [], seen = new Set();
  let total = null, pages = null, previous = "";
  for (let page = 1; pages === null || page <= pages; page++) {
    current(); query.set("page", String(page));
    const value = await api.get(`/api/events?${query}`, { signal }); current();
    if (value?.ownerId !== ownerId || value.page !== page || value.limit !== 200 || !integer(value.total)
      || value.pages !== Math.ceil(value.total / 200) || !Array.isArray(value.items)
      || value.items.length !== Math.min(200, Math.max(0, value.total - (page - 1) * 200))
      || total !== null && value.total !== total || pages !== null && value.pages !== pages) invalid();
    total = value.total; pages = value.pages;
    for (const item of value.items) {
      const itemId = item?.id || item?._id, timestamp = Date.parse(item?.start);
      if (!id(itemId) || String(item.owner || "") !== ownerId || item.type !== "deadline" || seen.has(itemId) || !Number.isFinite(timestamp)) invalid();
      const order = `${new Date(timestamp).toISOString()}:${itemId}`;
      if (previous && order < previous) invalid();
      previous = order; seen.add(itemId); items.push(item);
    }
  }
  if (items.length !== total) invalid();
  const visible = items.filter(item => {
    const day = item.isAllDay === false ? newYorkDateOnly(item.start) : dateOnly(item.start);
    return day >= range.start && day < range.end;
  });
  return { ownerId, range: { start: range.start, end: range.end }, items: visible, total: visible.length, recordsRead: total, pagesRead: pages };
}
