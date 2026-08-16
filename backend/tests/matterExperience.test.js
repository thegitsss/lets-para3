const { buildMatterExperience } = require("../services/matterExperience");

const ids = {
  attorney: "64b000000000000000000001",
  assigned: "64b000000000000000000002",
  applicant: "64b000000000000000000003",
  other: "64b000000000000000000004",
  matter: "64b000000000000000000005",
};

function baseMatter(overrides = {}) {
  return {
    _id: ids.matter,
    title: "Discovery response Matter",
    details: "Prepare discovery responses.\nScreening questions:\nPrivate prompt",
    practiceArea: "Civil Litigation",
    locationState: "NY",
    status: "in progress",
    currency: "usd",
    totalAmount: 100000,
    lockedTotalAmount: 100000,
    feeAttorneyAmount: 22000,
    feeParalegalAmount: 12000,
    escrowStatus: "funded",
    escrowIntentId: "pi_private_provider_id",
    attorney: { _id: ids.attorney, firstName: "Avery", lastName: "Counsel" },
    paralegal: { _id: ids.assigned, firstName: "Parker", lastName: "Assigned" },
    tasks: [
      { title: "Draft responses", completed: true },
      { title: "Prepare exhibits", completed: false },
    ],
    applicants: [],
    files: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    hiredAt: new Date("2026-01-03T00:00:00.000Z"),
    ...overrides,
  };
}

describe("Matter experience presenter", () => {
  test("gives the owner all seven safe sections without provider or opposing fee data", () => {
    const applicants = [{
      paralegalId: ids.applicant,
      paralegal: { firstName: "Taylor", lastName: "Candidate", email: "private@example.com" },
      status: "pending",
      appliedAt: new Date("2026-01-02T00:00:00.000Z"),
      coverLetter: "private cover letter",
      resumeURL: "https://private.example/resume.pdf",
    }];
    const result = buildMatterExperience(baseMatter({
      applicants,
      invites: [{
        paralegalId: { _id: ids.other, firstName: "Indigo", lastName: "Invitee" },
        status: "pending",
        invitedAt: new Date("2026-01-02T12:00:00.000Z"),
      }],
    }), {
      viewer: { id: ids.attorney, role: "attorney" },
      acl: { isAttorney: true },
      applicants,
      policies: { completion: { ready: false } },
    });

    expect(result.sections.map((section) => section.id)).toEqual([
      "overview", "applications", "work", "files", "messages", "activity", "financials",
    ]);
    expect(result.header.primaryAction).toEqual({
      code: "review_task",
      label: "Review work",
      detail: "Prepare exhibits",
      tab: "work",
    });
    expect(result.header.attention).toBeNull();
    expect(result.overview.paralegalId).toBe(ids.assigned);
    expect(result.applications.items[0]).toEqual(expect.objectContaining({ name: "Taylor Candidate", status: "pending" }));
    expect(result.applications.items[1]).toEqual(expect.objectContaining({ name: "Indigo Invitee", status: "invited" }));
    expect(result.financials.amounts.map((item) => item.code)).toEqual(["compensation", "attorney_fee"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/pi_private|escrowIntent|private@example|cover letter|resume/i);
    expect(result.overview.summary).toBe("Prepare discovery responses.");
  });

  test("assigned paralegal gets the workspace but never the candidate list or attorney fee", () => {
    const applicants = [{
      paralegalId: ids.other,
      paralegal: { firstName: "Other", lastName: "Candidate" },
      status: "pending",
      appliedAt: new Date("2026-01-02T00:00:00.000Z"),
    }];
    const result = buildMatterExperience(baseMatter({ applicants }), {
      viewer: { id: ids.assigned, role: "paralegal" },
      acl: { isParalegal: true },
      applicants: [],
    });

    expect(result.sections.map((section) => section.id)).toEqual([
      "overview", "work", "files", "messages", "activity", "financials",
    ]);
    expect(result.applications).toBeNull();
    expect(result.financials.amounts.map((item) => item.code)).toEqual(["compensation", "paralegal_fee"]);
    expect(JSON.stringify(result)).not.toMatch(/Other Candidate|attorney_fee|22000/);
  });

  test("candidate and invitee views stay self-only and omit post-hire workspace facts", () => {
    const applicant = {
      paralegalId: ids.applicant,
      status: "pending",
      appliedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const candidate = buildMatterExperience(baseMatter({ applicants: [applicant] }), {
      viewer: { id: ids.applicant, role: "paralegal" },
      acl: { isApplicant: true },
      applicants: [applicant],
    });
    expect(candidate.sections.map((section) => section.id)).toEqual(["overview", "applications", "activity"]);
    expect(candidate.overview.paralegal).toBe("");
    expect(candidate.overview.hiredAt).toBeNull();
    expect(candidate.overview.taskProgress).toEqual({ completed: 0, total: 0 });
    expect(candidate.activity.map((item) => item.code)).toEqual(expect.arrayContaining(["posted", "application"]));
    expect(candidate.activity.map((item) => item.code)).not.toEqual(expect.arrayContaining(["started", "payout", "file"]));

    const invitee = buildMatterExperience(baseMatter({
      status: "open",
      paralegal: null,
      tasks: [],
      pendingParalegalId: ids.applicant,
      pendingParalegalInvitedAt: new Date("2026-01-02T00:00:00.000Z"),
      invites: [{ paralegalId: ids.applicant, status: "pending", invitedAt: new Date("2026-01-02T00:00:00.000Z") }],
    }), {
      viewer: { id: ids.applicant, role: "paralegal" },
      acl: {},
      applicants: [],
    });
    expect(invitee.sections.map((section) => section.id)).toEqual(["overview", "applications"]);
    expect(invitee.applications.items).toEqual([expect.objectContaining({ name: "Your invitation", status: "invited" })]);
  });

  test("admin gets only Overview and allowlisted Activity", () => {
    const result = buildMatterExperience(baseMatter(), {
      viewer: { id: ids.other, role: "admin" },
      acl: { isAdmin: true },
      applicants: [],
    });
    expect(result.sections.map((section) => section.id)).toEqual(["overview", "activity"]);
    expect(result.financials).toBeNull();
    expect(result.work).toBeNull();
  });
});
