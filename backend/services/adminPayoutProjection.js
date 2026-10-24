const retained = require('./retainedPayoutProjection');
const account = require('./financialAccountBoundary');
const { fingerprint } = require('./matterDraftRevision');
const validMoney = value => Number.isSafeInteger(value) && value >= 0;
const fail = (status, suffix) => { throw Object.assign(new Error('Payout records could not be verified. Refresh before continuing.'), { status, statusCode: status, code: `ADMIN_PAYOUT_${suffix}`, publicCode: `ADMIN_PAYOUT_${suffix}` }); };
async function snapshot(req, { from = null, now = new Date() } = {}) {
  if (from !== null && (!(from instanceof Date) || !Number.isFinite(from.getTime()))) fail(400, 'INVALID');
  const owner = await account.read(req, 'admin', req.query?.expectedOwnerId);
  const value = await retained.readAll({ now });
  const fresh = await account.read(req, 'admin', req.query?.expectedOwnerId);
  if (fingerprint(owner) !== fingerprint(fresh)) fail(409, 'CHANGED');
  const rows = value.records.filter(row => !from || !row.recordedAt || new Date(row.recordedAt) >= from);
  const recorded = rows.filter(row => row.state === 'recorded' && (!from || row.recordedAt));
  const groups = new Map();
  for (const row of recorded) {
    if (!validMoney(row.amount) || !row.currency) fail(503, 'UNAVAILABLE');
    const key = `${row.currency}:${row.stripeMode}`;
    if (!groups.has(key)) groups.set(key, { currency: row.currency, stripeMode: row.stripeMode, totalRecorded: 0, count: 0 });
    const group = groups.get(key); group.totalRecorded += row.amount; group.count++;
    if (!validMoney(group.totalRecorded)) fail(503, 'TOTAL_TOO_LARGE');
  }
  const currencies = [...groups.values()].sort((a, b) => `${a.currency}:${a.stripeMode}`.localeCompare(`${b.currency}:${b.stripeMode}`));
  // Preserve the original USD scalar only when a single USD/provider-mode total
  // can describe the report. Other units remain available in separate groups.
  const totalAmount = !currencies.length ? 0 : currencies.length === 1 && currencies[0].currency === 'USD' ? currencies[0].totalRecorded : null;
  const states = Object.fromEntries(['recorded', 'needs_review', 'pending', 'failed', 'reversed'].map(state => [state, rows.filter(row => row.state === state).length]));
  return { ownerId: String(owner._id), revision: fingerprint([value.revision, from?.toISOString() || null]), from: from?.toISOString() || null, currencies, totalAmount, count: recorded.length, states, undated: rows.filter(row => !row.recordedAt).length, rows };
}
async function read(req, options = {}) {
  const query = req.query || {}, view = query.view || 'recorded', cursor = query.cursor === undefined ? 0 : Number(query.cursor), limit = query.limit === undefined ? 200 : Number(query.limit);
  if (Object.keys(query).some(key => !['expectedOwnerId', 'view', 'cursor', 'revision', 'limit'].includes(key)) || !['all', 'recorded', 'review', 'pending', 'failed', 'reversed'].includes(view) || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || query.cursor !== undefined && (!/^(0|[1-9]\d*)$/.test(query.cursor) || !/^[a-f0-9]{64}$/.test(query.revision || ''))) fail(400, 'INVALID');
  const value = await snapshot(req, options), revision = fingerprint([value.revision, view]);
  if (query.revision !== undefined && query.revision !== revision) fail(409, 'CHANGED');
  const filtered = value.rows.filter(row => view === 'all' || row.state === (view === 'review' ? 'needs_review' : view)).sort((a, b) => (b.recordedAt ? new Date(b.recordedAt).getTime() : -Infinity) - (a.recordedAt ? new Date(a.recordedAt).getTime() : -Infinity) || b.payoutId.localeCompare(a.payoutId));
  if (cursor > filtered.length) fail(409, 'CHANGED');
  const items = filtered.slice(cursor, cursor + limit), summary = { ...value }; delete summary.rows;
  return { ...summary, revision, view, items, total: filtered.length, nextCursor: cursor + items.length < filtered.length ? String(cursor + items.length) : null };
}
module.exports = { read, snapshot };
