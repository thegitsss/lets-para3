const {
  normalizeMinimumYears,
  parseMinimumYears,
  resolveExperienceRequirement,
} = require("../services/experienceRequirement");
const { projectRecommendedMatters } = require("../services/recommendationProjection");

function listing(overrides = {}) {
  return {
    id: overrides.id || "matter-1",
    jobId: overrides.jobId || "job-1",
    title: "Discovery support",
    state: "CA",
    practiceArea: "Commercial Litigation",
    minimumYearsExperience: 3,
    createdAt: "2026-08-31T12:00:00.000Z",
    ...overrides,
  };
}

describe("canonical experience requirement parsing", () => {
  test.each([
    [undefined, 0],
    [null, 0],
    ["", 0],
    [0, 0],
    [-1, 0],
    ["malformed", 0],
    [100, 80],
  ])("normalizes %p to %p years", (value, expected) => {
    expect(normalizeMinimumYears(value)).toBe(expected);
  });

  test.each([
    ["malformed", 0],
    ["Experience: 0", 0],
    ["3.5+ years", 3.5],
    ["Experience: 5 years", 5],
  ])("parses %p as %p years", (value, expected) => {
    expect(parseMinimumYears(value)).toBe(expected);
  });

  test("prefers canonical numeric evidence and retains legacy Experience text parsing", () => {
    expect(resolveExperienceRequirement({ minimumYearsExperience: 5, experiencePreference: "3+ years" }))
      .toEqual({ preference: "3+ years", minimumYears: 5 });
    expect(resolveExperienceRequirement({ briefSummary: "State: CA • Experience: 4.5+ years" }))
      .toEqual({ preference: "", minimumYears: 4.5 });
  });
});

describe("authoritative recommendation projection", () => {
  const profile = {
    state: "California",
    stateExperience: ["NY"],
    practiceAreas: ["Contracts", "Commercial Litigation"],
    yearsExperience: 5,
  };

  test("returns stable match reasons without exposing ranking internals", () => {
    const result = projectRecommendedMatters({
      profile,
      listings: [
        listing({ id: "both", jobId: "job-both" }),
        listing({ id: "state", jobId: "job-state", practiceArea: "Tax" }),
        listing({ id: "practice", jobId: "job-practice", state: "TX", practiceArea: "Contract Law" }),
      ],
    });
    expect(result.hasMatchingProfile).toBe(true);
    expect(result.items.map((item) => [item.id, item.recommendation.reason])).toEqual([
      ["both", "state_and_practice"],
      ["practice", "practice_area"],
      ["state", "state"],
    ]);
    expect(result.items.every((item) => !("_recommendationScore" in item))).toBe(true);
  });

  test("allows an exact experience match and excludes requirements above the profile", () => {
    const result = projectRecommendedMatters({
      profile,
      listings: [
        listing({ id: "exact", jobId: "job-exact", minimumYearsExperience: 5 }),
        listing({ id: "over", jobId: "job-over", minimumYearsExperience: 5.5 }),
      ],
    });
    expect(result.items.map((item) => item.id)).toEqual(["exact"]);
  });

  test("excludes every historical Case or Job identity while leaving Browse input unchanged", () => {
    const listings = [
      listing({ id: "case-old", caseId: "case-old", jobId: "job-new" }),
      listing({ id: "case-new", caseId: "case-new", jobId: "job-old" }),
      listing({ id: "eligible", caseId: "eligible", jobId: "job-eligible" }),
    ];
    const result = projectRecommendedMatters({
      profile,
      listings,
      exclusions: { caseIds: ["case-old"], jobIds: ["job-old"] },
    });
    expect(result.items.map((item) => item.id)).toEqual(["eligible"]);
    expect(listings).toHaveLength(3);
  });

  test("requires a state or practice-area match and reports an incomplete matching profile", () => {
    expect(projectRecommendedMatters({ profile: {}, listings: [listing()] })).toEqual({
      hasMatchingProfile: false,
      items: [],
    });
    expect(projectRecommendedMatters({
      profile,
      listings: [listing({ state: "TX", practiceArea: "Tax" })],
    }).items).toEqual([]);
  });
});
