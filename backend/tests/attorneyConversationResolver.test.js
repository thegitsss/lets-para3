const mongoose = require("mongoose");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_attorney_conversation_resolver";

const Case = require("../models/Case");
const { resolveSupportCaseEntity } = require("../services/support/contextResolverService");

function queryResult(value) {
  return {
    select: () => ({
      sort: () => ({
        limit: () => ({ lean: async () => value }),
      }),
      lean: async () => value,
    }),
  };
}

describe("attorney manager matter reference resolution", () => {
  afterEach(() => jest.restoreAllMocks());

  test("a newly named matter replaces stale active memory", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    const smithId = new mongoose.Types.ObjectId();
    const jonesId = new mongoose.Types.ObjectId();
    jest.spyOn(Case, "find").mockReturnValue(queryResult([
      { _id: smithId, title: "Smith intake", attorneyId, updatedAt: new Date("2026-01-01") },
      { _id: jonesId, title: "Jones employment", attorneyId, updatedAt: new Date("2026-02-01") },
    ]));
    const result = await resolveSupportCaseEntity({
      user: { _id: attorneyId, role: "attorney" },
      message: "Jones employment matter",
      previousState: {
        activeEntity: { type: "case", id: String(smithId), name: "Smith intake" },
        authoritativeManager: true,
      },
      task: "FACT_LOOKUP",
    });
    expect(result).toEqual(expect.objectContaining({
      caseId: String(jonesId),
      source: "case_name_match",
    }));
  });

  test("similarly named owned matters return ambiguity instead of a recent guess", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    jest.spyOn(Case, "find").mockReturnValue(queryResult([
      { _id: new mongoose.Types.ObjectId(), title: "Smith intake", attorneyId, updatedAt: new Date("2026-01-01") },
      { _id: new mongoose.Types.ObjectId(), title: "Smith appeal", attorneyId, updatedAt: new Date("2026-02-01") },
    ]));
    const result = await resolveSupportCaseEntity({
      user: { _id: attorneyId, role: "attorney" },
      message: "Smith matter",
      previousState: { authoritativeManager: true },
      task: "FACT_LOOKUP",
    });
    expect(result.caseId).toBe("");
    expect(result.reason).toBe("case_reference_ambiguous");
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(
      expect.arrayContaining(["Smith intake", "Smith appeal"])
    );
  });

  test("a pronoun follow-up rechecks ownership of verified active memory", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    const caseId = new mongoose.Types.ObjectId();
    jest.spyOn(Case, "findById").mockReturnValue(queryResult({
      _id: caseId,
      title: "Smith intake",
      attorneyId,
    }));
    const result = await resolveSupportCaseEntity({
      user: { _id: attorneyId, role: "attorney" },
      message: "that",
      previousState: {
        activeEntity: { type: "case", id: String(caseId), name: "Smith intake" },
        authoritativeManager: true,
      },
      task: "FACT_LOOKUP",
    });
    expect(result).toEqual(expect.objectContaining({ caseId: String(caseId), source: "memory" }));
    expect(Case.findById).toHaveBeenCalledWith(String(caseId));
  });

  test("authoritative manager mode does not infer a recent matter when the reference fails", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    jest.spyOn(Case, "find").mockReturnValue(queryResult([]));
    const result = await resolveSupportCaseEntity({
      user: { _id: attorneyId, role: "attorney" },
      message: "A matter that does not exist",
      previousState: { authoritativeManager: true },
      task: "FACT_LOOKUP",
    });
    expect(result).toEqual(expect.objectContaining({ caseId: null, caseDoc: null, source: "" }));
    expect(Case.find).toHaveBeenCalledTimes(1);
  });
});
