const { fingerprint } = require('./matterDraftRevision');
const money = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => { throw Object.assign(new Error('Payout totals could not be verified.'), { statusCode: 503, code: 'PAYOUT_PROJECTION_INVALID' }); };

function project(value, now) {
  const asOf = now.toISOString(), monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), last30Start = new Date(now.getTime() - 30 * 86400000);
  const states = Object.fromEntries(['recorded', 'needs_review', 'pending', 'failed', 'reversed'].map(state => [state, 0])), groups = new Map();
  let undated = 0;
  for (const row of value.records) {
    if (!Object.hasOwn(states, row.state)) fail();
    states[row.state]++;
    if (row.state !== 'recorded') continue;
    if (!row.currency || !['test', 'live'].includes(row.stripeMode) || !money(row.amount)) fail();
    const key = `${row.currency}:${row.stripeMode}`;
    if (!groups.has(key)) groups.set(key, { currency: row.currency, stripeMode: row.stripeMode, month: 0, last30: 0, total: 0, count: 0, undated: 0 });
    const group = groups.get(key); group.count++; group.total += row.amount;
    if (row.recordedAt) {
      const at = new Date(row.recordedAt);
      if (at >= monthStart && at <= now) group.month += row.amount;
      if (at >= last30Start && at <= now) group.last30 += row.amount;
    } else { group.undated++; undated++; }
    if (![group.month, group.last30, group.total].every(money)) fail();
  }
  const currencies = [...groups.values()].sort((a, b) => `${a.currency}:${a.stripeMode}`.localeCompare(`${b.currency}:${b.stripeMode}`)).map(group => ({ ...group, month: group.undated ? null : group.month, last30: group.undated ? null : group.last30 }));
  return { revision: fingerprint([value.revision, asOf]), asOf, monthStart: monthStart.toISOString(), last30Start: last30Start.toISOString(), currencies, states, count: states.recorded, requiresReview: states.needs_review, undated };
}
module.exports = { project };
