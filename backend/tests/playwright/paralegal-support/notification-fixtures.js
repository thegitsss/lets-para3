const assert = require('node:assert/strict');

// Keep synthetic UI identities within their own notification projections. The
// actual notification/session boundary is exercised by the managed-route suites.
async function installNotificationReads(page, { ownerId, getItems = () => [], getStatus = () => 200 }) {
  await page.route(url => /^\/api\/notifications\/(?:page|unread-count|stream)$/.test(url.pathname), async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') return route.fallback();
    if (url.pathname.endsWith('/stream')) return route.fulfill({ status: 204, body: '' });
    assert.equal(url.searchParams.get('expectedOwnerId'), typeof ownerId === 'function' ? ownerId() : ownerId);
    const status = getStatus();
    const send = body => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (status !== 200) return send({ error: 'Synthetic notifications unavailable' });
    const items = getItems(), unread = item => !item.read && !item.isRead;
    if (url.pathname.endsWith('/unread-count')) return send({ count: items.filter(unread).length });
    const rows = url.searchParams.get('unread') === '1' ? items.filter(unread) : items;
    const offset = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit') || 100);
    assert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100);
    const end = offset + limit, hasMore = end < rows.length;
    return send({ items: rows.slice(offset, end), hasMore, nextCursor: hasMore ? String(end) : null });
  });
}
module.exports = { installNotificationReads };
