// Amounts are retained platform-fee cents from adminFinancialReport, never funding totals.
const calendar = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' });
const monthKey = date => calendar.formatToParts(date).filter(part => ['year', 'month'].includes(part.type)).map(part => `${part.type}:${part.value}`).sort().join('|');
function summarize(rows, now = new Date()) {
  const month = monthKey(now);
  let amount = 0, available = true;
  for (const row of rows) {
    if (row.stripeMode === 'test') continue;
    const date = row.recordedAt ? new Date(row.recordedAt) : null;
    if (!date || !Number.isFinite(date.getTime())) { available = false; continue; }
    if (date > now || monthKey(date) !== month) continue;
    if (row.stripeMode !== 'live' || row.currency !== 'USD' || row.state !== 'recorded' || row.basis !== 'retained_platform_fee' || !Number.isSafeInteger(row.amount) || row.amount < 0) { available = false; continue; }
    amount += row.amount;
    if (!Number.isSafeInteger(amount)) available = false;
  }
  return { amount: available ? amount : null, available, currency: 'USD', stripeMode: 'live', period: 'month', timeZone: 'America/New_York', checkedAt: now.toISOString() };
}
module.exports = { summarize };
