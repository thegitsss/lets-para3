const {
  addCalendarDays,
  dateOnlyFromZonedInstant,
  dateOnlyToUtcDate,
  formatDateOnly,
  normalizeDateOnly,
  parseMatterDeadline,
  resolveMatterDeadlineDate,
} = require("../utils/businessDate");

describe("Matter business dates", () => {
  test("keeps a calendar deadline independent of the viewer timezone", () => {
    const deadline = "2026-08-20";
    const storedMirror = dateOnlyToUtcDate(deadline);
    expect(storedMirror.toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(resolveMatterDeadlineDate({ deadline: storedMirror })).toBe(deadline);
    expect(resolveMatterDeadlineDate({ deadlineDate: deadline, deadline: storedMirror })).toBe(deadline);
  });

  test("rejects impossible and non-calendar values", () => {
    expect(normalizeDateOnly("2026-02-29")).toBe("");
    expect(normalizeDateOnly("08/20/2026")).toBe("");
    expect(normalizeDateOnly("2026-08-20T23:59:00.000Z")).toBe("2026-08-20");
  });

  test("uses the configured business timezone to define today", () => {
    const instant = new Date("2026-08-20T02:00:00.000Z");
    expect(dateOnlyFromZonedInstant(instant, "America/New_York")).toBe("2026-08-19");
    expect(dateOnlyFromZonedInstant(instant, "Pacific/Honolulu")).toBe("2026-08-19");
    expect(dateOnlyFromZonedInstant(instant, "UTC")).toBe("2026-08-20");
  });

  test("accepts today and applies an inclusive future limit", () => {
    const now = new Date("2026-08-20T16:00:00.000Z");
    expect(parseMatterDeadline("2026-08-20", { now, timeZone: "America/New_York" }))
      .toEqual(expect.objectContaining({ dateOnly: "2026-08-20" }));
    expect(parseMatterDeadline("2026-08-19", { now, timeZone: "America/New_York" })).toBeNull();
    expect(parseMatterDeadline("2027-08-20", { now, timeZone: "America/New_York" }))
      .toEqual(expect.objectContaining({ dateOnly: "2027-08-20" }));
    expect(parseMatterDeadline("2027-08-21", { now, timeZone: "America/New_York" })).toBeNull();
  });

  test("adds calendar days without daylight-saving arithmetic", () => {
    expect(addCalendarDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("formats a calendar date without shifting it across timezones", () => {
    expect(formatDateOnly("2026-08-20")).toBe("Aug 20, 2026");
  });
});
