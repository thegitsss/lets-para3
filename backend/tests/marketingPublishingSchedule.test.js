const { computeNextDueAt, cadenceIntervalDays, DEFAULT_SETTINGS } = require('../services/marketing/publishingSettingsService');
const { MARKETING_PUBLISHING_CADENCE_MODES } = require('../services/marketing/constants');
test('weekly preparation is supported without activating any default policy', () => {
 expect(MARKETING_PUBLISHING_CADENCE_MODES).toContain('weekly');
 expect(cadenceIntervalDays('weekly')).toBe(7);
 expect(DEFAULT_SETTINGS.isEnabled).toBe(false);
 expect(computeNextDueAt({cadenceMode:'manual_only'})).toBeNull();
});
test.each([
 ['2026-03-01T14:00:00Z','2026-03-08T13:00:00.000Z'],
 ['2026-10-25T13:00:00Z','2026-11-01T14:00:00.000Z'],
])('weekly preparation retains 9am New York time across daylight saving from %s', (lastDueAt, expected) => {
 expect(computeNextDueAt({cadenceMode:'weekly',timeZone:'America/New_York',preferredHourLocal:9,lastDueAt}).toISOString()).toBe(expected);
});
test('a new weekly schedule uses today before its hour, otherwise the following week', () => {
 expect(computeNextDueAt({cadenceMode:'weekly',now:new Date('2026-09-30T12:00:00Z')}).toISOString()).toBe('2026-09-30T13:00:00.000Z');
 expect(computeNextDueAt({cadenceMode:'weekly',now:new Date('2026-09-30T14:00:00Z')}).toISOString()).toBe('2026-10-07T13:00:00.000Z');
});
test('daily preparation retains the selected hour on a clock-change day', () => {
 expect(computeNextDueAt({cadenceMode:'daily',now:new Date('2026-03-08T05:30:00Z')}).toISOString()).toBe('2026-03-08T13:00:00.000Z');
});

test('midnight is represented as hour zero on the intended local day', () => {
 expect(computeNextDueAt({cadenceMode:'weekly',timeZone:'America/New_York',preferredHourLocal:0,now:new Date('2026-09-30T03:00:00Z')}).toISOString()).toBe('2026-10-06T04:00:00.000Z');
 expect(computeNextDueAt({cadenceMode:'weekly',timeZone:'America/New_York',preferredHourLocal:0,lastDueAt:'2026-09-30T04:00:00Z'}).toISOString()).toBe('2026-10-07T04:00:00.000Z');
});
