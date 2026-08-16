const { parseAvailabilityUpdate } = require("../utils/availability");

const options = { now: new Date("2026-08-15T16:00:00.000Z"), timeZone: "America/New_York" };

describe("availability update policy", () => {
  test("accepts available only without a return date", () => {
    expect(parseAvailabilityUpdate({ status: "available", nextAvailable: null }, options)).toEqual({
      status: "available",
      nextAvailableDate: "",
      nextAvailable: null,
    });
    expect(parseAvailabilityUpdate({ status: "available", nextAvailable: "2026-08-20" }, options).error).toMatch(
      /must be empty/
    );
  });

  test("accepts indefinite or future unavailability", () => {
    expect(parseAvailabilityUpdate({ status: "unavailable" }, options)).toEqual({
      status: "unavailable",
      nextAvailableDate: "",
      nextAvailable: null,
    });
    const future = parseAvailabilityUpdate(
      { status: "unavailable", nextAvailable: "2026-08-20" },
      options
    );
    expect(future.nextAvailableDate).toBe("2026-08-20");
    expect(future.nextAvailable.toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });

  test("rejects unknown statuses and invalid or past dates", () => {
    expect(parseAvailabilityUpdate({ status: "busy" }, options).error).toMatch(/available or unavailable/);
    expect(parseAvailabilityUpdate({ status: "unavailable", nextAvailable: "2026-02-30" }, options).error).toMatch(
      /valid calendar date/
    );
    expect(parseAvailabilityUpdate({ status: "unavailable", nextAvailable: "2026-08-14" }, options).error).toMatch(
      /past/
    );
  });
});
