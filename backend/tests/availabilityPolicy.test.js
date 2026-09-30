const { parseAvailabilityUpdate, effectiveAvailability, buildEffectiveAvailableClause } = require("../utils/availability");

const options = { now: new Date("2026-08-15T16:00:00.000Z"), timeZone: "America/New_York" };

describe("availability update policy", () => {
  test("a return date changes availability at the business-day boundary, not UTC midnight", () => {
    const user = { availability: "Unavailable until Sep 5", availabilityDetails: { status: "unavailable", nextAvailable: new Date("2026-09-05T00:00:00Z") } };
    expect(effectiveAvailability(user, { now: new Date("2026-09-05T02:00:00Z") }).availabilityDetails.status).toBe("unavailable");
    expect(effectiveAvailability(user, { now: new Date("2026-09-05T04:00:00Z") })).toMatchObject({ availability: "Available now", availabilityDetails: { status: "available", nextAvailable: null } });
    expect(effectiveAvailability({ availability: "Unavailable", availabilityDetails: { status: "unavailable", nextAvailable: null } }, options).availabilityDetails.status).toBe("unavailable");
    expect(effectiveAvailability({ availability: "Available now", availabilityDetails: { status: "unavailable", nextAvailable: null } }, options).availability).toBe("Unavailable");
  });
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

describe("effective availability directory query", () => {
  const User = require("../models/User");
  const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
  beforeAll(connect); beforeEach(clearDatabase); afterAll(closeDatabase);
  test("stored unavailable state no longer excludes a returned paralegal", async () => {
    const user = await User.create({ firstName: "Returning", lastName: "Paralegal", email: "returning@example.com", password: "Password123!", role: "paralegal", status: "approved", availability: "Unavailable until Aug 15", availabilityDetails: { status: "unavailable", nextAvailable: new Date("2026-08-15T00:00:00Z") } });
    const eligible = await User.find({ _id: user._id, ...buildEffectiveAvailableClause(options) }).lean();
    expect(eligible).toHaveLength(1);
    expect(effectiveAvailability(eligible[0], options).availability).toBe("Available now");
  });
});
